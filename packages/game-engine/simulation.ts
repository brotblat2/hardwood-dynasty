import { attackSign, COURT, TICK_RATE } from '../contracts/index.ts';
import type {
  Control, Engine, GameConfig, GameEvent, GamePlayer, GameState,
  Player, PlayerAction, ShotTimingGrade, ShotType, Side, Team, Vec2, Vec3,
} from '../contracts/index.ts';
import { computeShotContest, evaluateBlock, evaluateSteal, jumpApexQuality, resolveBodyUp } from './defense.ts';
import {
  applyDribbleMove, canCancelMove, canLaunchOutOfMove, commitMoveHand,
  computeDribbleBallPose, createDribbleRuntime, selectDribbleMove,
} from './dribble.ts';
import { clearPlayerBuffer, consumeBuffered, recordControlEdges } from './input-buffer.ts';
import { checkLiveBallCollisions } from './live-ball.ts';
import { computePlayerBody, separatePlayers, stepPlayerMovement } from './movement.ts';
import {
  advanceBall, BALL_RADIUS, bankVelocityFor, BOARD_HALF_DEPTH, BOARD_OFFSET,
  RIM_CLEARANCE, solveShotVelocity, vector as at,
} from './physics-ball.ts';
import {
  checkPassLaneCollisions, computePassLaunch, pickAutoPassTarget, selectPassTarget,
} from './passing.ts';
import { resolveLooseBall, stepBoxOuts } from './rebounding.ts';
import {
  chooseShotStyle, computeGatherMotion, computeGreenWindow,
  computeShotMeterState, idealReleaseFor, SHOT_LABELS, shotReleasePoint,
} from './shooting.ts';
import {
  clamp, distance, DT, IDEAL_RELEASE, LIMIT_X, LIMIT_Z, MAX_CHARGE, opposite,
} from './types.ts';
import type {
  Flight, LegacyFlight, PhysicalBall, PlayerBody, Runtime, ShotFlight, Snapshot,
} from './types.ts';

const shape: Vec2[] = [
  { x: -5.6, z: 0 },
  { x: 3.4, z: -5.8 },
  { x: 4.4, z: 5.8 },
  { x: 6.4, z: -2.6 },
  { x: 7.2, z: 2.2 },
];

