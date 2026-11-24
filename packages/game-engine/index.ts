import { attackSign, COURT, TICK_RATE } from '../contracts/index.ts';
import type { Control, Engine, GameConfig, GameEvent, GamePlayer, GameState, Player, Side, Team, Vec2, Vec3 } from '../contracts/index.ts';
import { advanceBall, BALL_RADIUS, GRAVITY, RIM_CLEARANCE, vector as at, velocityFor } from './ball.ts';
import type { PhysicalBall } from './ball.ts';

const DT = 1 / TICK_RATE;
export const IDEAL_RELEASE = 0.62;
export const MAX_CHARGE = 1.2;
const LIMIT_X = COURT.length / 2 - 0.32;
const LIMIT_Z = COURT.width / 2 - 0.32;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const opposite = (s: Side): Side => s === 0 ? 1 : 0;
type ShotStyle = NonNullable<Control['shotType']>;
type BaseFlight = { from: string; age: number };
type ShotFlight = BaseFlight & { kind: 'shot'; points: number; throughRim?: boolean };
type PassFlight = BaseFlight & { kind: 'pass'; target: string; duration: number; bounce: boolean; lob: boolean; floorTime?: number };
type Flight = ShotFlight | PassFlight;
type LegacyFlight = BaseFlight & { kind?: undefined; points: number; target?: string; duration: number; bounce: boolean };
type Gather = { ownerId: string; height: number; handOffset: number; approach: number; sprint: boolean; backward: boolean; style?: ShotStyle };
type Dribble = {
  ownerId: string; hand: -1 | 1; phase: number; lastTick: number; held: boolean;
  crossover?: { traveled: number; floorAt: number };
};
type Runtime = {
  free?: { shooter: string; remaining: number; startTick: number; waiting: boolean };
  resumeClock?: number; timeouts?: [number, number]; crossed?: boolean; backcourtTicks?: number;
  seed: number; flight: Flight | null; lastPass: { from: string; to: string; tick: number } | null;
  locks: Record<string, number>; deadUntil: number; inbound: Side; rimTouched: boolean;
  pendingRebound?: boolean; deadBallMotion?: boolean; dribble?: Dribble; gather?: Gather;
  release?: { playerId: string; until: number };
};
type Snapshot = GameState & { ball: PhysicalBall; simulation: Runtime };
const shape: Vec2[] = [{ x: -4, z: 0 }, { x: 4, z: -5.8 }, { x: 5, z: 5.8 }, { x: 8.5, z: -3 }, { x: 10.3, z: 2.1 }];

