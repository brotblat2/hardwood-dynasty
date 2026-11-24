import { attackSign, COURT, TICK_RATE } from '../contracts/index.ts';
import type { Control, ContestLevel, Engine, GameConfig, GameEvent, GamePlayer, GameState, OffensePlay, DefenseScheme, Player, ShotTimingGrade, Side, Team, Vec2, Vec3 } from '../contracts/index.ts';
import { advanceBall, BALL_RADIUS, bankVelocityFor, BOARD_HALF_DEPTH, BOARD_OFFSET, bouncePassVelocity, GRAVITY, RIM_CLEARANCE, vector as at, velocityFor } from './ball.ts';
import type { PhysicalBall } from './ball.ts';

const DT = 1 / TICK_RATE;
export const IDEAL_RELEASE = 0.62;
export const MAX_CHARGE = 1.2;
const LIMIT_X = COURT.length / 2 - 0.32;
const LIMIT_Z = COURT.width / 2 - 0.32;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const opposite = (s: Side): Side => s === 0 ? 1 : 0;

export function selectPassTarget(
  passer: GamePlayer,
  teammates: readonly GamePlayer[],
  aim: Vec2,
  attackDirection = 1,
  opponents?: readonly GamePlayer[],
): string | undefined {
  const magnitude = Math.hypot(aim.x, aim.z);
  const candidates = teammates.filter(q => q.side === passer.side && q.id !== passer.id);
  if (!candidates.length || !Number.isFinite(magnitude) || magnitude < 0.22) return undefined;
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const teammate of candidates) {
    const dx = teammate.position.x - passer.position.x;
    const dz = teammate.position.z - passer.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.01) continue;
    const alignment = (dx * aim.x + dz * aim.z) / (d * magnitude);
    if (alignment < 0.25) continue;
    const openBonus = opponents?.length ? Math.min(2.2, Math.min(...opponents.map(o => distance(teammate.position, o.position))) * 0.45) : 0;
    const score = alignment * 6.5 - d * 0.10 + openBonus + dx * attackDirection * 0.04;
    if (score > bestScore) {
      bestScore = score;
      best = teammate.id;
    }
  }
  return best;
}

type ShotStyle = NonNullable<Control['shotType']>;
type BaseFlight = { from: string; age: number };
type ShotFlight = BaseFlight & { kind: 'shot'; points: number; throughRim?: boolean; andOne?: boolean; fouled?: boolean };
type PassFlight = BaseFlight & { kind: 'pass'; target: string; duration: number; bounce: boolean; lob: boolean; alleyOop?: boolean; floorTime?: number };
type Flight = ShotFlight | PassFlight;
type LegacyFlight = BaseFlight & { kind?: undefined; points: number; target?: string; duration: number; bounce: boolean };
type Gather = { ownerId: string; height: number; handOffset: number; approach: number; sprint: boolean; backward: boolean; style?: ShotStyle };
type Dribble = {
  ownerId: string; hand: -1 | 1; phase: number; lastTick: number; held: boolean;
  crossover?: { traveled: number; floorAt: number };
};
type Runtime = {
  free?: { shooter: string; remaining: number; total?: number; startTick: number; waiting: boolean; andOne?: boolean };
  resumeClock?: number; timeouts?: [number, number]; crossed?: boolean; backcourtTicks?: number;
  seed: number; flight: Flight | null; lastPass: { from: string; to: string; tick: number } | null;
  locks: Record<string, number>; deadUntil: number; inbound: Side; rimTouched: boolean;
  pendingRebound?: boolean; deadBallMotion?: boolean; dribble?: Dribble; gather?: Gather;
  release?: { playerId: string; until: number };
  teamFouls?: [number, number];
  burst?: Record<string, number>;
  stun?: Record<string, number>;
  jumpContest?: Record<string, number>;
  pumpFake?: Record<string, number>;
  stealPose?: Record<string, number>;
  lastDribble?: Record<string, number>;
  contestHeld?: Record<string, boolean>;
  pendingAndOne?: { shooter: string; points: number };
};
type Snapshot = GameState & { ball: PhysicalBall; simulation: Runtime };
const shape: Vec2[] = [{ x: -4, z: 0 }, { x: 4, z: -5.8 }, { x: 5, z: 5.8 }, { x: 8.5, z: -3 }, { x: 10.3, z: 2.1 }];