export function createSimulationEngine(
  teams: [Team, Team],
  config: GameConfig = {},
  initialState?: GameState,
): Engine {
  const settings = {
    mode: 'regulation',
    periods: 4,
    periodSeconds: 300,
    playersPerTeam: 5,
    seed: 17,
    ...initialState?.config,
    ...config,
  } satisfies GameConfig;
  const half = settings.halfCourt ?? settings.mode === 'blacktop';
  const sign = (side: Side) => (half ? 1 : attackSign(side));

  const runtime: Runtime = {
    seed: settings.seed >>> 0,
    flight: null,
    lastPass: null,
    locks: {},
    deadUntil: 0,
    inbound: 0,
    rimTouched: false,
    teamFouls: [0, 0],
  };

  const state: Snapshot = initialState
    ? Object.assign({ simulation: runtime }, structuredClone(initialState), { config: settings })
    : {
      teams,
      config: settings,
      tick: 0,
      period: 1,
      clock: settings.periodSeconds,
      shotClock: 24,
      phase: 'live',
      score: [0, 0],
      possession: 0,
      players: [],
      ball: { position: at(0, 1, 0), velocity: at(0, 0, 0), kind: 'held', ownerId: null },
      charge: {},
      events: [],
      teamFouls: [0, 0],
      freeThrow: null,
      shotFeedback: null,
      shotMeter: null,
      callout: null,
      simulation: runtime,
    };

  const sim = state.simulation;
  sim.teamFouls ??= state.teamFouls ?? [0, 0];
  const initialFlight = sim.flight as Flight | LegacyFlight | null;
  if (initialFlight && initialFlight.kind === undefined) {
    const { from, age, points, target, duration, bounce } = initialFlight;
    sim.flight = state.ball.kind === 'shot'
      ? { kind: 'shot', from, age, points }
      : state.ball.kind === 'pass' && target
        ? { kind: 'pass', from, age, target, duration, bounce, lob: false }
        : null;
  }

  const bodies = new WeakMap<Player, PlayerBody>();
  const body = (p: GamePlayer): PlayerBody => computePlayerBody(p.profile, bodies);

  function random() {
    sim.seed = (Math.imul(sim.seed, 1664525) + 1013904223) >>> 0;
    return sim.seed / 4294967296;
  }

  function event(type: GameEvent['type'], side: Side, player?: GamePlayer, extra?: Partial<GameEvent>) {
    state.events.push({
      tick: state.tick,
      type,
      side,
      ...(player && { playerId: player.id, position: { ...player.position } }),
      ...extra,
    });
  }

  function localBall(p: GamePlayer, forward: number, side: number, height: number) {
    const x = Math.cos(p.facing);
    const z = Math.sin(p.facing);
    return at(p.position.x + x * forward + z * side, height, p.position.z + z * forward - x * side);
  }

  function alignToHoop(p: GamePlayer) {
    const x = sign(p.side) * COURT.rimX - p.position.x;
    if (Math.hypot(x, p.position.z) > 0.05) p.facing = Math.atan2(-p.position.z, x);
  }

  function canAct(key: string, cooldown: number) {
    if ((sim.locks[key] ?? 0) > state.tick) return false;
    sim.locks[key] = state.tick + cooldown;
    return true;
  }

  function hasPaintRimDefender(p: GamePlayer, rim: Vec2): boolean {
    const rimDist = Math.max(0.05, distance(p.position, rim));
    const ux = (rim.x - p.position.x) / rimDist;
    const uz = (rim.z - p.position.z) / rimDist;
    return state.players.some(q => {
      if (q.side === p.side) return false;
      const d = distance(q.position, p.position);
      if (d > 1.55) return false;
      const dot = ((q.position.x - p.position.x) * ux + (q.position.z - p.position.z) * uz) / Math.max(0.05, d);
      return dot > 0.28 || distance(q.position, rim) < 1.65;
    });
  }

  function follow(p: GamePlayer, control?: Control, controls: Readonly<Record<string, Control>> = {}) {
    const ball = state.ball;
    const physique = body(p);
    const dribble = sim.dribble?.ownerId === p.id
      ? sim.dribble
      : (sim.dribble = createDribbleRuntime(p.id, state.tick));
    const gather = sim.gather?.ownerId === p.id ? sim.gather : undefined;
    const charge = state.charge[p.id] || 0;
    const rim = { x: sign(p.side) * COURT.rimX, z: 0 };

    if (charge > 0 && gather) {
      alignToHoop(p);
      const range = distance(p.position, rim);
      const reach = dunkReach(p, gather.approach);
      const defenders = state.players.filter(q => q.side !== p.side);
      const nearestDef = defenders.reduce<GamePlayer | undefined>(
        (best, q) => (!best || distance(q.position, p.position) < distance(best.position, p.position) ? q : best),
        undefined,
      );
      const nearestDist = nearestDef ? distance(nearestDef.position, p.position) : 99;
      const style = chooseShotStyle(p, range, gather, dribble, reach, state.tick, nearestDist, hasPaintRimDefender(p, rim));
      gather.idealRelease ??= idealReleaseFor(style, !!gather.driving);
      if (sim.gather && !sim.gather.rhythm) {
        sim.gather.rhythm = (dribble.lastMoveType === 'stepBack' || dribble.lastMoveType === 'snatchBack') &&
          state.tick - dribble.lastMoveTick <= 36;
      }
      const motion = computeGatherMotion(p, physique, range, style, charge, gather, reach);
      ball.position = motion.ballPosition;
      ball.velocity = at(p.velocity.x, 0, p.velocity.z);
      ball.spin = at(0, 0, 0);
      delete ball.dribbleHand;
      dribble.lastBallPos = { ...ball.position };
      return;
    }

    const defenders = state.players.filter(q => q.side !== p.side);
    const nearestDef = defenders
      .slice()
      .sort((a, b) => distance(a.position, p.position) - distance(b.position, p.position))[0];

    // Animation cancel: sprint launch out of a dribble move once past its launch window.
    if (dribble.move && control?.sprint && canLaunchOutOfMove(dribble, state.tick)) {
      const moveSpeed = Math.hypot(control.move?.x ?? 0, control.move?.z ?? 0);
      if (moveSpeed > 0.45) {
        commitMoveHand(dribble, state.tick);
        if (dribble.adrenaline > 0) {
          sim.burst ??= {};
          sim.burst[p.id] = Math.max(sim.burst[p.id] ?? 0, state.tick + 16);
        }
      }
    }

    // Dribble combo trigger via direct edge OR 150ms buffered press, supporting branching at cancelAfter.
    const bufferedDribble = dribble.ballState !== 'dead' && canCancelMove(dribble, state.tick) &&
      (state.tick - dribble.lastMoveTick >= 8 || !dribble.move)
      ? consumeBuffered(sim, p.id, 'dribble', state.tick)
      : undefined;

    if (bufferedDribble) {
      const rawDir = bufferedDribble.dir
        ?? (control?.dribbleDir && Math.hypot(control.dribbleDir.x, control.dribbleDir.z) > 0.15
          ? control.dribbleDir
          : control?.move ?? { x: 0, z: 0 });
      const rangeToRim = distance(p.position, rim);
      const spec = selectDribbleMove(p, dribble, rawDir, sign(p.side), nearestDef, rangeToRim);
      const res = applyDribbleMove(
        p,
        dribble,
        spec,
        state.tick,
        nearestDef,
        !!(nearestDef && sim.intenseD?.[nearestDef.id]),
        sign(p.side),
        random,
      );
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
    const prevBallPos = dribble.lastBallPos ? { ...dribble.lastBallPos } : undefined;
    const pose = computeDribbleBallPose(p, physique, dribble, speed, state.tick, nearestDef, !!control?.sprint, DT);
    ball.position = pose.position;
    ball.velocity = pose.velocity;
    ball.spin = pose.spin;
    ball.dribbleHand = pose.dribbleHand;
    dribble.lastBallPos = { ...pose.position };

    // Live-ball physical collision check against defender hips, knees, and reaching hands.
    if (dribble.ballState === 'live' && state.phase === 'live' && !sim.free) {
      const collision = checkLiveBallCollisions(
        p,
        dribble,
        prevBallPos,
        pose.position,
        defenders,
        controls,
        body,
        state.tick,
        random,
        sim,
      );
      if (collision.kind === 'steal') {
        event('steal', collision.defender.side, collision.defender);
        event('turnover', p.side, p);
        hold(collision.defender);
        state.charge[p.id] = 0;
        return;
      }
      if (collision.kind === 'loose') {
        event('turnover', p.side, p, { detail: collision.reason === 'bump' ? 'Bump loose' : 'Poked loose' });
        state.callout = {
          tick: state.tick,
          text: collision.reason === 'bump' ? 'BUMP LOOSE!' : 'POKE LOOSE!',
          tone: 'blue',
          playerId: collision.defender.id,
        };
        sim.lastLooseTouch = collision.defender.side;
        state.ball = {
          kind: 'loose',
          ownerId: null,
          position: { ...pose.position },
          velocity: collision.velocity,
          spin: at(collision.velocity.z * 2, 0, -collision.velocity.x * 2),
        };
        sim.flight = null;
        delete sim.dribble;
        delete sim.gather;
        state.charge[p.id] = 0;
        sim.stun ??= {};
        sim.stun[p.id] = state.tick + 14;
        clearPlayerBuffer(sim, p.id);
        return;
      }
      if (collision.kind === 'bobble') {
        dribble.bobbleTicks = state.tick + 12;
        p.stamina = Math.max(0, p.stamina - 1.5);
      }
    }
  }

  function hold(p: GamePlayer) {
    if (p.side !== state.possession) {
      state.shotClock = 24;
      sim.lastPass = null;
      sim.crossed = false;
      sim.backcourtTicks = 0;
    }
    state.possession = p.side;
    state.ball.kind = 'held';
    state.ball.ownerId = p.id;
    sim.flight = null;
    delete sim.gather;
    sim.dribble = createDribbleRuntime(p.id, state.tick);
    sim.bodyUp = {};
    sim.boxOut = {};
    delete sim.lastLooseTouch;
    state.shotMeter = null;
    for (const q of state.players) delete q.action;
    sim.pendingRebound = false;
    clearPlayerBuffer(sim, p.id);
    follow(p);
  }

  function setup(side: Side) {
    const s = sign(side);
    sim.bodyUp = {};
    sim.boxOut = {};
    delete sim.lastLooseTouch;
    delete sim.releaseStyle;
    delete sim.passStyle;
    state.shotMeter = null;
    let ballOwner: GamePlayer | undefined;
    for (const pSide of [0, 1] as const) {
      const teamPlayers = state.players.filter(p => p.side === pSide);
      if (!teamPlayers.length) continue;
      let pg = teamPlayers.find(p => p.profile.position === 'PG');
      if (!pg) {
        pg = [...teamPlayers].sort((a, b) =>
          (b.profile.ratings.handling + b.profile.ratings.passing) - (a.profile.ratings.handling + a.profile.ratings.passing),
        )[0];
      }
      const ordered = [pg, ...teamPlayers.filter(p => p !== pg)];
      ordered.forEach((p, slot) => {
        const spot = shape[Math.min(slot, shape.length - 1)];
        const x = slot === 0 && half ? 3.8 : spot.x;
        const cushion = p.side !== side ? (slot === 0 ? (half ? 1.95 : 3.2) : 1.15) : 0;
        p.position = { x: (x + cushion) * s, z: spot.z };
        p.velocity = { x: 0, z: 0 };
        p.facing = p.side === side ? (s === 1 ? 0 : Math.PI) : (s === 1 ? Math.PI : 0);
        p.pose = 'idle';
        delete p.action;
        clearPlayerBuffer(sim, p.id);
      });
      if (pSide === side) ballOwner = ordered[0];
    }
    hold(ballOwner ?? state.players[0]);
    state.shotClock = sim.resumeClock ?? 24;
    delete sim.resumeClock;
    state.charge = {};
    sim.lastPass = null;
    sim.rimTouched = false;
    sim.crossed = false;
    sim.backcourtTicks = 0;
    state.phase = 'live';
    delete sim.deadBallMotion;
  }

  if (!initialState) {
    const count = clamp(Math.floor(settings.playersPerTeam), 1, 5);
    for (const side of [0, 1] as const) {
      for (const profile of teams[side].roster.slice(0, count)) {
        const id = state.players.some(p => p.id === profile.id) ? `${side}:${profile.id}` : profile.id;
        state.players.push({
          id,
          profile,
          side,
          position: { x: 0, z: 0 },
          velocity: { x: 0, z: 0 },
          facing: 0,
          stamina: 100,
          pose: 'idle',
        });
      }
    }
    if (!state.players.length || !teams[0].roster.length || !teams[1].roster.length) {
      throw Error('Each team needs at least one player');
    }
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
    state.shotMeter = null;
    sim.flight = null;
    sim.deadBallMotion = animateBall;
    sim.pendingRebound = false;
    sim.rimTouched = false;
    sim.bodyUp = {};
    sim.boxOut = {};
    delete sim.lastLooseTouch;
    for (const q of state.players) {
      delete q.action;
      clearPlayerBuffer(sim, q.id);
    }
    delete sim.releaseStyle;
    delete sim.passStyle;
    delete sim.gather;
    delete sim.dribble;
  }

  function launch(p: GamePlayer, start: Vec3, velocity: Vec3, spin: Vec3, flight: Flight, style?: ShotType, peakJump = 0.28) {
    state.ball = { kind: flight.kind, ownerId: null, position: start, velocity, spin };
    sim.flight = flight;
    state.charge[p.id] = 0;
    state.shotMeter = null;
    sim.rimTouched = false;
    sim.pendingRebound = false;
    sim.boxOut = {};
    delete sim.lastLooseTouch;
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
    sim.free = {
      shooter: p.id,
      remaining: attempts,
      total: attempts,
      startTick: state.tick,
      waiting: true,
      ...(andOne ? { andOne: true } : {}),
    };
    state.freeThrow = {
      shooterId: p.id,
      remaining: attempts,
      total: attempts,
      ...(andOne ? { andOne: true } : {}),
    };
    dead(p.side);
  }

  function chargeShot(p: GamePlayer, control: Control, controls: Readonly<Record<string, Control>>) {
    if (sim.gather?.ownerId !== p.id) {
      const dribble = sim.dribble?.ownerId === p.id ? sim.dribble : undefined;
      let cancelRhythm = false;
      if (dribble?.move) {
        const canceledType = dribble.move.type;
        if (canceledType === 'stepBack' || canceledType === 'snatchBack' || canceledType === 'hesitation' ||
          canceledType === 'crossover' || canceledType === 'inAndOut') {
          cancelRhythm = true;
        }
        commitMoveHand(dribble, state.tick);
      }
      const postShot = sim.postUp?.[p.id] && !control.shotType
        ? (control.move.x * sign(p.side) < -0.35 ? 'fadeaway' : 'hook')
        : undefined;
      const approach = Math.hypot(p.velocity.x, p.velocity.z);
      const rim = { x: sign(p.side) * COURT.rimX, z: 0 };
      const range = distance(p.position, rim);
      const driving = approach >= 2.3 && range < 3.6;
      const baseHandOffset = (state.ball.dribbleHand ?? dribble?.hand ?? 1) * (0.25 + (body(p).wingspan - 1.85) * 0.14);
      const backward = control.move.x * sign(p.side) < -0.55;
      const rhythm = cancelRhythm ||
        (!!dribble && (dribble.lastMoveType === 'stepBack' || dribble.lastMoveType === 'snatchBack') &&
          state.tick - dribble.lastMoveTick <= 36);
      const style = chooseShotStyle(
        p,
        range,
        { style: control.shotType ?? postShot, approach, sprint: !!control.sprint, backward },
        dribble,
        dunkReach(p, approach),
        state.tick,
        undefined,
        hasPaintRimDefender(p, rim),
      );

      sim.gather = {
        ownerId: p.id,
        height: state.ball.position.y,
        handOffset: baseHandOffset,
        approach,
        sprint: !!control.sprint,
        backward,
        driving,
        idealRelease: idealReleaseFor(style, driving),
        rhythm,
        ...(postShot ? { style: postShot } : {}),
      };
    }
    if (control.shotType) {
      sim.gather.style = control.shotType;
      sim.gather.idealRelease = idealReleaseFor(control.shotType, !!sim.gather.driving);
    }
    state.charge[p.id] = Math.min(MAX_CHARGE, (state.charge[p.id] ?? 0) + DT);
    follow(p, control, controls);
  }

  function lineUp(p: GamePlayer) {
    setup(p.side);
    p.position = { x: sign(p.side) * (COURT.rimX - 4.6), z: 0 };
    state.players.filter(q => q.id !== p.id).forEach((q, i) => {
      q.position = {
        x: sign(p.side) * (COURT.rimX - 1.6 - Math.floor(i / 2) * 1.15),
        z: (i % 2 ? -1 : 1) * 3,
      };
    });
    hold(p);
    sim.free!.waiting = false;
    sim.free!.startTick = state.tick;
  }

  function freeStep(controls: Readonly<Record<string, Control>>) {
    const ft = sim.free!;
    const p = state.players.find(q => q.id === ft.shooter)!;
    if (ft.waiting) {
      if (state.tick >= sim.deadUntil) lineUp(p);
      else if (sim.deadBallMotion) advanceBall(state.ball, DT, half);
      return;
    }
    if (state.ball.kind === 'shot') {
      progressBall(controls);
      syncActions(controls);
      return;
    }
    const control = controls[p.id];
    if (control?.shoot && state.tick - ft.startTick < 210) {
      chargeShot(p, { ...control, shotType: 'jump' }, controls);
      p.pose = 'shoot';
      syncActions(controls);
      return;
    }
    const charge = state.charge[p.id] || 0;
    if (!charge && state.tick - ft.startTick < 108) {
      syncActions(controls);
      return;
    }
    const error = charge ? charge - IDEAL_RELEASE : 0.045;
    alignToHoop(p);
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const start = shotReleasePoint(p, body(p), distance(p.position, rim), 'jump', dunkReach(p, 0));
    const spread = clamp(0.058 + (75 - p.profile.ratings.shooting) * 0.0008 + Math.abs(error) * 0.14, 0.025, 0.16);
    const end = aimAt(rim, start, random(), spread, error * 0.34);
    const spin = backspin(at(end.x - start.x, 0, end.z - start.z), 10);
    const velocity = solveShotVelocity(start, end, 0.99, spin);
    event('shot', p.side, p, { points: 1, detail: 'Free throw' });
    launch(p, start, velocity, spin, { kind: 'shot', from: p.id, age: 0, points: 1 }, 'jump', 0.05);
    syncActions(controls);
  }

  function shoot(p: GamePlayer, charge: number, controls: Readonly<Record<string, Control>>, detailOverride?: string) {
    const rim = at(sign(p.side) * COURT.rimX, COURT.rimHeight, 0);
    const range = distance(p.position, rim);
    const defenders = state.players.filter(q => q.side !== p.side);
    const closest = defenders.reduce<GamePlayer | undefined>(
      (a, q) => (!a || distance(p.position, q.position) < distance(p.position, a.position) ? q : a),
      undefined,
    );
    const reachAdvantage = (q: GamePlayer) => clamp(body(q).reach - body(p).reach, -0.65, 0.65);
    const isStunned = (q: GamePlayer) => (sim.stun?.[q.id] ?? 0) > state.tick || (sim.stumble?.[q.id] ?? 0) > state.tick;
    const isContesting = (q: GamePlayer) => !!controls[q.id]?.contest || (sim.jumpContest?.[q.id] ?? 0) > state.tick;
    const isHandsUp = (q: GamePlayer) => !!sim.handsUp?.[q.id] && !((sim.jumpContest?.[q.id] ?? 0) > state.tick);
    const getJumpQuality = (q: GamePlayer) => jumpApexQuality(sim.jumpContestStart?.[q.id], state.tick, !!controls[q.id]?.contest);
    const isFlyBy = (q: GamePlayer) => (sim.flyBy?.[q.id] ?? 0) > state.tick;
    const contact = range < 3.2 && closest ? clamp(1 - distance(closest.position, p.position) / 1.55, 0, 1) : 0;
    const postAdvantage = closest ? clamp(body(p).leverage - body(closest).leverage, -0.8, 0.8) * contact * 0.24 : 0;
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
    const nearestDist = closest ? distance(closest.position, p.position) : 99;
    const style = chooseShotStyle(
      p,
      range,
      gatherInput,
      dribble,
      reach,
      state.tick,
      nearestDist,
      hasPaintRimDefender(p, rim),
    );
    const driving = !!gather?.driving || (approach >= 2.3 && range < 3.6);
    const ideal = gather?.idealRelease ?? idealReleaseFor(style, driving);
    const error = charge - ideal;
    const precision = clamp(1 - Math.abs(error) / 0.5, 0, 1);
    const label = SHOT_LABELS[style];

    if (style === 'fadeaway') p.velocity.x -= sign(p.side) * 1.5;
    if (style === 'stepBack') p.velocity.x -= sign(p.side) * 1.9;
    if (style === 'dunk' || style === 'contactDunk') p.stamina = Math.max(0, p.stamina - (style === 'contactDunk' ? 4.0 : 3.2));
    if (style === 'euro' || style === 'reverseLayup') p.stamina = Math.max(0, p.stamina - 1.4);

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
      isHandsUp,
      getJumpQuality,
    );
    const pressure = contest.pressure;
    const rating = range < 3.2 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
    const catchAndShoot = sim.lastPass?.to === p.id && state.tick - sim.lastPass.tick <= 45;
    const offDribble = (sim.lastDribble?.[p.id] ?? -999) >= state.tick - 34 && p.profile.ratings.handling >= 80;
    const rhythm = !!gather?.rhythm ||
      (!!dribble && (dribble.lastMoveType === 'stepBack' || dribble.lastMoveType === 'snatchBack') &&
        state.tick - dribble.lastMoveTick <= 36);
    const hotStreak = (sim.streaks?.[p.id] ?? 0) >= 2;
    const { greenWindow, isGreen } = computeGreenWindow(
      rating,
      error,
      pressure,
      contact,
      catchAndShoot,
      rhythm,
      hotStreak,
      p.stamina,
      range,
    );
    const timing: ShotTimingGrade = isGreen ? 'Green'
      : precision > 0.85 ? 'Excellent'
        : Math.abs(error) < 0.16 ? (error < 0 ? 'Slightly Early' : 'Slightly Late')
          : error < 0 ? 'Early' : 'Late';
    const contestLabel = contest.contestLevel;

    let andOneFoul = false;
    if (settings.mode === 'regulation' && closest && isContesting(closest) && distance(closest.position, p.position) < 0.98 && random() < 0.085) {
      sim.teamFouls ??= [0, 0];
      sim.teamFouls[closest.side]++;
      state.teamFouls = [...sim.teamFouls];
      const canAndOne = style !== 'jump' && style !== 'pullUp' && style !== 'stepBack' &&
        precision > 0.72 && (p.profile.ratings.finishing >= 80 || postAdvantage > 0.08);
      if (canAndOne && random() < 0.42) {
        andOneFoul = true;
      } else {
        event('foul', closest.side, closest, { detail: 'Shooting foul · ' + points + ' free throws' });
        startFree(p, points, false);
        return;
      }
    }

    alignToHoop(p);
    const gatherMotion = computeGatherMotion(p, body(p), range, style, charge, {
      ownerId: p.id,
      height: gather?.height ?? state.ball.position.y,
      handOffset: gather?.handOffset ?? 0.25,
      idealRelease: ideal,
      driving,
      ...gatherInput,
      rhythm,
    }, reach);

    const finishErr = style === 'dunk' || style === 'contactDunk'
      ? error * 0.28
      : style === 'layup' || style === 'reverseLayup' || style === 'euro'
        ? error * 0.45
        : error;
    const styleSpreadAdd = style === 'dunk' ? 0.026
      : style === 'contactDunk' ? 0.036
        : style === 'layup' ? 0.046
          : style === 'reverseLayup' ? 0.048
            : style === 'euro' ? 0.052
              : style === 'pullUp' ? 0.055
                : style === 'stepBack' ? 0.060
                  : style === 'fadeaway' ? 0.066
                    : 0.049;
    let spread = clamp(
      styleSpreadAdd +
      (75 - rating) * 0.0011 +
      Math.max(0, range - 2) * 0.0046 +
      Math.max(0, range - 9.55) * 0.051 +
      pressure * 0.14 -
      postAdvantage * 0.92 +
      Math.abs(finishErr) * 0.22 +
      (100 - p.stamina) * 0.00072 +
      Math.hypot(p.velocity.x, p.velocity.z) * (style === 'pullUp' ? 0.0025 : 0.004) +
      (andOneFoul ? 0.06 : 0),
      0.024,
      0.72,
    );
    if (catchAndShoot) spread *= 0.82;
    if (offDribble) spread *= 0.90;
    if (rhythm) spread *= 0.88;
    if (isGreen) spread *= 0.14; // Pure physics swish within rim clearance (no magnets!)

    const depthBias = finishErr * (style === 'dunk' || style === 'contactDunk' ? 0.11 : 0.24 + range * 0.026) * (isGreen ? 0.18 : 1);
    const end = aimAt(rim, start, aimRoll, spread, depthBias);
    const duration = style === 'dunk' || style === 'contactDunk'
      ? 0.34
      : style === 'layup' || style === 'reverseLayup' || style === 'euro'
        ? 0.52
        : clamp(0.78 + range * 0.063 + (style === 'floater' ? 0.22 : 0), 0.81, 2.34);

    const spinRate = style === 'dunk' || style === 'contactDunk'
      ? 3
      : style === 'layup' || style === 'reverseLayup' || style === 'euro'
        ? 7
        : 11;
    let spin = backspin(at(end.x - start.x, 0, end.z - start.z), spinRate);
    let velocity = solveShotVelocity(start, end, duration, spin);
    let bank = false;
    if ((style === 'layup' || style === 'reverseLayup' || style === 'euro') &&
      Math.abs(p.position.z) >= 0.72 && p.position.x * sign(p.side) < COURT.rimX - 0.2) {
      const boardFaceX = rim.x + sign(p.side) * (BOARD_OFFSET - BOARD_HALF_DEPTH - BALL_RADIUS);
      const bankShot = bankVelocityFor(start, end, boardFaceX, 0.72, 2);
      if (bankShot) {
        velocity = bankShot.velocity;
        spin = backspin(velocity, 2);
        bank = true;
      }
    }

    const detailTiming = isGreen ? 'Excellent · Green' : timing;
    event('shot', p.side, p, { points, detail: detailOverride ?? (label + (bank ? ' (Bank)' : '') + ' · ' + detailTiming) });
    state.shotFeedback = {
      playerId: p.id,
      tick: state.tick,
      timing,
      contest: contestLabel,
      contestPct: contest.contestPct,
      style: label,
      grade: precision,
      green: isGreen,
      bank,
      rhythm,
      greenWindow,
    };
    if (andOneFoul && closest) {
      event('foul', closest.side, closest, { detail: 'Shooting foul · And-1 chance' });
      sim.pendingAndOne = { shooter: p.id, points };
    }
    if (!andOneFoul && closest) {
      const closestDist = distance(closest.position, p.position);
      const isJump = isContesting(closest);
      const handsUp = isHandsUp(closest);
      const apexQ = getJumpQuality(closest);
      if (evaluateBlock(body(p), closest, body(closest), closestDist, style, isJump, handsUp, apexQ, isStunned(closest), isFlyBy(closest), random)) {
        event('block', closest.side, closest);
        launch(
          p,
          start,
          at(-Math.cos(p.facing) * (1.5 + Math.abs(velocity.x) * 0.35), Math.max(-1.2, velocity.y * 0.35), -Math.sin(p.facing) * 1.5 + (random() - 0.5) * 3.4),
          backspin(velocity, -5),
          { kind: 'shot', from: p.id, points, age: 0 },
          style,
          gatherMotion.jumpHeight,
        );
        state.ball.kind = 'loose';
        sim.flight = null;
        sim.pendingRebound = true;
        sim.lastLooseTouch = closest.side;
        event('miss', p.side, p, { detail: 'Blocked' });
        return;
      }
    }
    launch(
      p,
      start,
      velocity,
      spin,
      { kind: 'shot', from: p.id, age: 0, points, ...(andOneFoul ? { andOne: true, fouled: true } : {}) },
      style,
      gatherMotion.jumpHeight,
    );
  }

  function pass(p: GamePlayer, cmd: Control) {
    const mates = state.players.filter(q => q.side === p.side && q.id !== p.id);
    const foes = state.players.filter(q => q.side !== p.side);
    const aim = cmd.move;
    const attackDir = sign(p.side);
    const directional = selectPassTarget(p, mates, aim, attackDir, foes);
    const target = mates.find(q => q.id === cmd.targetId)
      ?? (directional ? mates.find(q => q.id === directional) : undefined)
      ?? pickAutoPassTarget(p, mates, foes, aim, attackDir);
    if (!target) return;

    const passType = cmd.passType ?? 'chest';
    const result = computePassLaunch(p, target, passType, foes, {
      attackDir,
      half,
      body,
      dunkReach,
      localBall,
      backspin,
      random,
    });
    p.facing = result.facing;
    sim.passStyle = { playerId: p.id, style: passType, until: state.tick + 22 };
    launch(p, result.start, result.velocity, result.spin, result.flight);
    event('pass', p.side, p, { detail: passType });
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
      const { velocity, spin } = state.ball;
      velocity.x *= 0.41;
      velocity.y *= 0.64;
      velocity.z *= 0.41;
      if (spin) {
        spin.x *= 0.65;
        spin.y *= 0.65;
        spin.z *= 0.65;
      }
    } else {
      if (sim.streaks) sim.streaks[shooter.id] = 0;
      event('miss', shooter.side, shooter, ft ? { detail: 'Free throw' } : undefined);
      if (!andOne) {
        state.ball.kind = 'loose';
        sim.pendingRebound = true;
        sim.lastLooseTouch = shooter.side;
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
        state.freeThrow = {
          shooterId: ft.shooter,
          remaining: ft.remaining,
          total: ft.total ?? ft.remaining,
          ...(ft.andOne ? { andOne: true } : {}),
        };
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
    const nearRim = Math.hypot(ball.position.x - rimX, ball.position.z) < 0.34;
    const fellBelow = ball.velocity.y < 0 && ball.position.y < (nearRim ? COURT.rimHeight - 0.32 : COURT.rimHeight - 0.24);
    if (made || fellBelow || f.age > 4.6 || outOfBounds(ball)) {
      resolveShot(shooter, f, made);
    }
  }

  function progressBall(controls: Readonly<Record<string, Control>>) {
    const ball = state.ball;
    const f = sim.flight;
    const passer = f && state.players.find(p => p.id === f.from);
    const prevBallPos = { ...ball.position };
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
      const laneHit = checkPassLaneCollisions(
        prevBallPos,
        ball.position,
        ball,
        f,
        passer,
        state.players,
        controls,
        sim,
        body,
        state.tick,
        canAct,
        random,
      );
      if (laneHit?.kind === 'intercept') {
        const q = laneHit.defender;
        sim.stealPose ??= {};
        sim.stealPose[q.id] = state.tick + 18;
        event('steal', q.side, q, { detail: 'Intercepted pass' });
        event('turnover', passer.side, passer);
        hold(q);
        return;
      }
      if (laneHit?.kind === 'deflect') {
        const q = laneHit.defender;
        sim.stealPose ??= {};
        sim.stealPose[q.id] = state.tick + 16;
        ball.velocity = laneHit.velocity;
        ball.spin = laneHit.spin;
        ball.kind = 'loose';
        sim.flight = null;
        sim.lastLooseTouch = q.side;
        state.callout = { tick: state.tick, text: 'DEFLECTED!', tone: 'blue', playerId: q.id };
        return;
      }
      const catchAfter = f.bounce ? (f.floorTime ?? f.duration * 0.58) + DT / 2 : f.duration * (f.lob ? 0.58 : 0.35);
      const catchDist = f.alleyOop ? 1.55 : 1.25;
      const catchHeight = f.alleyOop && receiver ? dunkReach(receiver, 3.5) + 0.35 : (receiver ? body(receiver).reach + 0.25 : 2.5);
      if (receiver && f.age > catchAfter && distance(receiver.position, ball.position) < catchDist && ball.position.y < catchHeight) {
        hold(receiver);
        sim.lastPass = { from: passer.id, to: receiver.id, tick: state.tick };
        const hoop = { x: sign(receiver.side) * COURT.rimX, z: 0 };
        const alleyRadius = f.alleyOop ? 2.65 : 2.15;
        const triggerOop = controls[receiver.id]?.shoot || controls[receiver.id]?.sprint ||
          (f.alleyOop && Math.hypot(receiver.velocity.x, receiver.velocity.z) > 2.2);
        if (f.lob && distance(receiver.position, hoop) < alleyRadius && triggerOop) {
          state.callout = { tick: state.tick, text: 'ALLEY-OOP!', tone: 'gold', playerId: receiver.id };
          shoot(receiver, IDEAL_RELEASE, controls, 'Alley-oop');
        }
        return;
      }
      if (f.age >= f.duration - 1e-8 || outOfBounds(ball)) {
        ball.kind = 'loose';
        sim.flight = null;
        sim.lastLooseTouch = passer.side;
      }
    }
    if (ball.kind !== 'loose') return;
    if (outOfBounds(ball)) {
      const lastTouch = sim.lastLooseTouch ?? state.possession;
      if (lastTouch === state.possession) {
        event('turnover', state.possession, undefined, { detail: 'Out of bounds' });
        dead(opposite(state.possession));
      } else {
        state.callout = { tick: state.tick, text: 'OUT OF BOUNDS', tone: 'blue' };
        dead(state.possession);
      }
      return;
    }
    const rim = { x: sign(state.possession) * COURT.rimX, z: 0 };
    const outcome = resolveLooseBall(state, sim, controls, body, rim, canAct, random);
    if (outcome?.kind === 'tip') {
      ball.velocity = outcome.velocity;
      ball.spin = outcome.spin;
      sim.lastLooseTouch = outcome.tipper.side;
      state.callout = { tick: state.tick, text: 'TIPPED!', tone: 'gold', playerId: outcome.tipper.id };
    } else if (outcome?.kind === 'grab') {
      if (sim.pendingRebound) event('rebound', outcome.winner.side, outcome.winner);
      sim.rimTouched = false;
      sim.lastPass = null;
      hold(outcome.winner);
    }
  }

  function syncActions(controls: Readonly<Record<string, Control>>) {
    const owner = state.ball.ownerId ? state.players.find(q => q.id === state.ball.ownerId) : undefined;
    const dribble = owner && sim.dribble?.ownerId === owner.id ? sim.dribble : undefined;
    const gather = owner && sim.gather?.ownerId === owner.id ? sim.gather : undefined;
    const round3 = (v: number) => Math.round(v * 1000) / 1000 || 0;
    let activeMeter: GameState['shotMeter'] = null;

    for (const p of state.players) {
      const action: PlayerAction = {};
      if (owner?.id === p.id && dribble) {
        if (dribble.move) {
          action.dribbleMove = dribble.move.type;
          action.moveProgress = round3(clamp((state.tick - dribble.move.started) / Math.max(1, dribble.move.duration), 0, 1));
          action.moveDir = dribble.move.dir;
        }
        action.ballState = dribble.ballState;
        action.ballHand = dribble.hand;
        if (dribble.protectBall) action.protectBall = true;
        action.adrenaline = dribble.adrenaline;
        if (dribble.ballState === 'dead') action.deadDribble = true;
      }
      const charge = state.charge[p.id] || 0;
      const cmd = controls[p.id];
      const rim = { x: sign(p.side) * COURT.rimX, z: 0 };
      const range = distance(p.position, rim);
      if (owner?.id === p.id && charge > 0 && gather) {
        const reach = dunkReach(p, gather.approach);
        const defenders = state.players.filter(q => q.side !== p.side);
        const closest = defenders.reduce<GamePlayer | undefined>(
          (a, q) => (!a || distance(p.position, q.position) < distance(p.position, a.position) ? q : a),
          undefined,
        );
        const nearestDist = closest ? distance(closest.position, p.position) : 99;
        const style = chooseShotStyle(p, range, gather, dribble, reach, state.tick, nearestDist, hasPaintRimDefender(p, rim));
        const gm = computeGatherMotion(p, body(p), range, style, charge, gather, reach);
        action.shotStyle = style;
        if (gm.gatherPhase > 0) action.gatherPhase = round3(gm.gatherPhase);
        if (gm.jumpHeight > 0.002) action.jumpHeight = round3(gm.jumpHeight);

        const ideal = gather.idealRelease ?? idealReleaseFor(style, !!gather.driving);
        const releaseY = shotReleasePoint(p, body(p), range, style, reach).y;
        const contest = computeShotContest(
          p,
          body(p),
          releaseY,
          rim,
          defenders,
          body,
          q => !!controls[q.id]?.contest,
          q => (sim.jumpContest?.[q.id] ?? 0) > state.tick,
          q => !!sim.intenseD?.[q.id],
          q => (sim.stun?.[q.id] ?? 0) > state.tick || (sim.stumble?.[q.id] ?? 0) > state.tick,
          q => (sim.flyBy?.[q.id] ?? 0) > state.tick,
          style,
          q => !!sim.handsUp?.[q.id] && !((sim.jumpContest?.[q.id] ?? 0) > state.tick),
          q => jumpApexQuality(sim.jumpContestStart?.[q.id], state.tick, !!controls[q.id]?.contest),
        );
        const rating = range < 3.2 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
        const contact = range < 3.2 && closest ? clamp(1 - nearestDist / 1.55, 0, 1) : 0;
        const catchAndShoot = sim.lastPass?.to === p.id && state.tick - sim.lastPass.tick <= 45;
        const rhythm = !!gather.rhythm;
        const hotStreak = (sim.streaks?.[p.id] ?? 0) >= 2;
        activeMeter = computeShotMeterState(
          p,
          charge,
          ideal,
          rating,
          contest.pressure,
          contact,
          contest.contestLevel,
          style,
          catchAndShoot,
          rhythm,
          hotStreak,
          rim,
        );
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
        const vert = 0.28 + (p.profile.ratings.interior + p.profile.ratings.rebounding) * 0.0008;
        const jh = vert * Math.sin(left * Math.PI);
        if (jh > 0.002) action.jumpHeight = round3(jh);
      }
      if (cmd?.intenseD && owner?.id !== p.id) action.intenseD = true;
      if (sim.handsUp?.[p.id] && owner?.id !== p.id && !((sim.jumpContest?.[p.id] ?? 0) > state.tick)) {
        action.handsUp = true;
      }
      if (sim.boxOut?.[p.id]) action.boxOut = true;
      if (sim.passStyle?.playerId === p.id && sim.passStyle.until > state.tick) action.passStyle = sim.passStyle.style;
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

    state.shotMeter = activeMeter;
    if (state.callout && state.tick - state.callout.tick > 90) state.callout = null;
  }

  function step(controls: Readonly<Record<string, Control>> = {}) {
    if (state.phase === 'final') return state;
    state.tick++;
    for (const p of state.players) {
      recordControlEdges(sim, p.id, controls[p.id], state.tick);
    }
    if (sim.free) {
      freeStep(controls);
      return state;
    }

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
      if (action?.screenMode) {
        state.screenMode ??= ['roll', 'roll'];
        state.screenMode[p.side] = action.screenMode;
      }
      if (action?.substituteId && canAct(p.id + '/sub', 90)) {
        const bench = state.teams[p.side].roster.find(profile => profile.id === action.substituteId);
        if (bench && !state.players.some(q => q.side === p.side && q.profile.id === bench.id)) {
          const prev = p.id;
          const isOwner = state.ball.ownerId === prev;
          if (sim.flight?.from === prev || (sim.flight?.kind === 'pass' && sim.flight.target === prev)) continue;
          p.profile = bench;
          p.id = state.players.some(q => q !== p && q.id === bench.id) ? p.side + ':' + bench.id : bench.id;
          p.stamina = 100;
          delete state.charge[prev];
          if (isOwner) hold(p);
          event('substitution' as GameEvent['type'], p.side, p, { detail: prev + ' out' });
        }
      }
      if (action?.timeout && state.phase === 'live' && state.ball.ownerId === p.id && canAct(p.id + '/timeout', 180)) {
        sim.timeouts ??= [7, 7];
        if (sim.timeouts[p.side] > 0) {
          sim.timeouts[p.side]--;
          event('timeout' as GameEvent['type'], p.side, p, { detail: sim.timeouts[p.side] + ' remaining' });
          state.players.forEach(q => { q.stamina = Math.min(100, q.stamina + 10); });
          sim.resumeClock = state.shotClock;
          dead(p.side);
          sim.deadUntil = state.tick + 90;
          return state;
        }
      }
    }

    if (state.phase === 'dead') {
      if (state.tick >= sim.deadUntil) setup(sim.inbound);
      else if (sim.deadBallMotion) advanceBall(state.ball, DT, half);
      return state;
    }

    const moveCtx = { state, sim, half, sign, body, canAct };
    for (const p of state.players) stepPlayerMovement(p, controls[p.id], moveCtx);
    separatePlayers(state.players, body, half, sim);
    stepBoxOuts(state, sim, controls, body, { x: sign(state.possession) * COURT.rimX, z: 0 }, half);
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
          const bodyUpRes = resolveBodyUp(
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
          if (bodyUpRes) {
            sim.bodyUp[owner.id] = bodyUpRes.kind;
            sim.bodyUp[def.id] = bodyUpRes.kind;
            const atk = sign(owner.side);
            if (bodyUpRes.kind === 'clamp') {
              const intoDef = -(owner.velocity.x * bodyUpRes.normal.x + owner.velocity.z * bodyUpRes.normal.z);
              if (intoDef > 0) {
                owner.velocity.x += bodyUpRes.normal.x * intoDef * 0.72 + bodyUpRes.tangent.x * intoDef * 0.35;
                owner.velocity.z += bodyUpRes.normal.z * intoDef * 0.72 + bodyUpRes.tangent.z * intoDef * 0.35;
              }
              owner.velocity.x *= 0.88;
              owner.velocity.z *= 0.88;
              def.velocity.x += (owner.velocity.x * 0.45 - def.velocity.x) * 0.35 - bodyUpRes.normal.x * bodyUpRes.force * 0.32;
              def.velocity.z += (owner.velocity.z * 0.45 - def.velocity.z) * 0.35 - bodyUpRes.normal.z * bodyUpRes.force * 0.32;
              owner.stamina = Math.max(0, owner.stamina - 0.16);
            } else if (bodyUpRes.kind === 'ride') {
              owner.velocity.x = owner.velocity.x * 0.91 + bodyUpRes.tangent.x * 0.26;
              owner.velocity.z = owner.velocity.z * 0.91 + bodyUpRes.tangent.z * 0.26;
              def.velocity.x += (owner.velocity.x * 0.72 - def.velocity.x) * 0.28;
              def.velocity.z += (owner.velocity.z * 0.72 - def.velocity.z) * 0.28;
            } else if (bodyUpRes.kind === 'blowby') {
              owner.velocity.x += atk * 0.56;
              def.velocity.x *= 0.56;
              def.velocity.z *= 0.65;
              sim.stun ??= {};
              sim.stun[def.id] = Math.max(sim.stun[def.id] ?? 0, state.tick + 12);
            }
            dribble.clampHits = 0;
          } else {
            dribble.clampHits = 0;
          }
        } else {
          dribble.clampHits = 0;
        }
      }

      const cmd = controls[owner.id];
      if (cmd?.shoot) chargeShot(owner, cmd, controls);
      else if (!(state.charge[owner.id] > 0)) follow(owner, cmd, controls);

      if (state.ball.ownerId === owner.id) {
        if (settings.mode === 'regulation' && !half) {
          const frontCourt = owner.position.x * sign(owner.side) > 0;
          sim.backcourtTicks = frontCourt ? 0 : (sim.backcourtTicks ?? 0) + 1;
          if ((!frontCourt && sim.crossed) || sim.backcourtTicks >= 8 * TICK_RATE) {
            event('turnover', owner.side, owner, { detail: sim.crossed ? 'Backcourt violation' : 'Eight-second violation' });
            dead(opposite(owner.side));
            return state;
          }
          if (frontCourt) sim.crossed = true;
        }

        for (const q of state.players) {
          if (q.side === owner.side || !controls[q.id]?.steal || distance(owner.position, q.position) > 1.45 || !canAct(q.id + '/steal', 46)) {
            continue;
          }
          sim.stealPose ??= {};
          sim.stealPose[q.id] = state.tick + 18;
          sim.stealHistory ??= {};
          const prevSteal = sim.stealHistory[q.id];
          const spamCount = prevSteal && state.tick - prevSteal.lastTick <= 135 ? prevSteal.count : 0;
          sim.stealHistory[q.id] = { count: spamCount + 1, lastTick: state.tick };

          const ofx = Math.cos(owner.facing);
          const ofz = Math.sin(owner.facing);
          const defLocalSide = ofz * (q.position.x - owner.position.x) - ofx * (q.position.z - owner.position.z);
          const inBallSide = !!sim.dribble && defLocalSide * sim.dribble.hand > 0.05;
          const outcome = evaluateSteal(
            q,
            owner,
            state.ball.position,
            sim.dribble,
            state.tick,
            random,
            !!sim.postUp?.[owner.id],
            spamCount,
            inBallSide,
          );
          if (outcome === 'steal') {
            event('steal', q.side, q);
            event('turnover', owner.side, owner);
            hold(q);
            state.charge[owner.id] = 0;
            break;
          }
          if (outcome === 'poke') {
            event('turnover', owner.side, owner, { detail: 'Poked loose' });
            state.callout = { tick: state.tick, text: 'POKE LOOSE!', tone: 'blue', playerId: q.id };
            sim.lastLooseTouch = q.side;
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
          const bd = Math.max(0.05, distance(q.position, state.ball.position));
          const lungeSpeed = 2.0 + Math.min(3, spamCount) * 0.55;
          q.velocity.x += ((state.ball.position.x - q.position.x) / bd) * lungeSpeed;
          q.velocity.z += ((state.ball.position.z - q.position.z) / bd) * lungeSpeed;
          q.stamina = Math.max(0, q.stamina - 2.6);
          sim.stealLunge ??= {};
          sim.stealLunge[q.id] = state.tick + 20 + Math.min(3, spamCount) * 6;
          sim.stun ??= {};
          sim.stun[q.id] = state.tick + 18 + Math.min(3, spamCount) * 5;
          if (spamCount >= 2) {
            state.callout = { tick: state.tick, text: 'REACH!', tone: 'red', playerId: q.id };
          }
        }
      }

      if (state.ball.ownerId === owner.id) {
        const bufferedFake = !(state.charge[owner.id] > 0.28) &&
          (cmd?.pumpFake ? consumeBuffered(sim, owner.id, 'pumpFake', state.tick) : undefined);
        const bufferedPass = !cmd?.shoot && (cmd?.pass || state.charge[owner.id] < 0.25)
          ? consumeBuffered(sim, owner.id, 'pass', state.tick)
          : undefined;

        if (cmd?.pumpFake && !(state.charge[owner.id] > 0.28) && canAct(owner.id + '/fake', 32)) {
          void bufferedFake;
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
            const handsOnly = !!sim.handsUp?.[def.id] && !controls[def.id]?.contest && !((sim.jumpContest?.[def.id] ?? 0) > state.tick);
            if (handsOnly) continue;
            const biting = controls[def.id]?.contest || (sim.jumpContest?.[def.id] ?? 0) > state.tick;
            if (d < 2.1 && (biting || (d < 1.55 && random() < clamp(0.45 - (def.profile.ratings.iq - 70) * 0.008, 0.15, 0.65)))) {
              sim.jumpContest ??= {};
              sim.jumpContest[def.id] = state.tick + 26;
              sim.jumpContestStart ??= {};
              sim.jumpContestStart[def.id] = state.tick;
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
        } else if (state.charge[owner.id] > 0 && state.charge[owner.id] < 0.25 && (cmd?.pass || bufferedPass) && canAct(owner.id + '/pass', 15)) {
          state.charge[owner.id] = 0;
          delete sim.gather;
          pass(owner, cmd?.pass ? cmd : { ...cmd!, pass: true, targetId: bufferedPass?.targetId, passType: bufferedPass?.passType });
        } else if (!cmd?.shoot && state.charge[owner.id] > 0) {
          shoot(owner, state.charge[owner.id], controls);
        } else if (!cmd?.shoot && (cmd?.pass || bufferedPass) && canAct(owner.id + '/pass', 15)) {
          pass(owner, cmd?.pass ? cmd : { move: cmd?.move ?? { x: 0, z: 0 }, pass: true, targetId: bufferedPass?.targetId, passType: bufferedPass?.passType });
        }
      }
    } else {
      progressBall(controls);
    }

    if ((state.phase as GameState['phase']) === 'final') return state;
    if (settings.mode === 'regulation' && !sim.pendingAndOne) {
      state.clock = Math.max(0, Math.round((state.clock - DT) * TICK_RATE) / TICK_RATE);
    }
    if (settings.mode !== 'practice' && state.ball.kind !== 'shot' && state.phase === 'live' && !sim.pendingAndOne) {
      state.shotClock = Math.max(0, Math.round((state.shotClock - DT) * TICK_RATE) / TICK_RATE);
    }
    if (settings.mode === 'regulation' && state.clock <= 0 && state.ball.kind !== 'shot' && !sim.pendingAndOne) {
      event('period', state.possession, undefined, { detail: 'End of period ' + state.period });
      if (state.period >= settings.periods && state.score[0] !== state.score[1]) {
        state.phase = 'final';
      } else {
        state.period++;
        state.clock = state.period > settings.periods ? Math.min(300, settings.periodSeconds) : settings.periodSeconds;
        sim.teamFouls = [0, 0];
        state.teamFouls = [0, 0];
        dead(state.period % 2 === 0 ? 1 : 0);
      }
    } else if (state.shotClock <= 0 && state.phase === 'live' && state.ball.kind !== 'shot' && settings.mode !== 'practice' && !sim.pendingAndOne) {
      event('turnover', state.possession, owner, { detail: 'Shot clock violation' });
      dead(opposite(state.possession));
    }
    syncActions(controls);
    return state;
  }

  return { state, step };
}
