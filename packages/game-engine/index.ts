import { attackSign, COURT, TICK_RATE } from '../contracts/index.ts';
import type { Control, Engine, GameConfig, GameEvent, GamePlayer, GameState, Player, Side, Team, Vec2, Vec3 } from '../contracts/index.ts';

const DT = 1 / TICK_RATE;
export const IDEAL_RELEASE = 0.62;
export const MAX_CHARGE = 1.2;
const G = 9.81;
const LIMIT_X = COURT.length / 2 - 0.32;
const LIMIT_Z = COURT.width / 2 - 0.32;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const opposite = (s: Side): Side => s === 0 ? 1 : 0;
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
type Flight = { from: string; target?: string; age: number; duration: number; points: number; make: boolean; bounce: boolean };
type ShotStyle = 'jump' | 'layup' | 'dunk' | 'floater' | 'hook' | 'fadeaway';
type TacticalControl = Control & { timeout?: boolean; substituteId?: string; shotType?: ShotStyle };
type Runtime = {
  free?: { shooter: string; remaining: number; startTick: number; waiting: boolean };
  resumeClock?: number; timeouts?: [number, number]; crossed?: boolean; backcourtTicks?: number;
  seed: number; flight: Flight | null; lastPass: { from: string; to: string; tick: number } | null;
  locks: Record<string, number>; deadUntil: number; inbound: Side; rimTouched: boolean;
};
type Snapshot = GameState & { simulation: Runtime };
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
  type Body = { height: number; mass: number; strength: number; reach: number; leverage: number; acceleration: number };
  const bodies = new WeakMap<Player, Body>();
  function body(p: GamePlayer): Body {
    const profile = p.profile as Player & { weight?: number; ratings: Player['ratings'] & { strength?: number } };
    const cached = bodies.get(profile);
    if (cached) return cached;
    const positionIndex = ['PG', 'SG', 'SF', 'PF', 'C'].indexOf(profile.position);
    const typicalHeight = 1.88 + positionIndex * 0.055;
    const height = clamp(Number.isFinite(profile.height) && profile.height > 0 ? profile.height : typicalHeight, 1.55, 2.36);
    const typicalMass = (23.8 + positionIndex * 0.66) * height * height;
    const mass = clamp(Number.isFinite(profile.weight) && profile.weight! > 0 ? profile.weight! : typicalMass, 55, 165);
    const strength = clamp(Number.isFinite(profile.ratings.strength) ? profile.ratings.strength! : 55 + positionIndex * 6 + (mass - typicalMass) * 0.15, 25, 99);
    const result = { height, mass, strength, reach: height * 1.26,
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
  function follow(p: GamePlayer) {
    const s = sign(p.side);
    const crossover = (sim.locks[p.id + '/dribble'] ?? 0) - state.tick;
    const bounce = Math.abs(Math.sin(state.tick * (crossover > 30 ? 0.31 : 0.16)));
    state.ball.position = at(p.position.x + s * 0.28, 0.28 + bounce * 0.8, p.position.z + (crossover > 30 ? Math.sin(crossover * 0.2) * 0.42 : 0.2));
    state.ball.velocity = at(p.velocity.x, 0, p.velocity.z);
  }
  function hold(p: GamePlayer) {
    if (p.side !== state.possession) { state.shotClock = 24; sim.lastPass = null; sim.crossed = false; sim.backcourtTicks = 0; }
    state.possession = p.side;
    state.ball.kind = 'held';
    state.ball.ownerId = p.id;
    sim.flight = null;
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
  function dead(side: Side) {
    sim.deadUntil = state.tick + 38;
    sim.inbound = side;
    state.phase = 'dead';
    state.ball.ownerId = null;
    state.ball.kind = 'loose';
    state.charge = {};
    sim.flight = null;
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
    p.pose = charge ? 'shoot' : cmd?.contest ? 'contest' : cmd?.screen ? 'screen' : owner ? 'dribble' : norm > 0.08 ? 'run' : 'idle';
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
  function launch(p: GamePlayer, end: Vec3, duration: number, kind: 'shot' | 'pass', flight: Flight) {
    const start = at(p.position.x, kind === 'shot' ? body(p).reach - 0.08 : 1.45, p.position.z);
    state.ball = { kind, ownerId: null, position: start, velocity: at((end.x - start.x) / duration, (end.y - start.y) / duration + G * duration / 2, (end.z - start.z) / duration) };
    sim.flight = flight;
    state.charge[p.id] = 0;
  }
  function startFree(p: GamePlayer, attempts: number) {
    sim.free = { shooter: p.id, remaining: attempts, startTick: state.tick, waiting: true };
    dead(p.side);
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
    if (ft.waiting) { if (state.tick >= sim.deadUntil) lineUp(p); return; }
    if (state.ball.kind === 'shot') { progressBall(controls); return; }
    if (controls[p.id]?.shoot && state.tick - ft.startTick < 210) {
      state.charge[p.id] = Math.min(MAX_CHARGE, (state.charge[p.id] ?? 0) + DT); p.pose = 'shoot'; return;
    }
    const charge = state.charge[p.id] || 0;
    if (!charge && state.tick - ft.startTick < 108) return;
    const accuracy = charge ? clamp(1 - Math.abs(charge - IDEAL_RELEASE) * 2, 0, 1) : 0.72;
    const make = random() < 0.26 + p.profile.ratings.shooting * 0.005 + accuracy * 0.31;
    event('shot', p.side, p, { points: 1, detail: 'Free throw' });
    launch(p, at(sign(p.side) * COURT.rimX, COURT.rimHeight, make ? 0 : 0.42), 0.96, 'shot',
      { from: p.id, age: 0, duration: 0.96, points: 1, make, bounce: false });
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
    const precision = clamp(1 - Math.abs(charge - IDEAL_RELEASE) / 0.5, 0, 1);
    const rating = range < 3.2 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
    const chance = clamp(0.3 + rating * 0.004 + precision * 0.38 - range * 0.023 - pressure + postAdvantage - (100 - p.stamina) * 0.001, 0.025, 0.98);
    const three = range >= COURT.three || (Math.abs(p.position.z) >= 6.7 && p.position.x * sign(p.side) >= COURT.rimX - 2.7);
    const streetScoring = (settings as GameConfig & { scoring?: { inside: number; outside: number } }).scoring;
    const streetValue = three ? streetScoring?.outside ?? 2 : streetScoring?.inside ?? 1;
    const points = settings.mode === 'blacktop' ? clamp(Math.round(streetValue), 1, 10) : three ? 3 : 2;
    const make = random() < chance;
    const requested = (controls[p.id] as TacticalControl | undefined)?.shotType;
    const backwards = (controls[p.id]?.move.x ?? 0) * sign(p.side) < -0.55;
    const inside = range < 2.3;
    const style = requested ?? (inside ? (body(p).height >= 1.92 && controls[p.id]?.sprint ? 'dunk' : 'layup') :
      backwards ? 'fadeaway' : range < 4.4 && (p.profile.position === 'PF' || p.profile.position === 'C') ? 'hook' : range < 4.4 ? 'floater' : 'jump');
    const type = ({ dunk: inside ? 'Dunk' : 'Jump shot', layup: inside ? 'Layup' : 'Floater', floater: 'Floater', hook: 'Hook', fadeaway: 'Fadeaway', jump: 'Jump shot' })[style];
    if (type === 'Fadeaway') p.velocity.x -= sign(p.side) * 1.5;
    const timing = precision > 0.85 ? 'Excellent' : charge < IDEAL_RELEASE ? 'Early' : 'Late';
    if (settings.mode === 'regulation' && closest && controls[closest.id]?.contest && distance(closest.position, p.position) < 0.98 && random() < 0.085) {
      event('foul', closest.side, closest, { detail: 'Shooting foul · ' + points + ' free throws' });
      startFree(p, points); return;
    }
    event('shot', p.side, p, { points, detail: type + ' · ' + timing });
    if (closest && controls[closest.id]?.contest && distance(closest.position, p.position) < 1.12 + reachAdvantage(closest) * 0.42 && random() < clamp(0.12 + closest.profile.ratings.interior * 0.002 + reachAdvantage(closest) * 0.45, 0.04, 0.58)) {
      event('block', closest.side, closest);
      state.ball = { ownerId: null, position: at(p.position.x, 2.2, p.position.z), velocity: at(-sign(p.side) * 2.8, 2, (random() - 0.5) * 4), kind: 'loose' };
      sim.flight = null; state.charge[p.id] = 0; sim.rimTouched = false; return;
    }
    if (!make) { const angle = random() * Math.PI * 2; rim.x += Math.cos(angle) * 0.42; rim.z += Math.sin(angle) * 0.42; }
    const duration = type === 'Dunk' ? 0.35 : type === 'Layup' ? 0.54 : clamp(0.77 + range * 0.052 + (type === 'Floater' ? 0.24 : 0), 0.8, 1.75);
    launch(p, rim, duration, 'shot', { age: 0, from: p.id, duration, points, make, bounce: false });
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
    const duration = clamp(distance(p.position, target.position) / (lob ? 11 : 16) * (1.14 - p.profile.ratings.passing * 0.0016), 0.18, lob ? 1.4 : 1.05);
    const end = at(clamp(target.position.x + target.velocity.x * duration * 0.65, -LIMIT_X, LIMIT_X), 1.28, clamp(target.position.z + target.velocity.z * duration * 0.65, -LIMIT_Z, LIMIT_Z));
    launch(p, end, duration, 'pass', { from: p.id, target: target.id, age: 0, duration, points: 0, make: false, bounce });
    event('pass', p.side, p, { detail: cmd.passType ?? 'chest' });
  }
  function progressBall(controls: Readonly<Record<string, Control>>) {
    const ball = state.ball, f = sim.flight;
    const dt = f ? Math.min(DT, Math.max(0, f.duration - f.age)) : DT;
    ball.position.x += ball.velocity.x * dt; ball.position.z += ball.velocity.z * dt;
    ball.position.y += ball.velocity.y * dt - 0.5 * G * dt * dt; ball.velocity.y -= G * dt;
    if (f) f.age += dt;
    if (f?.bounce) {
      const t = f.age / f.duration;
      ball.position.y = t <= 0.55 ? 1.45 - 1.32 * t / 0.55 : 0.13 + 1.15 * (t - 0.55) / 0.45;
    }
    const shooter = f && state.players.find(p => p.id === f.from);
    if (f && shooter && ball.kind === 'shot' && f.age >= f.duration - 1e-8) {
      if (sim.free) {
        const ft = sim.free;
        if (f.make) { state.score[shooter.side]++; event('score', shooter.side, shooter, { points: 1, detail: 'Free throw' }); }
        else event('miss', shooter.side, shooter, { detail: 'Free throw' });
        ft.remaining--;
        if (ft.remaining > 0) { ft.waiting = true; dead(shooter.side); }
        else {
          delete sim.free;
          if (f.make) dead(opposite(shooter.side));
          else { sim.flight = null; sim.rimTouched = true; ball.kind = 'loose'; ball.velocity = at(-sign(shooter.side) * 2.4, 2.3, (random() - 0.5) * 3); state.shotClock = 14; }
        }
        return;
      }
      if (f.make) {
        state.score[shooter.side] += f.points;
        event('score', shooter.side, shooter, { points: f.points });
        const assist = sim.lastPass;
        if (assist?.to === shooter.id && state.tick - assist.tick < 300) {
          const helper = state.players.find(p => p.id === assist.from);
          if (helper) event('assist', helper.side, helper);
        }
        if (settings.mode === 'blacktop' && state.score[shooter.side] >= (settings.targetScore ?? 21)) { state.phase = 'final'; sim.flight = null; return; }
        dead(settings.mode === 'practice' || settings.makeItTakeIt ? shooter.side : opposite(shooter.side));
      } else {
        event('miss', shooter.side, shooter);
        ball.kind = 'loose'; sim.flight = null; sim.rimTouched = true;
        state.shotClock = Math.max(14, state.shotClock);
        ball.velocity = at((random() - 0.5) * 5.8 - sign(shooter.side) * 1.75, 2.1 + random(), (random() - 0.5) * 6.4);
      }
      return;
    }
    if (ball.kind === 'pass' && f && shooter) {
      const receiver = state.players.find(q => q.id === f.target);
      for (const q of state.players) {
        if (q.side === shooter.side || f.age < 0.09 || ball.position.y > body(q).reach || distance(q.position, ball.position) > (controls[q.id]?.steal ? 1.03 : 0.39)) continue;
        event('steal', q.side, q, { detail: 'Intercepted pass' }); event('turnover', shooter.side, shooter); hold(q); return;
      }
      if (receiver && f.age > f.duration * 0.35 && distance(receiver.position, ball.position) < 1.25 && ball.position.y < 2.6) {
        hold(receiver); sim.lastPass = { from: shooter.id, to: receiver.id, tick: state.tick };
        const hoop = { x: sign(receiver.side) * COURT.rimX, z: 0 };
        const passEvent = state.events.findLast(e => e.type === 'pass');
        if (passEvent?.detail === 'lob' && distance(receiver.position, hoop) < 2.15 && (controls[receiver.id]?.shoot || controls[receiver.id]?.sprint)) {
          shoot(receiver, IDEAL_RELEASE, controls);
          const attempt = state.events.findLast(e => e.type === 'shot' && e.tick === state.tick);
          if (attempt) attempt.detail = 'Alley-oop';
        }
        return;
      }
      if (f.age >= f.duration - 1e-8) { ball.kind = 'loose'; sim.flight = null; ball.velocity.x *= 0.5; ball.velocity.z *= 0.5; }
    }
    if (ball.kind !== 'loose') return;
    const board = COURT.rimX + 0.44;
    if (Math.abs(ball.position.z) < 0.91 && ball.position.y > 2.89 && ball.position.y < 3.96 && Math.abs(Math.abs(ball.position.x) - board) <= Math.abs(ball.velocity.x * dt) + 0.08 && ball.position.x * ball.velocity.x > 0) {
      ball.velocity.x *= -0.68; ball.position.x = Math.sign(ball.position.x) * (board - 0.1);
    }
    if (Math.abs(ball.position.x) > COURT.length / 2 || Math.abs(ball.position.z) > COURT.width / 2 || (half && ball.position.x < 0)) {
      event('turnover', state.possession, undefined, { detail: 'Out of bounds' }); dead(opposite(state.possession)); return;
    }
    if (ball.position.y < 0.13) { ball.position.y = 0.13; ball.velocity.y = Math.abs(ball.velocity.y) * 0.5; ball.velocity.x *= 0.76; ball.velocity.z *= 0.76; }
    const rim = { x: sign(state.possession) * COURT.rimX, z: 0 };
    function reboundPriority(p: GamePlayer) {
      const physique = body(p);
      const position = distance(p.position, ball.position);
      const braced = p.pose === 'screen' || p.pose === 'contest';
      // Inside position lets a player use their body to keep a nearby opponent off the glass.
      const boxOut = sim.rimTouched && braced && state.players.some(q =>
        q.side !== p.side && distance(p.position, q.position) < 1.35 && distance(p.position, rim) < distance(q.position, rim));
      return position - p.profile.ratings.rebounding * 0.005 - (physique.reach - 2.45) * 0.24 -
        (boxOut ? 0.23 * physique.leverage : 0);
    }
    const contender = state.players.filter(p => distance(p.position, ball.position) <= 1.02 + (body(p).reach - 2.45) * 0.24 &&
      ball.position.y < body(p).reach + (controls[p.id]?.contest ? 0.31 : -0.16))
      .sort((a, b) => reboundPriority(a) - reboundPriority(b))[0];
    if (contender) {
      if (sim.rimTouched) { event('rebound', contender.side, contender); if (contender.side === state.possession) state.shotClock = 14; }
      sim.rimTouched = false; sim.lastPass = null; hold(contender);
    }
  }
  function step(controls: Readonly<Record<string, Control>> = {}) {
    if (state.phase === 'final') return state;
    state.tick++;
    if (sim.free) { freeStep(controls); return state; }
    for (const p of state.players) {
      const action = controls[p.id] as TacticalControl | undefined;
      if (action?.substituteId && canAct(p.id + '/sub', 90)) {
        const bench = state.teams[p.side].roster.find(profile => profile.id === action.substituteId);
        if (bench && !state.players.some(q => q.side === p.side && q.profile.id === bench.id)) {
          const prev = p.id, owner = state.ball.ownerId === prev;
          if (sim.flight?.from === prev || sim.flight?.target === prev) continue;
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
    if (state.phase === 'dead') { if (state.tick >= sim.deadUntil) setup(sim.inbound); return state; }
    for (const p of state.players) move(p, controls[p.id]);
    separate();
    const owner = state.players.find(p => p.id === state.ball.ownerId);
    if (owner) {
      follow(owner);
      const cmd = controls[owner.id];
      if (cmd?.dribble && canAct(owner.id + '/dribble', 60)) owner.stamina = Math.max(0, owner.stamina - 1.2);
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
        if (q.side === owner.side || !controls[q.id]?.steal || !canAct(q.id + '/steal', 46) || distance(owner.position, q.position) > 1.45) continue;
        const roll = random();
        const skill = (q.profile.ratings.perimeter - owner.profile.ratings.handling) * 0.004;
        if (roll < 0.26 + skill - ((sim.locks[owner.id + '/dribble'] ?? 0) > state.tick + 30 ? 0.15 : 0)) {
          event('steal', q.side, q); event('turnover', owner.side, owner); hold(q); state.charge[owner.id] = 0; break;
        }
        if (roll > 0.94) { event('foul', q.side, q, { detail: 'Reach-in' }); dead(owner.side); break; }
      }
      if (state.ball.ownerId === owner.id) {
        if (cmd?.shoot) state.charge[owner.id] = Math.min(MAX_CHARGE, (state.charge[owner.id] ?? 0) + DT);
        else if (state.charge[owner.id] > 0) shoot(owner, state.charge[owner.id], controls);
        else if (cmd?.pass && canAct(owner.id + '/pass', 15)) pass(owner, cmd);
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