export function createEngine(teams: [Team, Team], config: GameConfig = {}, initialState?: GameState): Engine {
  const settings = { mode: 'regulation', periods: 4, periodSeconds: 300, playersPerTeam: 5, seed: 17, ...initialState?.config, ...config } satisfies GameConfig;
  const half = settings.halfCourt ?? settings.mode === 'blacktop';
  const sign = (side: Side) => half ? 1 : attackSign(side);
  const runtime: Runtime = { seed: settings.seed >>> 0, flight: null, lastPass: null, locks: {}, deadUntil: 0, inbound: 0, rimTouched: false, teamFouls: [0, 0] };
  const state: Snapshot = initialState ? Object.assign({ simulation: runtime }, structuredClone(initialState), { config: settings }) :
    { teams, config: settings, tick: 0, period: 1, clock: settings.periodSeconds, shotClock: 24, phase: 'live', score: [0, 0], possession: 0,
      players: [], ball: { position: at(0, 1, 0), velocity: at(0, 0, 0), kind: 'held', ownerId: null }, charge: {}, events: [],
      teamFouls: [0, 0], freeThrow: null, shotFeedback: null, simulation: runtime };
  const sim = state.simulation;
  sim.teamFouls ??= state.teamFouls ?? [0, 0];
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
      p.stamina = Math.max(0, p.stamina - 2.2);
      sim.lastDribble ??= {};
      sim.lastDribble[p.id] = state.tick;
      sim.burst ??= {};
      sim.burst[p.id] = state.tick + 24;
      if (control.move.x * sign(p.side) < -0.35) {
        p.velocity.x -= sign(p.side) * 2.8;
        p.velocity.z *= 0.6;
      } else {
        const dirZ = Math.abs(control.move.z) > 0.2 ? Math.sign(control.move.z) : -dribble.hand;
        p.velocity.z += dirZ * 2.6;
        p.velocity.x += sign(p.side) * 0.85;
      }
      const nearestDef = state.players
        .filter(q => q.side !== p.side && distance(q.position, p.position) < 1.65)
        .sort((a, b) => distance(a.position, p.position) - distance(b.position, p.position))[0];
      if (nearestDef && random() < clamp(0.18 + (p.profile.ratings.handling - nearestDef.profile.ratings.perimeter) * 0.008, 0.05, 0.55)) {
        sim.stun ??= {};
        sim.stun[nearestDef.id] = state.tick + 22;
      }
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
    const settingScreen = !!cmd?.screen && !cmd?.callScreen;
    sim.contestHeld ??= {};
    const contesting = !!cmd?.contest;
    const wasContesting = !!sim.contestHeld[p.id];
    sim.contestHeld[p.id] = contesting;
    if (contesting && !wasContesting && canAct(p.id + '/contest', 30)) {
      sim.jumpContest ??= {};
      sim.jumpContest[p.id] = state.tick + 22;
      p.stamina = Math.max(0, p.stamina - 1.6);
    }
    const staminaFactor = p.stamina < 35 ? 0.84 + (p.stamina / 35) * 0.16 : 1;
    const burstFactor = (sim.burst?.[p.id] ?? 0) > state.tick ? 1.18 : 1;
    const contestSlow = contesting ? 0.70 : 1;
    const stunAccel = (sim.stun?.[p.id] ?? 0) > state.tick ? 0.48 : 1;
    const speed = (3.5 + p.profile.ratings.speed * 0.024) * staminaFactor * (sprint ? 1.46 : 1) * burstFactor * (owner ? 0.94 : 1) * (charge ? 0.24 : settingScreen ? 0.12 : contestSlow);
    const physique = body(p);
    p.stamina = clamp(p.stamina + DT * (sprint ? -7 * (physique.mass / 95) ** 0.3 : 3.6), 0, 100);
    const accel = physique.acceleration * stunAccel;
    p.velocity.x += (dx / Math.max(1, norm) * speed - p.velocity.x) * accel;
    p.velocity.z += (dz / Math.max(1, norm) * speed - p.velocity.z) * accel;
    if (charge && (sim.gather?.style === 'fadeaway' || sim.gather?.backward)) {
      p.velocity.x -= sign(p.side) * 0.16;
    }
    p.position.x = clamp(p.position.x + p.velocity.x * DT, half ? 0.32 : -LIMIT_X, LIMIT_X);
    p.position.z = clamp(p.position.z + p.velocity.z * DT, -LIMIT_Z, LIMIT_Z);
    if (norm > 0.08) p.facing = Math.atan2(dz, dx);
    const released = sim.release?.playerId === p.id && sim.release.until > state.tick;
    const jumpContesting = (sim.jumpContest?.[p.id] ?? 0) > state.tick;
    const pumpFaking = (sim.pumpFake?.[p.id] ?? 0) > state.tick;
    const stealing = (sim.stealPose?.[p.id] ?? 0) > state.tick;
    const sliding = !owner && p.side !== state.possession && norm > 0.08 && !sprint && state.ball.ownerId !== null && distance(p.position, state.ball.position) < 3.6;
    p.pose = pumpFaking ? 'pumpFake' : stealing ? 'steal' : charge || released ? 'shoot' : contesting || jumpContesting ? 'contest' : settingScreen ? 'screen' : owner ? 'dribble' : sliding ? 'slide' : norm > 0.08 ? 'run' : 'idle';
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
    const height = style === 'dunk' ? dunkReach(p, approach) - 0.015 : body(p).reach + (style === 'layup' ? 0.20 : style === 'hook' ? 0.16 : 0.11);
    const forward = Math.min(style === 'dunk' ? 0.52 : 0.23, Math.max(0, range - 0.05));
    const lateral = style === 'dunk' ? 0.036 : style === 'hook' ? 0.26 * (p.position.z >= 0 ? -1 : 1) : 0.068;
    return localBall(p, forward, lateral, height);
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
  function startFree(p: GamePlayer, attempts: number, andOne = false) {
    sim.free = { shooter: p.id, remaining: attempts, total: attempts, startTick: state.tick, waiting: true, ...(andOne ? { andOne: true } : {}) };
    state.freeThrow = { shooterId: p.id, remaining: attempts, total: attempts, ...(andOne ? { andOne: true } : {}) };
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
  function shoot(p: GamePlayer, charge: number, controls: Readonly<Record<string, Control>>, detailOverride?: string) {
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const range = distance(p.position, rim);
    const defenders = state.players.filter(q => q.side !== p.side);
    const closest = defenders.reduce<GamePlayer | undefined>((a, q) => !a || distance(p.position, q.position) < distance(p.position, a.position) ? q : a, undefined);
    const reachAdvantage = (q: GamePlayer) => clamp(body(q).reach - body(p).reach, -0.65, 0.65);
    const isStunned = (q: GamePlayer) => (sim.stun?.[q.id] ?? 0) > state.tick;
    const isContesting = (q: GamePlayer) => !!controls[q.id]?.contest || (sim.jumpContest?.[q.id] ?? 0) > state.tick;
    const rawPressure = defenders.reduce((max, q) => {
      const advantage = reachAdvantage(q);
      const proximity = clamp(1 - distance(q.position, p.position) / (2.3 + advantage * 0.55), 0, 1);
      const base = proximity * (isContesting(q) ? 0.54 + advantage * 0.3 : 0.16 + advantage * 0.09);
      return Math.max(max, base * (isStunned(q) ? 0.45 : 1));
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
    if (style === 'dunk') p.stamina = Math.max(0, p.stamina - 3.2);
    const stylePressureMult = style === 'dunk' ? 0.55 : style === 'fadeaway' ? 0.62 : 1;
    const pressure = rawPressure * stylePressureMult;
    const rating = range < 3.2 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
    const greenWindow = clamp(0.036 + (rating - 60) * 0.0007 - pressure * 0.025, 0.018, 0.068);
    const isGreen = Math.abs(error) <= greenWindow && pressure < 0.38 && contact < 0.30;
    const timing: ShotTimingGrade = isGreen ? 'Green' : precision > 0.85 ? 'Excellent' :
      Math.abs(error) < 0.16 ? (error < 0 ? 'Slightly Early' : 'Slightly Late') : error < 0 ? 'Early' : 'Late';
    const contestLabel: ContestLevel = pressure < 0.12 ? 'Open' : pressure < 0.28 ? 'Light' : pressure < 0.48 ? 'Tight' : 'Smothered';
    let andOneFoul = false;
    if (settings.mode === 'regulation' && closest && isContesting(closest) && distance(closest.position, p.position) < 0.98 && random() < 0.085) {
      sim.teamFouls ??= [0, 0];
      sim.teamFouls[closest.side]++;
      state.teamFouls = [...sim.teamFouls];
      const canAndOne = style !== 'jump' && precision > 0.72 && (p.profile.ratings.finishing >= 80 || postAdvantage > 0.08);
      if (canAndOne && random() < 0.42) {
        andOneFoul = true;
      } else {
        event('foul', closest.side, closest, { detail: 'Shooting foul · ' + points + ' free throws' });
        startFree(p, points, false); return;
      }
    }
    alignToHoop(p);
    const start = releasePosition(p, range, style, approach);
    const catchAndShoot = sim.lastPass?.to === p.id && state.tick - sim.lastPass.tick <= 45;
    const offDribble = (sim.lastDribble?.[p.id] ?? -999) >= state.tick - 34 && p.profile.ratings.handling >= 80;
    const styleSpreadAdd = style === 'dunk' ? 0.036 : (style === 'fadeaway' ? 0.079 : 0.061);
    let spread = clamp(styleSpreadAdd + (75 - rating) * 0.0011 + Math.max(0, range - 2) * 0.0046 +
      Math.max(0, range - 9.55) * 0.051 + pressure * 0.18 - postAdvantage * 0.92 + Math.abs(error) * 0.22 + (100 - p.stamina) * 0.00072 +
      Math.hypot(p.velocity.x, p.velocity.z) * 0.004 + (andOneFoul ? 0.06 : 0), 0.024, 0.72);
    if (catchAndShoot) spread *= 0.82;
    if (offDribble) spread *= 0.90;
    if (isGreen) spread *= 0.34;
    const depthBias = error * (style === 'dunk' ? 0.11 : 0.24 + range * 0.026) * (isGreen ? 0.25 : 1);
    const end = aimAt(rim, start, aimRoll, spread, depthBias);
    const duration = style === 'dunk' ? 0.34 : style === 'layup' ? 0.52 :
      clamp(0.78 + range * 0.063 + (style === 'floater' ? 0.22 : 0), 0.81, 2.34);
    let velocity = velocityFor(start, end, duration);
    let bank = false;
    if (style === 'layup' && Math.abs(p.position.z) >= 0.72 && p.position.x * sign(p.side) < COURT.rimX - 0.2) {
      const boardFaceX = rim.x + sign(p.side) * (BOARD_OFFSET - BOARD_HALF_DEPTH - BALL_RADIUS);
      const bankShot = bankVelocityFor(start, end, boardFaceX, 0.72);
      if (bankShot) {
        velocity = bankShot.velocity;
        bank = true;
      }
    }
    const detailTiming = isGreen ? 'Excellent · Green' : timing;
    event('shot', p.side, p, { points, detail: detailOverride ?? (label + (bank ? ' (Bank)' : '') + ' · ' + detailTiming) });
    state.shotFeedback = { playerId: p.id, tick: state.tick, timing, contest: contestLabel, style: label, grade: precision, green: isGreen, bank };
    if (andOneFoul && closest) {
      event('foul', closest.side, closest, { detail: 'Shooting foul · And-1 chance' });
      sim.pendingAndOne = { shooter: p.id, points };
    }
    const spin = backspin(velocity, style === 'dunk' ? 3 : style === 'layup' ? (bank ? 2 : 7) : 11);
    const blockMult = style === 'fadeaway' ? 0.55 : style === 'floater' ? 0.58 : style === 'hook' ? 0.62 : 1;
    if (!andOneFoul && closest && isContesting(closest) && distance(closest.position, p.position) < 1.12 + reachAdvantage(closest) * 0.42 &&
      random() < clamp(0.12 + closest.profile.ratings.interior * 0.002 + reachAdvantage(closest) * 0.45, 0.04, 0.58) * blockMult * (isStunned(closest) ? 0.45 : 1)) {
      event('block', closest.side, closest);
      launch(p, start, at(-Math.cos(p.facing) * (1.5 + Math.abs(velocity.x) * 0.35), Math.max(-1.2, velocity.y * 0.35),
        -Math.sin(p.facing) * 1.5 + (random() - 0.5) * 3.4), backspin(velocity, -5), { kind: 'shot', from: p.id, points, age: 0 });
      state.ball.kind = 'loose'; sim.flight = null; sim.pendingRebound = true;
      event('miss', p.side, p, { detail: 'Blocked' });
      return;
    }
    launch(p, start, velocity, spin, { kind: 'shot', from: p.id, age: 0, points, ...(andOneFoul ? { andOne: true, fouled: true } : {}) });
  }
  function pass(p: GamePlayer, cmd: Control) {
    const mates = state.players.filter(q => q.side === p.side && q.id !== p.id);
    const foes = state.players.filter(q => q.side !== p.side);
    const aim = cmd.move;
    const attackDir = sign(p.side);
    const directional = selectPassTarget(p, mates, aim, attackDir, foes);
    const target = mates.find(q => q.id === cmd.targetId) ?? (directional ? mates.find(q => q.id === directional) : undefined) ??
      [...mates].sort((a, b) => {
        const merit = (q: GamePlayer) => {
          const dx = q.position.x - p.position.x, dz = q.position.z - p.position.z;
          const d = Math.hypot(dx, dz);
          const openBonus = foes.length ? Math.min(2.2, Math.min(...foes.map(o => distance(q.position, o.position))) * 0.45) : 0;
          return (dx * aim.x + dz * aim.z) / Math.max(0.1, d) * 12 - d * 0.12 + dx * attackDir * 0.14 + openBonus;
        };
        return merit(b) - merit(a);
      })[0];
    if (!target) return;
    const lob = cmd.passType === 'lob', bounce = cmd.passType === 'bounce';
    const gap = distance(p.position, target.position);
    const hoop = { x: attackDir * COURT.rimX, z: 0 };
    const leadFactor = clamp(0.54 + (p.profile.ratings.passing - 60) * 0.004, 0.44, 0.78);
    const rawDur = clamp(gap / (lob ? 9.6 : 16) * (1.14 - p.profile.ratings.passing * 0.0016), lob ? 0.56 : 0.18, lob ? 1.38 : 1.05);
    const minX = half ? 0.55 : -LIMIT_X + 0.35;
    const predictedX = clamp(target.position.x + target.velocity.x * rawDur * leadFactor, minX, LIMIT_X - 0.35);
    const predictedZ = clamp(target.position.z + target.velocity.z * rawDur * leadFactor, -LIMIT_Z + 0.35, LIMIT_Z - 0.35);
    const alleyOop = lob && distance({ x: predictedX, z: predictedZ }, hoop) < 3.1;
    const duration = alleyOop ? clamp(gap / 8.5 * (1.14 - p.profile.ratings.passing * 0.0016), 0.56, 1.38) : rawDur;
    const endY = alleyOop ? Math.min(COURT.rimHeight - 0.12, dunkReach(target, 3.2)) : lob ? 1.95 : 1.28;
    const end = at(predictedX, endY, predictedZ);
    p.facing = Math.atan2(end.z - p.position.z, end.x - p.position.x);
    const start = localBall(p, 0.19, 0, body(p).height * 0.75);
    let velocity = velocityFor(start, end, duration);
    const flight: PassFlight = { kind: 'pass', from: p.id, target: target.id, age: 0, duration, bounce, lob, ...(alleyOop ? { alleyOop: true } : {}) };
    if (bounce) {
      const bounced = bouncePassVelocity(start, end, duration);
      velocity = bounced.velocity;
      flight.floorTime = bounced.floorTime;
    }
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
    const andOne = flight.andOne ? sim.pendingAndOne : undefined;
    if (andOne) delete sim.pendingAndOne;
    if (made) {
      state.score[shooter.side] += flight.points;
      event('score', shooter.side, shooter, { points: flight.points, ...(ft && { detail: 'Free throw' }) });
      // The net slows the ball as it falls through and continues moving after the whistle.
      const { velocity, spin } = state.ball;
      velocity.x *= 0.41; velocity.y *= 0.64; velocity.z *= 0.41;
      if (spin) { spin.x *= 0.65; spin.y *= 0.65; spin.z *= 0.65; }
    } else {
      event('miss', shooter.side, shooter, ft ? { detail: 'Free throw' } : undefined);
      if (!andOne) {
        state.ball.kind = 'loose';
        sim.pendingRebound = true;
        if (sim.rimTouched) state.shotClock = 14;
      }
    }
    if (andOne) {
      if (made) {
        const assist = sim.lastPass;
        if (assist?.to === shooter.id && state.tick - assist.tick < 300) {
          const helper = state.players.find(p => p.id === assist.from);
          if (helper) event('assist', helper.side, helper);
        }
        if (settings.mode === 'blacktop' && state.score[shooter.side] >= (settings.targetScore ?? 21)) {
          state.phase = 'final';
          return;
        }
        startFree(shooter, 1, true);
      } else {
        startFree(shooter, flight.points, false);
      }
      return;
    }
    if (ft) {
      ft.remaining--;
      if (ft.remaining > 0) {
        ft.waiting = true;
        state.freeThrow = { shooterId: ft.shooter, remaining: ft.remaining, total: ft.total ?? ft.remaining, ...(ft.andOne ? { andOne: true } : {}) };
        dead(shooter.side, made);
      } else {
        delete sim.free;
        state.freeThrow = null;
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
        if (q.side === passer.side || f.age < 0.09) continue;
        const maxReachY = body(q).reach + (controls[q.id]?.contest ? 0.25 : 0);
        const reachDist = controls[q.id]?.steal ? 1.08 : controls[q.id]?.contest ? 0.85 : 0.42;
        const d = distance(q.position, ball.position);
        if (ball.position.y > maxReachY || d > reachDist) continue;
        const cleanStealDist = controls[q.id]?.steal ? 0.78 : 0.39;
        if (d <= cleanStealDist || q.profile.ratings.perimeter >= 84) {
          sim.stealPose ??= {}; sim.stealPose[q.id] = state.tick + 18;
          event('steal', q.side, q, { detail: 'Intercepted pass' }); event('turnover', passer.side, passer); hold(q); return;
        }
        if ((controls[q.id]?.steal || controls[q.id]?.contest) && canAct(q.id + '/deflect', 24)) {
          sim.stealPose ??= {}; sim.stealPose[q.id] = state.tick + 16;
          ball.velocity.x *= -0.35;
          ball.velocity.y = Math.max(1.8, Math.abs(ball.velocity.y) + 1.4);
          ball.velocity.z += (random() - 0.5) * 3.8;
          ball.kind = 'loose';
          sim.flight = null;
          return;
        }
      }
      const catchAfter = f.bounce ? (f.floorTime ?? f.duration * 0.58) + DT / 2 : f.duration * (f.lob ? 0.58 : 0.35);
      const catchDist = f.alleyOop ? 1.55 : 1.25;
      const catchHeight = f.alleyOop && receiver ? dunkReach(receiver, 3.5) + 0.35 : (receiver ? body(receiver).reach + 0.25 : 2.5);
      if (receiver && f.age > catchAfter && distance(receiver.position, ball.position) < catchDist && ball.position.y < catchHeight) {
        hold(receiver); sim.lastPass = { from: passer.id, to: receiver.id, tick: state.tick };
        const hoop = { x: sign(receiver.side) * COURT.rimX, z: 0 };
        const alleyRadius = f.alleyOop ? 2.65 : 2.15;
        const triggerOop = controls[receiver.id]?.shoot || controls[receiver.id]?.sprint || (f.alleyOop && Math.hypot(receiver.velocity.x, receiver.velocity.z) > 2.2);
        if (f.lob && distance(receiver.position, hoop) < alleyRadius && triggerOop) {
          shoot(receiver, IDEAL_RELEASE, controls, 'Alley-oop');
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
      if (action?.offensePlay) {
        state.offensePlay ??= ['motion', 'motion'];
        state.offensePlay[p.side] = action.offensePlay;
      }
      if (action?.defenseScheme) {
        state.defenseScheme ??= ['man', 'man'];
        state.defenseScheme[p.side] = action.defenseScheme;
      }
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
        sim.stealPose ??= {}; sim.stealPose[q.id] = state.tick + 18;
        const roll = random();
        const skill = (q.profile.ratings.perimeter - owner.profile.ratings.handling) * 0.004;
        const reach = clamp((1.25 - distance(q.position, state.ball.position)) * 0.15, -0.09, 0.08);
        if (roll < 0.26 + skill + reach - (sim.dribble?.crossover ? 0.12 : 0)) {
          event('steal', q.side, q); event('turnover', owner.side, owner); hold(q); state.charge[owner.id] = 0; break;
        }
        if (roll > 0.94) {
          sim.teamFouls ??= [0, 0];
          sim.teamFouls[q.side]++;
          state.teamFouls = [...sim.teamFouls];
          if (settings.mode === 'regulation' && sim.teamFouls[q.side] >= 5) {
            event('foul', q.side, q, { detail: 'Reach-in · Bonus (2 FT)' });
            startFree(owner, 2, false);
          } else {
            event('foul', q.side, q, { detail: 'Reach-in' });
            dead(owner.side);
          }
          break;
        }
      }
      if (state.ball.ownerId === owner.id) {
        if (cmd?.pumpFake && !(state.charge[owner.id] > 0.28) && canAct(owner.id + '/fake', 32)) {
          state.charge[owner.id] = 0;
          delete sim.gather;
          alignToHoop(owner);
          sim.pumpFake ??= {};
          sim.pumpFake[owner.id] = state.tick + 20;
          owner.stamina = Math.max(0, owner.stamina - 0.8);
          owner.pose = 'pumpFake';
          for (const def of state.players) {
            if (def.side === owner.side) continue;
            const d = distance(def.position, owner.position);
            const biting = controls[def.id]?.contest || (sim.jumpContest?.[def.id] ?? 0) > state.tick;
            if (d < 2.1 && (biting || (d < 1.55 && random() < clamp(0.45 - (def.profile.ratings.iq - 70) * 0.008, 0.15, 0.65)))) {
              sim.jumpContest ??= {};
              sim.jumpContest[def.id] = state.tick + 26;
              sim.stun ??= {};
              sim.stun[def.id] = state.tick + 28;
            }
          }
        } else if (state.charge[owner.id] > 0 && state.charge[owner.id] < 0.25 && cmd?.pass && canAct(owner.id + '/pass', 15)) {
          state.charge[owner.id] = 0;
          delete sim.gather;
          pass(owner, cmd);
        } else if (!cmd?.shoot && state.charge[owner.id] > 0) {
          shoot(owner, state.charge[owner.id], controls);
        } else if (!cmd?.shoot && cmd?.pass && canAct(owner.id + '/pass', 15)) {
          pass(owner, cmd);
        }
      }
    } else progressBall(controls);
    if (state.phase === 'final' as GameState['phase']) return state;
    if (settings.mode === 'regulation' && !sim.pendingAndOne) state.clock = Math.max(0, Math.round((state.clock - DT) * TICK_RATE) / TICK_RATE);
    if (settings.mode !== 'practice' && state.ball.kind !== 'shot' && state.phase === 'live' && !sim.pendingAndOne) state.shotClock = Math.max(0, Math.round((state.shotClock - DT) * TICK_RATE) / TICK_RATE);
    if (settings.mode === 'regulation' && state.clock <= 0 && state.ball.kind !== 'shot' && !sim.pendingAndOne) {
      event('period', state.possession, undefined, { detail: 'End of period ' + state.period });
      if (state.period >= settings.periods && state.score[0] !== state.score[1]) state.phase = 'final';
      else {
        state.period++;
        state.clock = state.period > settings.periods ? Math.min(300, settings.periodSeconds) : settings.periodSeconds;
        sim.teamFouls = [0, 0];
        state.teamFouls = [0, 0];
        dead((state.period % 2 === 0 ? 1 : 0));
      }
    } else if (state.shotClock <= 0 && state.phase === 'live' && state.ball.kind !== 'shot' && settings.mode !== 'practice' && !sim.pendingAndOne) {
      event('turnover', state.possession, owner, { detail: 'Shot clock violation' }); dead(opposite(state.possession));
    }
    return state;
  }
  return { state, step };
}
