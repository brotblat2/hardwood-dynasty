import { attackSign, COURT, TICK_RATE } from '../contracts/index.ts';
import type {
  BodyUpKind, Control, Engine, GameConfig, GameEvent, GamePlayer, GameState,
  Player, PlayerAction, ShotTimingGrade, ShotType, Side, Team, Vec2, Vec3,
} from '../contracts/index.ts';
import {
  advanceBall, BALL_RADIUS, bankVelocityFor, BOARD_HALF_DEPTH, BOARD_OFFSET,
  bouncePassVelocity, GRAVITY, RIM_CLEARANCE, vector as at, velocityFor,
} from './ball.ts';
import type { PhysicalBall } from './ball.ts';
import {
  applyDribbleMove, computeDribbleBallPose, createDribbleRuntime, selectDribbleMove,
} from './dribble.ts';
import type { DribbleRuntime, PlayerBody } from './dribble.ts';
import { computeShotContest, evaluateSteal, resolveBodyUp } from './defense.ts';
import {
  chooseShotStyle, computeGatherMotion, computeGreenWindow, shotReleasePoint,
} from './shooting.ts';
import type { GatherState } from './shooting.ts';

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

type ShotStyle = ShotType;
type BaseFlight = { from: string; age: number };
type ShotFlight = BaseFlight & { kind: 'shot'; points: number; throughRim?: boolean; andOne?: boolean; fouled?: boolean };
type PassFlight = BaseFlight & { kind: 'pass'; target: string; duration: number; bounce: boolean; lob: boolean; alleyOop?: boolean; floorTime?: number };
type Flight = ShotFlight | PassFlight;
type LegacyFlight = BaseFlight & { kind?: undefined; points: number; target?: string; duration: number; bounce: boolean };
type Runtime = {
  free?: { shooter: string; remaining: number; total?: number; startTick: number; waiting: boolean; andOne?: boolean };
  resumeClock?: number; timeouts?: [number, number]; crossed?: boolean; backcourtTicks?: number;
  seed: number; flight: Flight | null; lastPass: { from: string; to: string; tick: number } | null;
  locks: Record<string, number>; deadUntil: number; inbound: Side; rimTouched: boolean;
  pendingRebound?: boolean; deadBallMotion?: boolean; dribble?: DribbleRuntime; gather?: GatherState;
  release?: { playerId: string; until: number };
  releaseStyle?: { playerId: string; style: ShotStyle; until: number; peakJump: number };
  teamFouls?: [number, number];
  burst?: Record<string, number>;
  stun?: Record<string, number>;
  stumble?: Record<string, number>;
  flyBy?: Record<string, number>;
  jumpContest?: Record<string, number>;
  pumpFake?: Record<string, number>;
  stealPose?: Record<string, number>;
  lastDribble?: Record<string, number>;
  contestHeld?: Record<string, boolean>;
  intenseD?: Record<string, boolean>;
  postUp?: Record<string, boolean>;
  bodyUp?: Record<string, BodyUpKind>;
  prevMoveDir?: Record<string, Vec2>;
  streaks?: Record<string, number>;
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
      teamFouls: [0, 0], freeThrow: null, shotFeedback: null, callout: null, simulation: runtime };
  const sim = state.simulation;
  sim.teamFouls ??= state.teamFouls ?? [0, 0];
  const initialFlight = sim.flight as Flight | LegacyFlight | null;
  if (initialFlight && initialFlight.kind === undefined) {
    const { from, age, points, target, duration, bounce } = initialFlight;
    sim.flight = state.ball.kind === 'shot' ? { kind: 'shot', from, age, points } :
      state.ball.kind === 'pass' && target ? { kind: 'pass', from, age, target, duration, bounce, lob: false } : null;
  }
  const bodies = new WeakMap<Player, PlayerBody>();
  function body(p: GamePlayer): PlayerBody {
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
      sim.dribble = createDribbleRuntime(p.id, state.tick);
    const gather = sim.gather?.ownerId === p.id ? sim.gather : undefined;
    const charge = state.charge[p.id] || 0;
    if (charge > 0 && gather) {
      alignToHoop(p);
      const range = distance(p.position, { x: sign(p.side) * COURT.rimX, z: 0 });
      const reach = dunkReach(p, gather.approach);
      const style = chooseShotStyle(p, range, gather, dribble, reach, state.tick);
      if (sim.gather && !sim.gather.rhythm) {
        sim.gather.rhythm = dribble.lastMoveType === 'stepBack' && state.tick - dribble.lastMoveTick <= 36;
      }
      const motion = computeGatherMotion(p, physique, range, style, charge, gather, reach);
      ball.position = motion.ballPosition;
      ball.velocity = at(p.velocity.x, 0, p.velocity.z);
      ball.spin = at(0, 0, 0);
      delete ball.dribbleHand;
      return;
    }
    const nearestDef = state.players
      .filter(q => q.side !== p.side)
      .sort((a, b) => distance(a.position, p.position) - distance(b.position, p.position))[0];
    const nearestDefDist = nearestDef ? distance(nearestDef.position, p.position) : 99;
    if (control?.dribble && !dribble.held && !dribble.move && dribble.ballState !== 'dead' && canAct(p.id + '/dribble', 30)) {
      const rawDir = control.dribbleDir && Math.hypot(control.dribbleDir.x, control.dribbleDir.z) > 0.15
        ? control.dribbleDir
        : control.move;
      const rangeToRim = distance(p.position, { x: sign(p.side) * COURT.rimX, z: 0 });
      const spec = selectDribbleMove(p, dribble, rawDir, sign(p.side), nearestDef, rangeToRim);
      const res = applyDribbleMove(p, dribble, spec, state.tick, nearestDef, !!(nearestDef && sim.intenseD?.[nearestDef.id]), sign(p.side), random);
      if (spec.type !== 'jab') {
        sim.lastDribble ??= {};
        sim.lastDribble[p.id] = state.tick;
        sim.burst ??= {};
        sim.burst[p.id] = state.tick + 24;
      }
      if (res.stunnedDefId) {
        const def = state.players.find(q => q.id === res.stunnedDefId);
        if (res.stunTicks > 0) {
          sim.stun ??= {};
          sim.stun[res.stunnedDefId] = Math.max(sim.stun[res.stunnedDefId] ?? 0, state.tick + res.stunTicks);
        }
        if (res.stumbleTicks > 0) {
          sim.stumble ??= {};
          sim.stumble[res.stunnedDefId] = Math.max(sim.stumble[res.stunnedDefId] ?? 0, state.tick + res.stumbleTicks);
          if (def && !((sim.jumpContest?.[def.id] ?? 0) > state.tick)) def.pose = 'stumble';
        }
        if (res.isAnkleBreaker) {
          state.callout = { tick: state.tick, text: 'ANKLE BREAKER!', tone: 'gold', playerId: def?.id ?? p.id };
        }
      }
    }
    dribble.held = !!control?.dribble;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    const pose = computeDribbleBallPose(p, physique, dribble, speed, state.tick, nearestDefDist, DT);
    ball.position = pose.position;
    ball.velocity = pose.velocity;
    ball.spin = pose.spin;
    ball.dribbleHand = pose.dribbleHand;
  }
  function hold(p: GamePlayer) {
    if (p.side !== state.possession) { state.shotClock = 24; sim.lastPass = null; sim.crossed = false; sim.backcourtTicks = 0; }
    state.possession = p.side;
    state.ball.kind = 'held';
    state.ball.ownerId = p.id;
    sim.flight = null;
    delete sim.gather;
    sim.dribble = createDribbleRuntime(p.id, state.tick);
    sim.bodyUp = {};
    for (const q of state.players) delete q.action;
    sim.pendingRebound = false;
    follow(p);
  }
  function setup(side: Side) {
    const s = sign(side);
    const counters = [0, 0];
    sim.bodyUp = {};
    delete sim.releaseStyle;
    for (const p of state.players) {
      const slot = counters[p.side]++;
      const spot = shape[slot];
      const x = slot === 0 && half ? 3.8 : spot.x;
      p.position = { x: (x + (p.side !== side ? (slot === 0 ? 1.95 : 1.1) : 0)) * s, z: spot.z };
      p.velocity = { x: 0, z: 0 };
      p.facing = p.side === side ? (s === 1 ? 0 : Math.PI) : (s === 1 ? Math.PI : 0);
      p.pose = 'idle';
      delete p.action;
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
    sim.deadUntil = state.tick + 30;
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
    sim.bodyUp = {};
    for (const q of state.players) delete q.action;
    delete sim.releaseStyle;
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
    const owner = state.ball.ownerId === p.id;
    const dribble = owner && sim.dribble?.ownerId === p.id ? sim.dribble : undefined;
    const deadDribble = !!dribble && dribble.ballState === 'dead';
    const intenseD = !owner && !!(cmd?.intenseD);
    sim.intenseD ??= {};
    sim.intenseD[p.id] = intenseD;
    const hoopX = sign(p.side) * COURT.rimX;
    const rangeToRim = Math.hypot(hoopX - p.position.x, -p.position.z);
    const sprint = !!cmd?.sprint && norm > 0.1 && p.stamina > 8 && !intenseD && !deadDribble && !(owner && cmd?.postUp);
    const charge = owner && (cmd?.shoot || state.charge[p.id]);
    const settingScreen = !!cmd?.screen && !cmd?.callScreen;
    const posting = !!(owner && cmd?.postUp && !sprint && rangeToRim < 7.8 && !deadDribble);
    sim.postUp ??= {};
    sim.postUp[p.id] = posting;
    sim.contestHeld ??= {};
    const contesting = !!cmd?.contest;
    const wasContesting = !!sim.contestHeld[p.id];
    sim.contestHeld[p.id] = contesting;
    if (contesting && !wasContesting && canAct(p.id + '/contest', 30)) {
      sim.jumpContest ??= {};
      sim.jumpContest[p.id] = state.tick + 22;
      p.stamina = Math.max(0, p.stamina - 1.6);
    }
    if (dribble && dribble.ballState === 'tripleThreat' && norm > 0.35 && !cmd?.dribble && !charge && !cmd?.pumpFake && !posting) {
      dribble.ballState = 'live';
      if (dribble.adrenaline > 0) {
        sim.burst ??= {};
        sim.burst[p.id] = Math.max(sim.burst[p.id] ?? 0, state.tick + 16);
      }
    }
    let cutFactor = 1;
    sim.prevMoveDir ??= {};
    if (norm > 0.25) {
      const ux = dx / norm, uz = dz / norm;
      const prev = sim.prevMoveDir[p.id];
      if (prev) {
        const dot = prev.x * ux + prev.z * uz;
        if (dot < 0.2) cutFactor = clamp(0.74 + (dot + 1) * 0.15, 0.74, 0.92);
      }
      sim.prevMoveDir[p.id] = { x: ux, z: uz };
    }
    const staminaFactor = p.stamina < 35 ? 0.84 + (p.stamina / 35) * 0.16 : 1;
    const burstFactor = (sim.burst?.[p.id] ?? 0) > state.tick ? 1.18 : 1;
    const contestSlow = contesting ? 0.70 : 1;
    const intenseSlow = intenseD ? 0.84 : 1;
    const postSlow = posting ? 0.46 : 1;
    const stumbling = (sim.stumble?.[p.id] ?? 0) > state.tick;
    const stunned = (sim.stun?.[p.id] ?? 0) > state.tick;
    const flyBy = (sim.flyBy?.[p.id] ?? 0) > state.tick;
    const stunAccel = stunned ? 0.48 : stumbling ? 0.62 : flyBy ? 0.70 : 1;
    const bodyUp = sim.bodyUp?.[p.id];
    const bodyUpFactor = bodyUp === 'clamp' ? 0.56 : bodyUp === 'ride' ? 0.78 : bodyUp === 'blowby' ? 1.12 : 1;
    const deadFactor = deadDribble ? 0.14 : 1;
    const shotIntent = cmd?.shotType ?? sim.gather?.style ?? (rangeToRim < 2.45 && sprint ? 'dunk' : rangeToRim < 2.45 && norm > 0.45 ? 'layup' : undefined);
    const drivingFinish = !!(charge && (shotIntent === 'dunk' || shotIntent === 'layup' || shotIntent === 'euro'));
    const speed = (3.5 + p.profile.ratings.speed * 0.024) * staminaFactor * (sprint ? 1.46 : 1) * burstFactor *
      (owner ? 0.94 : 1) * (drivingFinish ? 0.68 : charge ? 0.24 : settingScreen ? 0.12 : contestSlow) * intenseSlow * postSlow * cutFactor * bodyUpFactor * deadFactor;
    const physique = body(p);
    p.stamina = clamp(p.stamina + DT * (sprint ? -7 * (physique.mass / 95) ** 0.3 : intenseD && norm > 0.1 ? -1.4 : 3.6), 0, 100);
    const accel = physique.acceleration * stunAccel;
    const moveRate = norm < 0.08 ? Math.min(0.62, accel * 1.75) : accel;
    p.velocity.x += (dx / Math.max(1, norm) * speed - p.velocity.x) * moveRate;
    p.velocity.z += (dz / Math.max(1, norm) * speed - p.velocity.z) * moveRate;
    const ballOwner = state.ball.ownerId ? state.players.find(q => q.id === state.ball.ownerId) : undefined;
    if (!owner && intenseD && ballOwner && ballOwner.id !== p.id && distance(p.position, ballOwner.position) < 2.6 && !stunned && !stumbling && !flyBy) {
      const defHoopX = sign(ballOwner.side) * COURT.rimX;
      const bhDist = Math.max(0.1, Math.hypot(defHoopX - ballOwner.position.x, -ballOwner.position.z));
      const idealX = ballOwner.position.x + ((defHoopX - ballOwner.position.x) / bhDist) * 0.85;
      const idealZ = ballOwner.position.z + (-ballOwner.position.z / bhDist) * 0.85;
      const toIdealX = idealX - p.position.x;
      const toIdealZ = idealZ - p.position.z;
      const steerAlign = norm < 0.15 ? 1 : (dx * toIdealX + dz * toIdealZ) / (norm * Math.max(0.05, Math.hypot(toIdealX, toIdealZ)));
      if (steerAlign > -0.15) {
        p.velocity.x += clamp(toIdealX * 2.4, -1.8, 1.8) * 0.12;
        p.velocity.z += clamp(toIdealZ * 2.4, -1.8, 1.8) * 0.12;
      }
    }
    if (charge && (shotIntent === 'fadeaway' || sim.gather?.backward)) {
      p.velocity.x -= sign(p.side) * 0.16;
    } else if (charge && shotIntent === 'stepBack') {
      p.velocity.x -= sign(p.side) * 0.18;
    } else if (charge && shotIntent === 'euro') {
      const ch = state.charge[p.id] || 0;
      const sideSign = p.position.z >= 0 ? -1 : 1;
      const zig = ch < 0.26 ? sideSign : -sideSign;
      p.velocity.z += zig * 0.14;
      p.velocity.x += sign(p.side) * 0.12;
    } else if (charge && (shotIntent === 'dunk' || shotIntent === 'layup') && (state.charge[p.id] || 0) < 0.36 &&
      rangeToRim > 0.65 && rangeToRim < 3.8 && (sim.gather?.approach ?? norm) >= 0.8) {
      const toRimUx = (hoopX - p.position.x) / rangeToRim;
      const toRimUz = -p.position.z / rangeToRim;
      const carrySpeed = Math.max(3.1, (sim.gather?.approach ?? 3.1) * 0.78);
      p.velocity.x += (toRimUx * carrySpeed - p.velocity.x) * 0.24;
      p.velocity.z += (toRimUz * carrySpeed - p.velocity.z) * 0.24;
    }
    p.position.x = clamp(p.position.x + p.velocity.x * DT, half ? 0.32 : -LIMIT_X, LIMIT_X);
    p.position.z = clamp(p.position.z + p.velocity.z * DT, -LIMIT_Z, LIMIT_Z);
    const sliding = !owner && p.side !== state.possession && norm > 0.08 && !sprint && state.ball.ownerId !== null && distance(p.position, state.ball.position) < 3.6;
    if (owner && posting && !charge) {
      const awayX = p.position.x - hoopX;
      const awayZ = p.position.z;
      if (Math.hypot(awayX, awayZ) > 0.05) p.facing = Math.atan2(awayZ, awayX);
    } else if (owner && ((rangeToRim < 11.5 && !sprint) || charge || dribble?.ballState === 'tripleThreat' ||
      dribble?.move?.type === 'stepBack' || dribble?.move?.type === 'hesitation')) {
      alignToHoop(p);
    } else if ((intenseD || sliding) && ballOwner && ballOwner.id !== p.id && distance(p.position, ballOwner.position) < 4.5) {
      const fx = ballOwner.position.x - p.position.x;
      const fz = ballOwner.position.z - p.position.z;
      if (Math.hypot(fx, fz) > 0.05) p.facing = Math.atan2(fz, fx);
    } else if (norm > 0.08) {
      p.facing = Math.atan2(dz, dx);
    }
    const released = sim.release?.playerId === p.id && sim.release.until > state.tick;
    const jumpContesting = (sim.jumpContest?.[p.id] ?? 0) > state.tick;
    const pumpFaking = (sim.pumpFake?.[p.id] ?? 0) > state.tick;
    const stealing = (sim.stealPose?.[p.id] ?? 0) > state.tick;
    p.pose = pumpFaking ? 'pumpFake'
      : stealing ? 'steal'
      : charge || released ? 'shoot'
      : contesting || jumpContesting ? 'contest'
      : flyBy ? 'flyBy'
      : stumbling ? 'stumble'
      : settingScreen ? 'screen'
      : bodyUp && bodyUp !== 'blowby' ? 'bodyUp'
      : posting ? 'postUp'
      : owner ? 'dribble'
      : intenseD || sliding ? 'slide'
      : norm > 0.08 ? 'run'
      : 'idle';
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
    const leverage = (p: GamePlayer) => body(p).leverage * (p.pose === 'screen' ? 3.2 : p.pose === 'postUp' || sim.postUp?.[p.id] ? 1.35 : 1);
    const aHold = leverage(a), bHold = leverage(b);
    return bHold / (aHold + bHold);
  }
  function launch(p: GamePlayer, start: Vec3, velocity: Vec3, spin: Vec3, flight: Flight, style?: ShotStyle, peakJump = 0.28) {
    state.ball = { kind: flight.kind, ownerId: null, position: start, velocity, spin };
    sim.flight = flight;
    state.charge[p.id] = 0;
    sim.rimTouched = false;
    sim.pendingRebound = false;
    delete sim.dribble;
    delete sim.gather;
    if (flight.kind === 'shot') {
      sim.release = { playerId: p.id, until: state.tick + 18 };
      if (style) {
        sim.releaseStyle = { playerId: p.id, style, until: state.tick + 28, peakJump };
      }
      p.pose = 'shoot';
    }
  }
  function dunkReach(p: GamePlayer, approach: number) {
    return body(p).reach + 0.37 + p.profile.ratings.finishing * 0.004 + Math.min(6, approach) * 0.024;
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
      const dribble = sim.dribble?.ownerId === p.id ? sim.dribble : undefined;
      const postShot = sim.postUp?.[p.id] && !control.shotType
        ? (control.move.x * sign(p.side) < -0.35 ? 'fadeaway' : 'hook')
        : undefined;
      sim.gather = {
        ownerId: p.id, height: state.ball.position.y,
        handOffset: (state.ball.dribbleHand ?? 1) * (0.25 + (body(p).wingspan - 1.85) * 0.14),
        approach: Math.hypot(p.velocity.x, p.velocity.z), sprint: !!control.sprint, backward: control.move.x * sign(p.side) < -0.55,
        rhythm: !!dribble && dribble.lastMoveType === 'stepBack' && state.tick - dribble.lastMoveTick <= 36,
        ...(postShot ? { style: postShot } : {}),
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
    if (state.ball.kind === 'shot') { progressBall(controls); syncActions(controls); return; }
    const control = controls[p.id];
    if (control?.shoot && state.tick - ft.startTick < 210) {
      chargeShot(p, { ...control, shotType: 'jump' }); p.pose = 'shoot'; syncActions(controls); return;
    }
    const charge = state.charge[p.id] || 0;
    if (!charge && state.tick - ft.startTick < 108) { syncActions(controls); return; }
    const error = charge ? charge - IDEAL_RELEASE : 0.045;
    alignToHoop(p);
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const start = shotReleasePoint(p, body(p), distance(p.position, rim), 'jump', dunkReach(p, 0));
    const spread = clamp(0.058 + (75 - p.profile.ratings.shooting) * 0.0008 + Math.abs(error) * 0.14, 0.025, 0.16);
    const end = aimAt(rim, start, random(), spread, error * 0.34);
    const velocity = velocityFor(start, end, 0.99);
    event('shot', p.side, p, { points: 1, detail: 'Free throw' });
    launch(p, start, velocity, backspin(velocity, 10), { kind: 'shot', from: p.id, age: 0, points: 1 }, 'jump', 0.05);
    syncActions(controls);
  }
  function shoot(p: GamePlayer, charge: number, controls: Readonly<Record<string, Control>>, detailOverride?: string) {
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const range = distance(p.position, rim);
    const defenders = state.players.filter(q => q.side !== p.side);
    const closest = defenders.reduce<GamePlayer | undefined>((a, q) => !a || distance(p.position, q.position) < distance(p.position, a.position) ? q : a, undefined);
    const reachAdvantage = (q: GamePlayer) => clamp(body(q).reach - body(p).reach, -0.65, 0.65);
    const isStunned = (q: GamePlayer) => (sim.stun?.[q.id] ?? 0) > state.tick || (sim.stumble?.[q.id] ?? 0) > state.tick;
    const isContesting = (q: GamePlayer) => !!controls[q.id]?.contest || (sim.jumpContest?.[q.id] ?? 0) > state.tick;
    const isFlyBy = (q: GamePlayer) => (sim.flyBy?.[q.id] ?? 0) > state.tick;
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
    const dribble = sim.dribble?.ownerId === p.id ? sim.dribble : undefined;
    const approach = gather?.approach ?? Math.hypot(p.velocity.x, p.velocity.z);
    const reach = dunkReach(p, approach);
    const gatherInput = {
      approach,
      style: cmd?.shotType ?? gather?.style,
      sprint: !!(cmd?.sprint || gather?.sprint),
      backward: (cmd?.move.x ?? 0) * sign(p.side) < -0.55 || !!gather?.backward,
    };
    const style = chooseShotStyle(p, range, gatherInput, dribble, reach, state.tick);
    const label = { dunk: 'Dunk', layup: 'Layup', floater: 'Floater', hook: 'Hook', fadeaway: 'Fadeaway', jump: 'Jump shot', stepBack: 'Step-back', euro: 'Euro step' }[style];
    if (style === 'fadeaway') p.velocity.x -= sign(p.side) * 1.5;
    if (style === 'stepBack') p.velocity.x -= sign(p.side) * 1.9;
    if (style === 'dunk') p.stamina = Math.max(0, p.stamina - 3.2);
    if (style === 'euro') p.stamina = Math.max(0, p.stamina - 1.4);
    const start = shotReleasePoint(p, body(p), range, style, reach);
    const contest = computeShotContest(
      p,
      body(p),
      start.y,
      rim,
      defenders,
      body,
      q => !!controls[q.id]?.contest,
      q => (sim.jumpContest?.[q.id] ?? 0) > state.tick,
      q => !!sim.intenseD?.[q.id],
      isStunned,
      isFlyBy,
      style,
    );
    const pressure = contest.pressure;
    const rating = range < 3.2 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
    const catchAndShoot = sim.lastPass?.to === p.id && state.tick - sim.lastPass.tick <= 45;
    const offDribble = (sim.lastDribble?.[p.id] ?? -999) >= state.tick - 34 && p.profile.ratings.handling >= 80;
    const rhythm = !!gather?.rhythm || (!!dribble && dribble.lastMoveType === 'stepBack' && state.tick - dribble.lastMoveTick <= 36);
    const hotStreak = (sim.streaks?.[p.id] ?? 0) >= 2;
    const { greenWindow, isGreen } = computeGreenWindow(rating, error, pressure, contact, catchAndShoot, rhythm, hotStreak);
    const timing: ShotTimingGrade = isGreen ? 'Green' : precision > 0.85 ? 'Excellent' :
      Math.abs(error) < 0.16 ? (error < 0 ? 'Slightly Early' : 'Slightly Late') : error < 0 ? 'Early' : 'Late';
    const contestLabel = contest.contestLevel;
    let andOneFoul = false;
    if (settings.mode === 'regulation' && closest && isContesting(closest) && distance(closest.position, p.position) < 0.98 && random() < 0.085) {
      sim.teamFouls ??= [0, 0];
      sim.teamFouls[closest.side]++;
      state.teamFouls = [...sim.teamFouls];
      const canAndOne = style !== 'jump' && style !== 'stepBack' && precision > 0.72 && (p.profile.ratings.finishing >= 80 || postAdvantage > 0.08);
      if (canAndOne && random() < 0.42) {
        andOneFoul = true;
      } else {
        event('foul', closest.side, closest, { detail: 'Shooting foul · ' + points + ' free throws' });
        startFree(p, points, false); return;
      }
    }
    alignToHoop(p);
    const gatherMotion = computeGatherMotion(p, body(p), range, style, charge, {
      ownerId: p.id,
      height: gather?.height ?? state.ball.position.y,
      handOffset: gather?.handOffset ?? 0.25,
      ...gatherInput,
      rhythm,
    }, reach);
    const finishErr = style === 'dunk' ? error * 0.28 : style === 'layup' || style === 'euro' ? error * 0.45 : error;
    const styleSpreadAdd = style === 'dunk' ? 0.036 : style === 'fadeaway' ? 0.079 : style === 'stepBack' ? 0.072 : style === 'euro' ? 0.064 : 0.061;
    let spread = clamp(styleSpreadAdd + (75 - rating) * 0.0011 + Math.max(0, range - 2) * 0.0046 +
      Math.max(0, range - 9.55) * 0.051 + pressure * 0.18 - postAdvantage * 0.92 + Math.abs(finishErr) * 0.22 + (100 - p.stamina) * 0.00072 +
      Math.hypot(p.velocity.x, p.velocity.z) * 0.004 + (andOneFoul ? 0.06 : 0), 0.024, 0.72);
    if (catchAndShoot) spread *= 0.82;
    if (offDribble) spread *= 0.90;
    if (rhythm) spread *= 0.88;
    if (isGreen) spread *= 0.34;
    const depthBias = finishErr * (style === 'dunk' ? 0.11 : 0.24 + range * 0.026) * (isGreen ? 0.25 : 1);
    const end = aimAt(rim, start, aimRoll, spread, depthBias);
    const duration = style === 'dunk' ? 0.34 : style === 'layup' || style === 'euro' ? 0.52 :
      clamp(0.78 + range * 0.063 + (style === 'floater' ? 0.22 : 0), 0.81, 2.34);
    let velocity = velocityFor(start, end, duration);
    let bank = false;
    if ((style === 'layup' || style === 'euro') && Math.abs(p.position.z) >= 0.72 && p.position.x * sign(p.side) < COURT.rimX - 0.2) {
      const boardFaceX = rim.x + sign(p.side) * (BOARD_OFFSET - BOARD_HALF_DEPTH - BALL_RADIUS);
      const bankShot = bankVelocityFor(start, end, boardFaceX, 0.72);
      if (bankShot) {
        velocity = bankShot.velocity;
        bank = true;
      }
    }
    const detailTiming = isGreen ? 'Excellent · Green' : timing;
    event('shot', p.side, p, { points, detail: detailOverride ?? (label + (bank ? ' (Bank)' : '') + ' · ' + detailTiming) });
    state.shotFeedback = {
      playerId: p.id, tick: state.tick, timing, contest: contestLabel, contestPct: contest.contestPct,
      style: label, grade: precision, green: isGreen, bank, rhythm, greenWindow,
    };
    if (andOneFoul && closest) {
      event('foul', closest.side, closest, { detail: 'Shooting foul · And-1 chance' });
      sim.pendingAndOne = { shooter: p.id, points };
    }
    const spin = backspin(velocity, style === 'dunk' ? 3 : style === 'layup' || style === 'euro' ? (bank ? 2 : 7) : 11);
    const blockMult = style === 'fadeaway' ? 0.55 : style === 'stepBack' ? 0.52 : style === 'floater' ? 0.58 : style === 'hook' ? 0.62 : 1;
    if (!andOneFoul && closest && isContesting(closest) && distance(closest.position, p.position) < 1.12 + reachAdvantage(closest) * 0.42 &&
      random() < clamp(0.12 + closest.profile.ratings.interior * 0.002 + reachAdvantage(closest) * 0.45, 0.04, 0.58) * blockMult * (isStunned(closest) ? 0.45 : 1)) {
      event('block', closest.side, closest);
      launch(p, start, at(-Math.cos(p.facing) * (1.5 + Math.abs(velocity.x) * 0.35), Math.max(-1.2, velocity.y * 0.35),
        -Math.sin(p.facing) * 1.5 + (random() - 0.5) * 3.4), backspin(velocity, -5), { kind: 'shot', from: p.id, points, age: 0 }, style, gatherMotion.jumpHeight);
      state.ball.kind = 'loose'; sim.flight = null; sim.pendingRebound = true;
      event('miss', p.side, p, { detail: 'Blocked' });
      return;
    }
    launch(p, start, velocity, spin, { kind: 'shot', from: p.id, age: 0, points, ...(andOneFoul ? { andOne: true, fouled: true } : {}) }, style, gatherMotion.jumpHeight);
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
      sim.streaks ??= {};
      sim.streaks[shooter.id] = (sim.streaks[shooter.id] ?? 0) + 1;
      event('score', shooter.side, shooter, { points: flight.points, ...(ft && { detail: 'Free throw' }) });
      // The net slows the ball as it falls through and continues moving after the whistle.
      const { velocity, spin } = state.ball;
      velocity.x *= 0.41; velocity.y *= 0.64; velocity.z *= 0.41;
      if (spin) { spin.x *= 0.65; spin.y *= 0.65; spin.z *= 0.65; }
    } else {
      if (sim.streaks) sim.streaks[shooter.id] = 0;
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
        const reachDist = controls[q.id]?.steal ? 1.08 : controls[q.id]?.contest ? 0.85 : 0.34;
        const d = distance(q.position, ball.position);
        if (ball.position.y > maxReachY || d > reachDist) continue;
        const cleanStealDist = controls[q.id]?.steal ? 0.78 : 0.28;
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
  function syncActions(controls: Readonly<Record<string, Control>>) {
    const owner = state.ball.ownerId ? state.players.find(q => q.id === state.ball.ownerId) : undefined;
    const dribble = owner && sim.dribble?.ownerId === owner.id ? sim.dribble : undefined;
    const gather = owner && sim.gather?.ownerId === owner.id ? sim.gather : undefined;
    const round3 = (v: number) => Math.round(v * 1000) / 1000 || 0;
    for (const p of state.players) {
      const action: PlayerAction = {};
      if (owner?.id === p.id && dribble) {
        if (dribble.move) {
          action.dribbleMove = dribble.move.type;
          action.moveProgress = round3(clamp((state.tick - dribble.move.started) / Math.max(1, dribble.move.duration), 0, 1));
          action.moveDir = dribble.move.dir;
        }
        action.ballState = dribble.ballState;
        action.adrenaline = dribble.adrenaline;
        if (dribble.ballState === 'dead') action.deadDribble = true;
      }
      const charge = state.charge[p.id] || 0;
      const cmd = controls[p.id];
      const rim = { x: sign(p.side) * COURT.rimX, z: 0 };
      const range = distance(p.position, rim);
      if (owner?.id === p.id && charge > 0 && gather) {
        const reach = dunkReach(p, gather.approach);
        const style = chooseShotStyle(p, range, gather, dribble, reach, state.tick);
        const gm = computeGatherMotion(p, body(p), range, style, charge, gather, reach);
        action.shotStyle = style;
        if (gm.gatherPhase > 0) action.gatherPhase = round3(gm.gatherPhase);
        if (gm.jumpHeight > 0.002) action.jumpHeight = round3(gm.jumpHeight);
      } else if (sim.releaseStyle?.playerId === p.id && sim.releaseStyle.until > state.tick) {
        action.shotStyle = sim.releaseStyle.style;
        const left = clamp((sim.releaseStyle.until - state.tick) / 28, 0, 1);
        const jh = sim.releaseStyle.peakJump * Math.sin(left * Math.PI * 0.5);
        if (jh > 0.002) action.jumpHeight = round3(jh);
      } else if ((sim.flyBy?.[p.id] ?? 0) > state.tick) {
        const left = clamp((sim.flyBy![p.id] - state.tick) / 24, 0, 1);
        const jh = 0.28 * Math.sin(left * Math.PI);
        if (jh > 0.002) action.jumpHeight = round3(jh);
      } else if ((sim.jumpContest?.[p.id] ?? 0) > state.tick) {
        const left = clamp((sim.jumpContest![p.id] - state.tick) / 22, 0, 1);
        const jh = 0.24 * Math.sin(left * Math.PI);
        if (jh > 0.002) action.jumpHeight = round3(jh);
      }
      if (cmd?.intenseD && owner?.id !== p.id) action.intenseD = true;
      if (sim.postUp?.[p.id]) action.postUp = true;
      const streak = sim.streaks?.[p.id] ?? 0;
      if (streak >= 2) action.hotStreak = streak;
      const bodyUp = sim.bodyUp?.[p.id];
      if (bodyUp) action.bodyUp = bodyUp;
      const stumbleUntil = sim.stumble?.[p.id] ?? 0;
      if (stumbleUntil > state.tick) action.stumble = round3(clamp((stumbleUntil - state.tick) / 28, 0, 1));
      const flyByUntil = sim.flyBy?.[p.id] ?? 0;
      if (flyByUntil > state.tick) action.flyBy = round3(clamp((flyByUntil - state.tick) / 24, 0, 1));
      if (Object.keys(action).length > 0) p.action = action;
      else delete p.action;
    }
    if (state.callout && state.tick - state.callout.tick > 90) state.callout = null;
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
    sim.bodyUp = {};
    const owner = state.players.find(p => p.id === state.ball.ownerId);
    if (owner) {
      if (!(state.charge[owner.id] > 0) && sim.dribble?.ownerId === owner.id) {
        const def = state.players
          .filter(q => q.side !== owner.side && !((sim.stun?.[q.id] ?? 0) > state.tick) && !((sim.flyBy?.[q.id] ?? 0) > state.tick))
          .sort((a, b) => distance(a.position, owner.position) - distance(b.position, owner.position))[0];
        const dribble = sim.dribble;
        if (def && distance(def.position, owner.position) < 1.05) {
          const burst = (sim.burst?.[owner.id] ?? 0) > state.tick;
          const bodyUpKind = resolveBodyUp(
            owner,
            def,
            body(owner),
            body(def),
            !!sim.intenseD?.[def.id],
            ((sim.stun?.[def.id] ?? 0) > state.tick) || ((sim.stumble?.[def.id] ?? 0) > state.tick),
            burst,
            dribble.move?.type,
            dribble.ballState,
          );
          if (bodyUpKind) {
            sim.bodyUp[owner.id] = bodyUpKind;
            sim.bodyUp[def.id] = bodyUpKind;
            const atk = sign(owner.side);
            if (bodyUpKind === 'clamp') {
              if (owner.velocity.x * atk > 0) owner.velocity.x *= 0.55;
              owner.velocity.z *= 0.65;
              def.velocity.x = owner.velocity.x * 0.5;
              def.velocity.z = owner.velocity.z * 0.7;
              if (dribble.ballState === 'live') {
                dribble.clampHits = (dribble.clampHits ?? 0) + 1;
                if (dribble.clampHits >= 20) {
                  dribble.ballState = 'dead';
                  dribble.move = undefined;
                  dribble.clampHits = 0;
                  state.callout = { tick: state.tick, text: 'CLAMPED!', tone: 'blue', playerId: def.id };
                }
              }
            } else if (bodyUpKind === 'ride') {
              owner.velocity.x *= 0.86;
              owner.velocity.z *= 0.90;
              dribble.clampHits = Math.max(0, (dribble.clampHits ?? 0) - 1);
            } else if (bodyUpKind === 'blowby') {
              owner.velocity.x += atk * 0.38;
              def.velocity.x *= 0.65;
              dribble.clampHits = 0;
            }
          } else {
            dribble.clampHits = Math.max(0, (dribble.clampHits ?? 0) - 1);
          }
        } else {
          dribble.clampHits = Math.max(0, (dribble.clampHits ?? 0) - 1);
        }
      }
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
        const outcome = evaluateSteal(q, owner, state.ball.position, sim.dribble, state.tick, random, !!sim.postUp?.[owner.id]);
        if (outcome === 'steal') {
          event('steal', q.side, q); event('turnover', owner.side, owner); hold(q); state.charge[owner.id] = 0; break;
        }
        if (outcome === 'poke') {
          event('turnover', owner.side, owner, { detail: 'Poked loose' });
          state.callout = { tick: state.tick, text: 'POKE LOOSE!', tone: 'blue', playerId: q.id };
          state.ball = {
            kind: 'loose',
            ownerId: null,
            position: { ...state.ball.position },
            velocity: at((q.position.x - owner.position.x) * -2.2 + (random() - 0.5) * 2.4, 2.1, (q.position.z - owner.position.z) * -2.2 + (random() - 0.5) * 2.4),
            spin: at(0, 0, 0),
          };
          sim.flight = null;
          delete sim.dribble;
          delete sim.gather;
          state.charge[owner.id] = 0;
          sim.stun ??= {};
          sim.stun[owner.id] = state.tick + 16;
          break;
        }
        if (outcome === 'foul') {
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
        sim.stun ??= {};
        sim.stun[q.id] = state.tick + 16;
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
          if (sim.dribble?.ownerId === owner.id && sim.dribble.ballState === 'live') {
            sim.dribble.ballState = 'dead';
            sim.dribble.move = undefined;
            state.callout = { tick: state.tick, text: 'PICKUP!', tone: 'red', playerId: owner.id };
          }
          for (const def of state.players) {
            if (def.side === owner.side) continue;
            const d = distance(def.position, owner.position);
            const biting = controls[def.id]?.contest || (sim.jumpContest?.[def.id] ?? 0) > state.tick;
            if (d < 2.1 && (biting || (d < 1.55 && random() < clamp(0.45 - (def.profile.ratings.iq - 70) * 0.008, 0.15, 0.65)))) {
              sim.jumpContest ??= {};
              sim.jumpContest[def.id] = state.tick + 26;
              sim.flyBy ??= {};
              sim.flyBy[def.id] = state.tick + 24;
              sim.stun ??= {};
              sim.stun[def.id] = state.tick + 28;
              const toShooterX = d > 0.05 ? (owner.position.x - def.position.x) / d : -Math.cos(def.facing);
              const toShooterZ = d > 0.05 ? (owner.position.z - def.position.z) / d : -Math.sin(def.facing);
              def.velocity.x += toShooterX * 2.4;
              def.velocity.z += toShooterZ * 2.4;
              state.callout = { tick: state.tick, text: 'FLY-BY!', tone: 'green', playerId: def.id };
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
    syncActions(controls);
    return state;
  }
  return { state, step };
}