export function createEngine(teams: [Team, Team], config: GameConfig = {}, initialState?: GameState): Engine {
  const settings = { mode: 'regulation', periods: 4, periodSeconds: 300, playersPerTeam: 5, seed: 17, ...initialState?.config, ...config } satisfies GameConfig;
  const half = settings.halfCourt ?? settings.mode === 'blacktop';
  const sign = (side: Side) => half ? 1 : attackSign(side);
  const runtime: Runtime = { seed: settings.seed >>> 0, flight: null, lastPass: null, locks: {}, deadUntil: 0, inbound: 0, rimTouched: false };
  const state: Snapshot = initialState ? Object.assign({ simulation: runtime }, structuredClone(initialState), { config: settings }) :
    { teams, config: settings, tick: 0, period: 1, clock: settings.periodSeconds, shotClock: 24, phase: 'live', score: [0, 0], possession: 0,
      players: [], ball: { position: at(0, 1, 0), velocity: at(0, 0, 0), kind: 'held', ownerId: null }, charge: {}, events: [], simulation: runtime };
  const sim = state.simulation;
  const initialFlight = sim.flight as Flight | LegacyFlight | null;
  if (initialFlight && initialFlight.kind === undefined) {
    const { from, age, points, target, duration, bounce } = initialFlight;
    sim.flight = state.ball.kind === 'shot' ? { kind: 'shot', from, age, points } :
      state.ball.kind === 'pass' && target ? { kind: 'pass', from, age, target, duration, bounce, lob: false } : null;
  }
  type Body = { height: number; mass: number; wingspan: number; reach: number; leverage: number; acceleration: number };
  const bodies = new WeakMap<Player, Body>();
  function body(p: GamePlayer): Body {
    const profile = p.profile as Player & { wingspan?: number };
    const cached = bodies.get(profile);
    if (cached) return cached;
    const positionIndex = Math.max(0, ['PG', 'SG', 'SF', 'PF', 'C'].indexOf(profile.position));
    const typicalHeight = 1.88 + positionIndex * 0.055;
    const height = clamp(Number.isFinite(profile.height) && profile.height > 0 ? profile.height : typicalHeight, 1.55, 2.36);
    const typicalMass = (23.8 + positionIndex * 0.66) * height * height;
    const mass = clamp(Number.isFinite(profile.weight) && profile.weight! > 0 ? profile.weight! : typicalMass, 55, 165);
    const strength = clamp(Number.isFinite(profile.ratings.strength) ? profile.ratings.strength! : 55 + positionIndex * 6 + (mass - typicalMass) * 0.15, 25, 99);
    const wingspan = clamp(Number.isFinite(profile.wingspan) && profile.wingspan! > 0 ? profile.wingspan! : height * 1.035, height * 0.91, height * 1.19);
    const result = { height, mass, wingspan, reach: height * 1.26 + (wingspan - height * 1.035) * 0.58,
      leverage: (mass / 95) ** 0.72 * (0.6 + strength / 155),
      acceleration: clamp(0.23 * (95 / mass) ** 0.42 * (0.92 + strength / 850), 0.17, 0.285) };
    bodies.set(profile, result);
    return result;
  }
  function random() {
    sim.seed = (Math.imul(sim.seed, 1664525) + 1013904223) >>> 0;
    return sim.seed / 4294967296;
  }
  function event(type: GameEvent['type'], side: Side, player?: GamePlayer, extra?: Partial<GameEvent>) {
    state.events.push({ tick: state.tick, type, side, ...(player && { playerId: player.id, position: { ...player.position } }), ...extra });
  }
  function localBall(p: GamePlayer, forward: number, side: number, height: number) {
    const x = Math.cos(p.facing), z = Math.sin(p.facing);
    return at(p.position.x + x * forward + z * side, height, p.position.z + z * forward - x * side);
  }
  function alignToHoop(p: GamePlayer) {
    const x = sign(p.side) * COURT.rimX - p.position.x;
    if (Math.hypot(x, p.position.z) > 0.05) p.facing = Math.atan2(-p.position.z, x);
  }
  function follow(p: GamePlayer, control?: Control) {
    const ball = state.ball;
    const physique = body(p);
    const dribble = sim.dribble?.ownerId === p.id ? sim.dribble :
      sim.dribble = { ownerId: p.id, hand: 1, phase: 0, lastTick: state.tick, held: false };
    const elapsed = (state.tick - dribble.lastTick) * DT;
    dribble.lastTick = state.tick;
    const gather = sim.gather?.ownerId === p.id ? sim.gather : undefined;
    const charge = state.charge[p.id] || 0;
    if (charge > 0 && gather) {
      alignToHoop(p);
      const range = distance(p.position, { x: sign(p.side) * COURT.rimX, z: 0 });
      const style = chooseStyle(p, range, gather);
      const lift = clamp(charge / 0.27, 0, 1);
      const ease = lift * lift * (3 - 2 * lift);
      const release = releasePosition(p, range, style, gather.approach);
      const rest = localBall(p, 0.30, gather.handOffset, gather.height);
      ball.position = at(rest.x + (release.x - rest.x) * ease, rest.y + (release.y - rest.y) * ease, rest.z + (release.z - rest.z) * ease);
      ball.velocity = at(p.velocity.x, 0, p.velocity.z);
      ball.spin = at(0, 0, 0);
      delete ball.dribbleHand;
      return;
    }
    if (control?.dribble && !dribble.held && !dribble.crossover && canAct(p.id + '/dribble', 34)) {
      dribble.crossover = { traveled: 0, floorAt: (dribble.phase < 0.5 ? 0.5 : 1.5) - dribble.phase };
      p.stamina = Math.max(0, p.stamina - 1.2);
    }
    dribble.held = !!control?.dribble;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    const frequency = (1.0 + Math.min(0.37, speed * 0.06) + p.profile.ratings.handling * 0.0015) * (dribble.crossover ? 1.22 : 1);
    const stride = elapsed * frequency;
    dribble.phase = (dribble.phase + stride) % 1;
    let handOffset: number = dribble.hand;
    let crossoverBend = 0;
    if (dribble.crossover) {
      const cross = dribble.crossover;
      cross.traveled += stride;
      const afterFloor = cross.traveled - cross.floorAt;
      const progress = afterFloor < 0 ? 0.5 * cross.traveled / cross.floorAt : 0.5 + 0.5 * clamp(afterFloor / 0.30, 0, 1);
      handOffset = dribble.hand * Math.cos(progress * Math.PI);
      crossoverBend = Math.sin(progress * Math.PI);
      if (afterFloor >= 0.30) { dribble.hand = dribble.hand === 1 ? -1 : 1; delete dribble.crossover; }
    }
    const halfStroke = dribble.phase < 0.5 ? dribble.phase : dribble.phase - 1;
    const height = physique.height * (0.61 - 0.08 * crossoverBend) - BALL_RADIUS;
    const y = BALL_RADIUS + height * (1 - 4 * halfStroke ** 2);
    const lateral = (0.25 + (physique.wingspan - 1.85) * 0.14) * handOffset;
    ball.position = localBall(p, 0.25 + Math.min(speed, 7) * 0.034, lateral, y);
    ball.velocity = at(p.velocity.x, -8 * height * halfStroke * frequency, p.velocity.z);
    ball.spin = at(p.velocity.z * 0.75, handOffset * 2.1, -p.velocity.x * 0.75);
    ball.dribbleHand = handOffset < 0 ? -1 : 1;
  }
  function hold(p: GamePlayer) {
    if (p.side !== state.possession) { state.shotClock = 24; sim.lastPass = null; sim.crossed = false; sim.backcourtTicks = 0; }
    state.possession = p.side;
    state.ball.kind = 'held';
    state.ball.ownerId = p.id;
    sim.flight = null;
    delete sim.gather;
    delete sim.dribble;
    sim.pendingRebound = false;
    follow(p);
  }
  function setup(side: Side) {
    const s = sign(side);
    const counters = [0, 0];
    for (const p of state.players) {
      const slot = counters[p.side]++;
      const spot = shape[slot];
      const x = slot === 0 && half ? 3.8 : spot.x;
      p.position = { x: (x + (p.side !== side ? (slot === 0 ? 1.95 : 1.1) : 0)) * s, z: spot.z };
      p.velocity = { x: 0, z: 0 };
      p.facing = p.side === side ? (s === 1 ? 0 : Math.PI) : (s === 1 ? Math.PI : 0);
      p.pose = 'idle';
    }
    const owner = state.players.find(p => p.side === side) ?? state.players[0];
    hold(owner);
    state.shotClock = sim.resumeClock ?? 24; delete sim.resumeClock;
    state.charge = {};
    sim.lastPass = null;
    sim.rimTouched = false; sim.crossed = false; sim.backcourtTicks = 0;
    state.phase = 'live';
    delete sim.deadBallMotion;
  }
  if (!initialState) {
    const count = clamp(Math.floor(settings.playersPerTeam), 1, 5);
    for (const side of [0, 1] as const) {
      for (const profile of teams[side].roster.slice(0, count)) {
        const id = state.players.some(p => p.id === profile.id) ? `${side}:${profile.id}` : profile.id;
        state.players.push({ id, profile, side, position: { x: 0, z: 0 }, velocity: { x: 0, z: 0 }, facing: 0, stamina: 100, pose: 'idle' });
      }
    }
    if (!state.players.length || !teams[0].roster.length || !teams[1].roster.length) throw Error('Each team needs at least one player');
    setup(0);
  }
  function dead(side: Side, animateBall = false) {
    sim.deadUntil = state.tick + 38;
    sim.inbound = side;
    state.phase = 'dead';
    state.ball.ownerId = null;
    state.ball.kind = 'loose';
    delete state.ball.dribbleHand;
    state.charge = {};
    sim.flight = null;
    sim.deadBallMotion = animateBall;
    sim.pendingRebound = false;
    sim.rimTouched = false;
    delete sim.gather;
    delete sim.dribble;
  }
  function canAct(key: string, cooldown: number) {
    if ((sim.locks[key] ?? 0) > state.tick) return false;
    sim.locks[key] = state.tick + cooldown;
    return true;
  }
  function move(p: GamePlayer, cmd?: Control) {
    const dx = Number.isFinite(cmd?.move?.x) ? cmd!.move.x : 0;
    const dz = Number.isFinite(cmd?.move?.z) ? cmd!.move.z : 0;
    const norm = Math.hypot(dx, dz);
    const sprint = !!cmd?.sprint && norm > 0.1 && p.stamina > 8;
    const owner = state.ball.ownerId === p.id;
    const charge = owner && (cmd?.shoot || state.charge[p.id]);
    const speed = (3.5 + p.profile.ratings.speed * 0.024) * (sprint ? 1.46 : 1) * (owner ? 0.94 : 1) * (charge ? 0.24 : cmd?.screen ? 0.12 : 1);
    const physique = body(p);
    p.stamina = clamp(p.stamina + DT * (sprint ? -7 * (physique.mass / 95) ** 0.3 : 3.6), 0, 100);
    p.velocity.x += (dx / Math.max(1, norm) * speed - p.velocity.x) * physique.acceleration;
    p.velocity.z += (dz / Math.max(1, norm) * speed - p.velocity.z) * physique.acceleration;
    p.position.x = clamp(p.position.x + p.velocity.x * DT, half ? 0.32 : -LIMIT_X, LIMIT_X);
    p.position.z = clamp(p.position.z + p.velocity.z * DT, -LIMIT_Z, LIMIT_Z);
    if (norm > 0.08) p.facing = Math.atan2(dz, dx);
    const released = sim.release?.playerId === p.id && sim.release.until > state.tick;
    p.pose = charge || released ? 'shoot' : cmd?.contest ? 'contest' : cmd?.screen ? 'screen' : owner ? 'dribble' : norm > 0.08 ? 'run' : 'idle';
  }
  function separate() {
    for (let i = 0; i < state.players.length; i++) for (let j = i + 1; j < state.players.length; j++) {
      const a = state.players[i], b = state.players[j];
      const d = distance(a.position, b.position);
      if (d >= 0.67) continue;
      const dx = d ? (a.position.x - b.position.x) / d : 1;
      const dz = d ? (a.position.z - b.position.z) / d : 0;
      const push = pusher(a, b) * (0.67 - d);
      const rest = 0.67 - d - push;
      a.position.x = clamp(a.position.x + dx * push, half ? 0.32 : -LIMIT_X, LIMIT_X); a.position.z = clamp(a.position.z + dz * push, -LIMIT_Z, LIMIT_Z);
      b.position.x = clamp(b.position.x - dx * rest, half ? 0.32 : -LIMIT_X, LIMIT_X); b.position.z = clamp(b.position.z - dz * rest, -LIMIT_Z, LIMIT_Z);
    }
  }
  function pusher(a: GamePlayer, b: GamePlayer) {
    const leverage = (p: GamePlayer) => body(p).leverage * (p.pose === 'screen' ? 3.2 : 1);
    const aHold = leverage(a), bHold = leverage(b);
    return bHold / (aHold + bHold);
  }
  function launch(p: GamePlayer, start: Vec3, velocity: Vec3, spin: Vec3, flight: Flight) {
    state.ball = { kind: flight.kind, ownerId: null, position: start, velocity, spin };
    sim.flight = flight;
    state.charge[p.id] = 0;
    sim.rimTouched = false;
    sim.pendingRebound = false;
    delete sim.dribble;
    delete sim.gather;
    if (flight.kind === 'shot') {
      sim.release = { playerId: p.id, until: state.tick + 18 };
      p.pose = 'shoot';
    }
  }
  function dunkReach(p: GamePlayer, approach: number) {
    return body(p).reach + 0.37 + p.profile.ratings.finishing * 0.004 + Math.min(6, approach) * 0.024;
  }
  function chooseStyle(p: GamePlayer, range: number, gather: Pick<Gather, 'style' | 'approach' | 'sprint' | 'backward'>): ShotStyle {
    const inside = range < 2.3;
    const canDunk = inside && dunkReach(p, gather.approach) >= COURT.rimHeight + 0.07;
    if (gather.style === 'dunk') return canDunk ? 'dunk' : inside ? 'layup' : 'jump';
    if (gather.style === 'layup' && !inside) return 'floater';
    if (gather.style) return gather.style;
    if (inside) return canDunk && gather.sprint ? 'dunk' : 'layup';
    if (gather.backward) return 'fadeaway';
    if (range >= 4.4) return 'jump';
    return p.profile.position === 'PF' || p.profile.position === 'C' ? 'hook' : 'floater';
  }
  function releasePosition(p: GamePlayer, range: number, style: ShotStyle, approach: number) {
    const height = style === 'dunk' ? dunkReach(p, approach) - 0.015 : body(p).reach + (style === 'layup' ? 0.20 : 0.11);
    const forward = Math.min(style === 'dunk' ? 0.47 : 0.23, Math.max(0, range - 0.05));
    return localBall(p, forward, style === 'dunk' ? 0.036 : 0.068, height);
  }
  function aimAt(rim: Vec3, start: Vec3, roll: number, spread: number, depthBias: number) {
    const radius = Math.sqrt(-2 * Math.log1p(-roll)) * spread;
    const angle = random() * Math.PI * 2;
    const depth = depthBias + radius * Math.cos(angle);
    const side = radius * Math.sin(angle);
    const range = distance(start, rim);
    const forwardX = range > 0.01 ? (rim.x - start.x) / range : 1;
    const forwardZ = range > 0.01 ? (rim.z - start.z) / range : 0;
    return at(rim.x + depth * forwardX + side * forwardZ, rim.y, rim.z + depth * forwardZ - side * forwardX);
  }
  function backspin(velocity: Vec3, speed: number) {
    const horizontal = Math.max(0.01, Math.hypot(velocity.x, velocity.z));
    return at(-velocity.z * speed / horizontal, 0, velocity.x * speed / horizontal);
  }
  function startFree(p: GamePlayer, attempts: number) {
    sim.free = { shooter: p.id, remaining: attempts, startTick: state.tick, waiting: true };
    dead(p.side);
  }
  function chargeShot(p: GamePlayer, control: Control) {
    if (sim.gather?.ownerId !== p.id) {
      sim.gather = {
        ownerId: p.id, height: state.ball.position.y,
        handOffset: (state.ball.dribbleHand ?? 1) * (0.25 + (body(p).wingspan - 1.85) * 0.14),
        approach: Math.hypot(p.velocity.x, p.velocity.z), sprint: !!control.sprint, backward: control.move.x * sign(p.side) < -0.55,
      };
    }
    if (control.shotType) sim.gather.style = control.shotType;
    state.charge[p.id] = Math.min(MAX_CHARGE, (state.charge[p.id] ?? 0) + DT);
    follow(p, control);
  }
  function lineUp(p: GamePlayer) {
    setup(p.side);
    p.position = { x: sign(p.side) * (COURT.rimX - 4.6), z: 0 };
    state.players.filter(q => q.id !== p.id).forEach((q, i) => {
      q.position = { x: sign(p.side) * (COURT.rimX - 1.6 - Math.floor(i / 2) * 1.15), z: (i % 2 ? -1 : 1) * 3 };
    });
    hold(p);
    sim.free!.waiting = false; sim.free!.startTick = state.tick;
  }
  function freeStep(controls: Readonly<Record<string, Control>>) {
    const ft = sim.free!;
    const p = state.players.find(q => q.id === ft.shooter)!;
    if (ft.waiting) {
      if (state.tick >= sim.deadUntil) lineUp(p);
      else if (sim.deadBallMotion) advanceBall(state.ball, DT, half);
      return;
    }
    if (state.ball.kind === 'shot') { progressBall(controls); return; }
    const control = controls[p.id];
    if (control?.shoot && state.tick - ft.startTick < 210) {
      chargeShot(p, { ...control, shotType: 'jump' }); p.pose = 'shoot'; return;
    }
    const charge = state.charge[p.id] || 0;
    if (!charge && state.tick - ft.startTick < 108) return;
    const error = charge ? charge - IDEAL_RELEASE : 0.045;
    alignToHoop(p);
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const start = releasePosition(p, distance(p.position, rim), 'jump', 0);
    const spread = clamp(0.058 + (75 - p.profile.ratings.shooting) * 0.0008 + Math.abs(error) * 0.14, 0.025, 0.16);
    const end = aimAt(rim, start, random(), spread, error * 0.34);
    const velocity = velocityFor(start, end, 0.99);
    event('shot', p.side, p, { points: 1, detail: 'Free throw' });
    launch(p, start, velocity, backspin(velocity, 10), { kind: 'shot', from: p.id, age: 0, points: 1 });
  }
  function shoot(p: GamePlayer, charge: number, controls: Readonly<Record<string, Control>>) {
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const range = distance(p.position, rim);
    const defenders = state.players.filter(q => q.side !== p.side);
    const closest = defenders.reduce<GamePlayer | undefined>((a, q) => !a || distance(p.position, q.position) < distance(p.position, a.position) ? q : a, undefined);
    const reachAdvantage = (q: GamePlayer) => clamp(body(q).reach - body(p).reach, -0.65, 0.65);
    const pressure = defenders.reduce((max, q) => {
      const advantage = reachAdvantage(q);
      const proximity = clamp(1 - distance(q.position, p.position) / (2.3 + advantage * 0.55), 0, 1);
      return Math.max(max, proximity * (controls[q.id]?.contest ? 0.54 + advantage * 0.3 : 0.16 + advantage * 0.09));
    }, 0);
    const contact = range < 3.2 && closest ? clamp(1 - distance(closest.position, p.position) / 1.55, 0, 1) : 0;
    const postAdvantage = closest ? clamp(body(p).leverage - body(closest).leverage, -0.8, 0.8) * contact * 0.24 : 0;
    const error = charge - IDEAL_RELEASE;
    const precision = clamp(1 - Math.abs(error) / 0.5, 0, 1);
    const three = range >= COURT.three || (Math.abs(p.position.z) >= 6.7 && p.position.x * sign(p.side) >= COURT.rimX - 2.7);
    const streetScoring = settings.scoring;
    const streetValue = three ? streetScoring?.outside ?? 2 : streetScoring?.inside ?? 1;
    const points = settings.mode === 'blacktop' ? clamp(Math.round(streetValue), 1, 10) : three ? 3 : 2;
    const aimRoll = random();
    const cmd = controls[p.id];
    const gather = sim.gather?.ownerId === p.id ? sim.gather : undefined;
    const approach = gather?.approach ?? Math.hypot(p.velocity.x, p.velocity.z);
    const style = chooseStyle(p, range, { approach, style: cmd?.shotType ?? gather?.style, sprint: !!(cmd?.sprint || gather?.sprint),
      backward: (cmd?.move.x ?? 0) * sign(p.side) < -0.55 || !!gather?.backward });
    const label = { dunk: 'Dunk', layup: 'Layup', floater: 'Floater', hook: 'Hook', fadeaway: 'Fadeaway', jump: 'Jump shot' }[style];
    if (style === 'fadeaway') p.velocity.x -= sign(p.side) * 1.5;
    const timing = precision > 0.85 ? 'Excellent' : charge < IDEAL_RELEASE ? 'Early' : 'Late';
    if (settings.mode === 'regulation' && closest && controls[closest.id]?.contest && distance(closest.position, p.position) < 0.98 && random() < 0.085) {
      event('foul', closest.side, closest, { detail: 'Shooting foul · ' + points + ' free throws' });
      startFree(p, points); return;
    }
    event('shot', p.side, p, { points, detail: label + ' · ' + timing });
    alignToHoop(p);
    const start = releasePosition(p, range, style, approach);
    const rating = range < 3.2 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
    const spread = clamp((style === 'dunk' ? 0.036 : 0.061) + (75 - rating) * 0.0011 + Math.max(0, range - 2) * 0.0046 +
      Math.max(0, range - 9.55) * 0.051 + pressure * 0.18 - postAdvantage * 0.92 + Math.abs(error) * 0.22 + (100 - p.stamina) * 0.00072 +
      Math.hypot(p.velocity.x, p.velocity.z) * 0.004, 0.024, 0.72);
    const depthBias = error * (style === 'dunk' ? 0.11 : 0.24 + range * 0.026);
    const end = aimAt(rim, start, aimRoll, spread, depthBias);
    const duration = style === 'dunk' ? 0.34 : style === 'layup' ? 0.52 :
      clamp(0.78 + range * 0.063 + (style === 'floater' ? 0.16 : 0), 0.81, 2.24);
    const velocity = velocityFor(start, end, duration);
    const spin = backspin(velocity, style === 'dunk' ? 3 : style === 'layup' ? 7 : 11);
    if (closest && controls[closest.id]?.contest && distance(closest.position, p.position) < 1.12 + reachAdvantage(closest) * 0.42 && random() < clamp(0.12 + closest.profile.ratings.interior * 0.002 + reachAdvantage(closest) * 0.45, 0.04, 0.58)) {
      event('block', closest.side, closest);
      launch(p, start, at(-Math.cos(p.facing) * (1.5 + Math.abs(velocity.x) * 0.35), Math.max(-1.2, velocity.y * 0.35),
        -Math.sin(p.facing) * 1.5 + (random() - 0.5) * 3.4), backspin(velocity, -5), { kind: 'shot', from: p.id, points, age: 0 });
      state.ball.kind = 'loose'; sim.flight = null; sim.pendingRebound = true;
      event('miss', p.side, p, { detail: 'Blocked' });
      return;
    }
    launch(p, start, velocity, spin, { kind: 'shot', from: p.id, age: 0, points });
  }
  function pass(p: GamePlayer, cmd: Control) {
    const mates = state.players.filter(q => q.side === p.side && q.id !== p.id);
    const aim = cmd.move;
    function merit(q: GamePlayer) {
      const dx = q.position.x - p.position.x, dz = q.position.z - p.position.z;
      const d = Math.hypot(dx, dz);
      return (dx * aim.x + dz * aim.z) / Math.max(0.1, d) * 12 - d * 0.14 + dx * sign(p.side) * 0.12;
    }
    const target = mates.find(q => q.id === cmd.targetId) ?? mates.sort((a, b) => merit(b) - merit(a))[0];
    if (!target) return;
    const lob = cmd.passType === 'lob', bounce = cmd.passType === 'bounce';
    const duration = clamp(distance(p.position, target.position) / (lob ? 11 : 16) * (1.14 - p.profile.ratings.passing * 0.0016), lob ? 0.54 : 0.18, lob ? 1.4 : 1.05);
    const end = at(clamp(target.position.x + target.velocity.x * duration * 0.65, -LIMIT_X, LIMIT_X), 1.28, clamp(target.position.z + target.velocity.z * duration * 0.65, -LIMIT_Z, LIMIT_Z));
    p.facing = Math.atan2(end.z - p.position.z, end.x - p.position.x);
    const start = localBall(p, 0.19, 0, body(p).height * 0.75);
    const velocity = velocityFor(start, end, duration);
    const flight: PassFlight = { kind: 'pass', from: p.id, target: target.id, age: 0, duration, bounce, lob };
    if (bounce) {
      const floorTime = duration * 0.56;
      velocity.y = (BALL_RADIUS - start.y) / floorTime + GRAVITY * floorTime / 2;
      flight.floorTime = floorTime;
    } else if (lob) velocity.y += 0.9;
    const horizontal = Math.hypot(velocity.x, velocity.z);
    launch(p, start, velocity, backspin(velocity, bounce ? -horizontal / BALL_RADIUS * 0.73 : 4), flight);
    event('pass', p.side, p, { detail: cmd.passType ?? 'chest' });
  }
  function outOfBounds(ball: PhysicalBall) {
    return Math.abs(ball.position.x) > COURT.length / 2 || Math.abs(ball.position.z) > COURT.width / 2 || (half && ball.position.x < 0);
  }
  function resolveShot(shooter: GamePlayer, flight: ShotFlight, made: boolean) {
    sim.flight = null;
    const ft = sim.free;
    if (made) {
      state.score[shooter.side] += flight.points;
      event('score', shooter.side, shooter, { points: flight.points, ...(ft && { detail: 'Free throw' }) });
      // The net slows the ball as it falls through and continues moving after the whistle.
      const { velocity, spin } = state.ball;
      velocity.x *= 0.41; velocity.y *= 0.64; velocity.z *= 0.41;
      if (spin) { spin.x *= 0.65; spin.y *= 0.65; spin.z *= 0.65; }
    } else {
      event('miss', shooter.side, shooter, ft ? { detail: 'Free throw' } : undefined);
      state.ball.kind = 'loose';
      sim.pendingRebound = true;
      if (sim.rimTouched) state.shotClock = 14;
    }
    if (ft) {
      ft.remaining--;
      if (ft.remaining > 0) { ft.waiting = true; dead(shooter.side, made); }
      else {
        delete sim.free;
        if (made) dead(opposite(shooter.side), true);
      }
      return;
    }
    if (!made) return;
    const assist = sim.lastPass;
    if (assist?.to === shooter.id && state.tick - assist.tick < 300) {
      const helper = state.players.find(p => p.id === assist.from);
      if (helper) event('assist', helper.side, helper);
    }
    if (settings.mode === 'blacktop' && state.score[shooter.side] >= (settings.targetScore ?? 21)) {
      state.phase = 'final';
      return;
    }
    dead(settings.mode === 'practice' || settings.makeItTakeIt ? shooter.side : opposite(shooter.side), true);
  }
  function advanceShot(ball: PhysicalBall, f: ShotFlight, shooter: GamePlayer) {
    const rimX = sign(shooter.side) * COURT.rimX;
    const crossingRadius = (from: Vec3, to: Vec3, height: number) => {
      const ratio = (from.y - height) / (from.y - to.y);
      return Math.hypot(from.x + ratio * (to.x - from.x) - rimX, from.z + ratio * (to.z - from.z));
    };
    let made = false;
    f.age += DT;
    advanceBall(ball, DT, half, (from, to) => {
      if (from.y >= COURT.rimHeight && to.y < COURT.rimHeight) {
        f.throughRim = crossingRadius(from, to, COURT.rimHeight) <= RIM_CLEARANCE + 0.0002;
      } else if (from.y <= COURT.rimHeight && to.y > COURT.rimHeight) f.throughRim = false;
      const belowRim = COURT.rimHeight - 0.105;
      if (f.throughRim && from.y >= belowRim && to.y < belowRim && crossingRadius(from, to, belowRim) < 0.25) made = true;
    }, surface => {
      if (surface === 'rim' && Math.abs(ball.position.x - rimX) < 0.5) sim.rimTouched = true;
    });
    if (made || (ball.position.y < COURT.rimHeight - 0.24 && ball.velocity.y < 0) || f.age > 4.6 || outOfBounds(ball)) {
      resolveShot(shooter, f, made);
    }
  }
  function progressBall(controls: Readonly<Record<string, Control>>) {
    const ball = state.ball, f = sim.flight;
    const passer = f && state.players.find(p => p.id === f.from);
    if (ball.kind === 'shot' && f?.kind === 'shot' && passer) {
      advanceShot(ball, f, passer);
      if (state.phase !== 'live' || ball.kind === 'shot') return;
    } else {
      advanceBall(ball, DT, half);
      if ((ball.kind === 'pass' && f?.kind !== 'pass') || ball.kind === 'shot') ball.kind = 'loose';
    }
    if (ball.kind === 'pass' && f?.kind === 'pass' && passer) {
      f.age += DT;
      const receiver = state.players.find(q => q.id === f.target);
      for (const q of state.players) {
        if (q.side === passer.side || f.age < 0.09 || ball.position.y > body(q).reach || distance(q.position, ball.position) > (controls[q.id]?.steal ? 1.03 : 0.39)) continue;
        event('steal', q.side, q, { detail: 'Intercepted pass' }); event('turnover', passer.side, passer); hold(q); return;
      }
      const catchAfter = f.bounce ? (f.floorTime ?? f.duration * 0.56) + DT / 2 : f.duration * (f.lob ? 0.62 : 0.35);
      if (receiver && f.age > catchAfter && distance(receiver.position, ball.position) < 1.25 && ball.position.y < body(receiver).reach + 0.25) {
        hold(receiver); sim.lastPass = { from: passer.id, to: receiver.id, tick: state.tick };
        const hoop = { x: sign(receiver.side) * COURT.rimX, z: 0 };
        if (f.lob && distance(receiver.position, hoop) < 2.15 && (controls[receiver.id]?.shoot || controls[receiver.id]?.sprint)) {
          shoot(receiver, IDEAL_RELEASE, controls);
          const attempt = state.events.findLast(e => e.type === 'shot' && e.tick === state.tick);
          if (attempt) attempt.detail = 'Alley-oop';
        }
        return;
      }
      if (f.age >= f.duration - 1e-8 || outOfBounds(ball)) { ball.kind = 'loose'; sim.flight = null; }
    }
    if (ball.kind !== 'loose') return;
    if (outOfBounds(ball)) {
      event('turnover', state.possession, undefined, { detail: 'Out of bounds' }); dead(opposite(state.possession)); return;
    }
    const rim = { x: sign(state.possession) * COURT.rimX, z: 0 };
    function reboundPriority(p: GamePlayer) {
      const physique = body(p);
      const position = distance(p.position, ball.position);
      const braced = p.pose === 'screen' || p.pose === 'contest';
      // Inside position lets a player use their body to keep a nearby opponent off the glass.
      const boxOut = sim.pendingRebound && braced && state.players.some(q =>
        q.side !== p.side && distance(p.position, q.position) < 1.35 && distance(p.position, rim) < distance(q.position, rim));
      return position - p.profile.ratings.rebounding * 0.005 - (physique.reach - 2.45) * 0.24 -
        (boxOut ? 0.23 * physique.leverage : 0);
    }
    const contender = state.players.filter(p => distance(p.position, ball.position) <= 1.02 + (body(p).wingspan - 2) * 0.38 &&
      ball.position.y < body(p).reach + (controls[p.id]?.contest ? 0.31 : -0.16))
      .sort((a, b) => reboundPriority(a) - reboundPriority(b))[0];
    if (contender) {
      if (sim.pendingRebound) event('rebound', contender.side, contender);
      sim.rimTouched = false; sim.lastPass = null; hold(contender);
    }
  }
  function step(controls: Readonly<Record<string, Control>> = {}) {
    if (state.phase === 'final') return state;
    state.tick++;
    if (sim.free) { freeStep(controls); return state; }
    for (const p of state.players) {
      const action = controls[p.id];
      if (action?.substituteId && canAct(p.id + '/sub', 90)) {
        const bench = state.teams[p.side].roster.find(profile => profile.id === action.substituteId);
        if (bench && !state.players.some(q => q.side === p.side && q.profile.id === bench.id)) {
          const prev = p.id, owner = state.ball.ownerId === prev;
          if (sim.flight?.from === prev || (sim.flight?.kind === 'pass' && sim.flight.target === prev)) continue;
          p.profile = bench;
          p.id = state.players.some(q => q !== p && q.id === bench.id) ? p.side + ':' + bench.id : bench.id;
          p.stamina = 100; delete state.charge[prev];
          if (owner) hold(p);
          event('substitution' as GameEvent['type'], p.side, p, { detail: prev + ' out' });
        }
      }
      if (action?.timeout && state.phase === 'live' && state.ball.ownerId === p.id && canAct(p.id + '/timeout', 180)) {
        sim.timeouts ??= [7, 7];
        if (sim.timeouts[p.side] > 0) {
          sim.timeouts[p.side]--; event('timeout' as GameEvent['type'], p.side, p, { detail: sim.timeouts[p.side] + ' remaining' });
          state.players.forEach(q => { q.stamina = Math.min(100, q.stamina + 10); });
          sim.resumeClock = state.shotClock; dead(p.side); sim.deadUntil = state.tick + 90; return state;
        }
      }
    }
    if (state.phase === 'dead') {
      if (state.tick >= sim.deadUntil) setup(sim.inbound);
      else if (sim.deadBallMotion) advanceBall(state.ball, DT, half);
      return state;
    }
    for (const p of state.players) move(p, controls[p.id]);
    separate();
    const owner = state.players.find(p => p.id === state.ball.ownerId);
    if (owner) {
      const cmd = controls[owner.id];
      if (cmd?.shoot) chargeShot(owner, cmd);
      else if (!(state.charge[owner.id] > 0)) follow(owner, cmd);
      if (settings.mode === 'regulation' && !half) {
        const frontCourt = owner.position.x * sign(owner.side) > 0;
        sim.backcourtTicks = frontCourt ? 0 : (sim.backcourtTicks ?? 0) + 1;
        if ((!frontCourt && sim.crossed) || sim.backcourtTicks >= 8 * TICK_RATE) {
          event('turnover', owner.side, owner, { detail: sim.crossed ? 'Backcourt violation' : 'Eight-second violation' });
          dead(opposite(owner.side)); return state;
        }
        if (frontCourt) sim.crossed = true;
      }
      for (const q of state.players) {
        if (q.side === owner.side || !controls[q.id]?.steal || distance(owner.position, q.position) > 1.45 || !canAct(q.id + '/steal', 46)) continue;
        const roll = random();
        const skill = (q.profile.ratings.perimeter - owner.profile.ratings.handling) * 0.004;
        const reach = clamp((1.25 - distance(q.position, state.ball.position)) * 0.15, -0.09, 0.08);
        if (roll < 0.26 + skill + reach - (sim.dribble?.crossover ? 0.12 : 0)) {
          event('steal', q.side, q); event('turnover', owner.side, owner); hold(q); state.charge[owner.id] = 0; break;
        }
        if (roll > 0.94) { event('foul', q.side, q, { detail: 'Reach-in' }); dead(owner.side); break; }
      }
      if (state.ball.ownerId === owner.id) {
        if (!cmd?.shoot && state.charge[owner.id] > 0) shoot(owner, state.charge[owner.id], controls);
        else if (!cmd?.shoot && cmd?.pass && canAct(owner.id + '/pass', 15)) pass(owner, cmd);
      }
    } else progressBall(controls);
    if (state.phase === 'final' as GameState['phase']) return state;
    if (settings.mode === 'regulation') state.clock = Math.max(0, Math.round((state.clock - DT) * TICK_RATE) / TICK_RATE);
    if (settings.mode !== 'practice' && state.ball.kind !== 'shot' && state.phase === 'live') state.shotClock = Math.max(0, Math.round((state.shotClock - DT) * TICK_RATE) / TICK_RATE);
    if (settings.mode === 'regulation' && state.clock <= 0 && state.ball.kind !== 'shot') {
      event('period', state.possession, undefined, { detail: 'End of period ' + state.period });
      if (state.period >= settings.periods && state.score[0] !== state.score[1]) state.phase = 'final';
      else { state.period++; state.clock = state.period > settings.periods ? Math.min(300, settings.periodSeconds) : settings.periodSeconds; dead((state.period % 2 === 0 ? 1 : 0)); }
    } else if (state.shotClock <= 0 && state.phase === 'live' && state.ball.kind !== 'shot' && settings.mode !== 'practice') {
      event('turnover', state.possession, owner, { detail: 'Shot clock violation' }); dead(opposite(state.possession));
    }
    return state;
  }
  return { state, step };
}
