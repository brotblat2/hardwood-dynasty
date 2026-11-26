import type { BallState, DribbleMove, GamePlayer, Vec2, Vec3 } from '../contracts/index.ts';
import { BALL_RADIUS, vector as at } from './physics-ball.ts';
import { clamp, distance } from './types.ts';
import type { ActiveMove, DribbleRuntime, MoveSpec, PlayerBody } from './types.ts';

export type { ActiveMove, DribbleRuntime, MoveSpec, PlayerBody } from './types.ts';

export function createDribbleRuntime(ownerId: string, tick: number, initialHand: -1 | 1 = 1): DribbleRuntime {
  return {
    ownerId,
    hand: initialHand,
    phase: 0,
    lastTick: tick,
    held: false,
    ballState: 'tripleThreat',
    adrenaline: 3,
    comboCount: 0,
    lastMoveTick: -999,
    clampHits: 0,
    clampWindowUntil: 0,
    protectBall: false,
  };
}

export function localBallPoint(p: GamePlayer, forward: number, side: number, height: number): Vec3 {
  const fx = Math.cos(p.facing);
  const fz = Math.sin(p.facing);
  return at(p.position.x + fx * forward + fz * side, height, p.position.z + fz * forward - fx * side);
}

/** Progress in [0, 1] of the currently executing dribble animation, if any. */
export function moveProgress(move: ActiveMove | undefined, tick: number): number {
  if (!move) return 1;
  return clamp((tick - move.started) / Math.max(1, move.duration), 0, 1);
}

/** Whether the handler can branch out of the current dribble move into another move or shot gather. */
export function canCancelMove(dribble: DribbleRuntime | undefined, tick: number): boolean {
  if (!dribble?.move) return true;
  return moveProgress(dribble.move, tick) >= dribble.move.cancelAfter;
}

/** Whether the handler has passed the launch frame of a dribble move and can burst into a drive. */
export function canLaunchOutOfMove(dribble: DribbleRuntime | undefined, tick: number): boolean {
  if (!dribble?.move) return true;
  return moveProgress(dribble.move, tick) >= dribble.move.launchAt;
}

/** Commit ball-hand ownership cleanly when branching or canceling mid-move. */
export function commitMoveHand(dribble: DribbleRuntime, tick: number): void {
  if (!dribble.move) return;
  const prog = moveProgress(dribble.move, tick);
  dribble.hand = prog >= 0.44 ? dribble.move.toHand : dribble.move.fromHand;
  delete dribble.move;
}

/** A committed change of heading transfers the ball once; tiny stick corrections leave the hand alone. */
export function trackDirectionalCut(p: GamePlayer, dribble: DribbleRuntime, input: Vec2, tick: number, ballHeight: number) {
  const magnitude = Math.hypot(input.x, input.z);
  if (magnitude < 0.48 || !Number.isFinite(magnitude)) {
    delete dribble.pendingCut;
    if (tick - (dribble.lastSteeringTick ?? -999) > 3) delete dribble.cutHeading;
    return;
  }
  const dir = { x: input.x / magnitude, z: input.z / magnitude };
  dribble.lastSteeringTick = tick;
  if (tick - (dribble.lastAutomaticCut ?? -999) < 36 || tick - dribble.lastMoveTick < 26 || Math.hypot(p.velocity.x, p.velocity.z) < 1.75) {
    dribble.cutHeading = dir;
    delete dribble.pendingCut;
    return;
  }
  const pending = dribble.pendingCut;
  delete dribble.pendingCut;
  if (pending && pending.x * dir.x + pending.z * dir.z > 0.87) {
    // On a lateral drive the outside hand is the one on the new travel side.
    const lateral = Math.sin(p.facing) * dir.x - Math.cos(p.facing) * dir.z;
    const toHand = Math.abs(lateral) > 0.30 ? (lateral > 0 ? 1 : -1) : (dribble.hand === 1 ? -1 : 1);
    if (toHand === dribble.hand) {
      dribble.cutHeading = dir;
      return;
    }
    const duration = Math.round(clamp(28 - p.profile.ratings.handling * 0.10, 18, 25));
    dribble.move = {
      type: 'crossover', fromHand: dribble.hand, toHand, dir: toHand, started: tick, duration,
      cancelAfter: 0, launchAt: 1, peakSpeed: 0,
      cutBounce: { height: clamp(ballHeight, BALL_RADIUS, 2.4), floorTick: Math.round(duration * 0.47) },
    };
    dribble.lastAutomaticCut = tick;
    dribble.cutHeading = dir;
  } else if (dribble.cutHeading && dribble.cutHeading.x * dir.x + dribble.cutHeading.z * dir.z < 0.45) {
    dribble.pendingCut = dir;
    return;
  }
  // Smooth the reference heading so a fast analog sweep registers across intermediate samples.
  if (dribble.cutHeading) {
    const x = dribble.cutHeading.x * 0.8 + dir.x * 0.2;
    const z = dribble.cutHeading.z * 0.8 + dir.z * 0.2;
    const length = Math.hypot(x, z);
    dribble.cutHeading = { x: x / length, z: z / length };
  } else dribble.cutHeading = dir;
}

export function selectDribbleMove(
  p: GamePlayer,
  dribble: DribbleRuntime,
  moveDir: Vec2,
  attackSign: number,
  nearestDef: GamePlayer | undefined,
  rangeToRim: number,
): MoveSpec {
  const inputMag = Math.hypot(moveDir.x, moveDir.z);
  const fx = Math.cos(p.facing);
  const fz = Math.sin(p.facing);
  const forward = moveDir.x * attackSign;
  const velForward = p.velocity.x * attackSign;
  const localSide = fz * moveDir.x - fx * moveDir.z;
  const defDist = nearestDef ? distance(nearestDef.position, p.position) : 99;
  const speed = Math.hypot(p.velocity.x, p.velocity.z);

  const fatigueRatio = p.stamina < 35 ? clamp(1 - p.stamina / 35, 0, 1) : 0;
  const adImpulse = dribble.adrenaline > 0 ? 1 : 0.91;
  const fatigueImpulse = 1 - fatigueRatio * 0.24;
  const burstMult = adImpulse * fatigueImpulse;
  const durMult = 1 + fatigueRatio * 0.28 + (dribble.adrenaline === 0 ? 0.08 : 0);
  const scaleDur = (base: number) => Math.max(10, Math.round(base * durMult));

  const sideFallback: -1 | 1 = Math.abs(localSide) > 0.12 ? (localSide >= 0 ? 1 : -1) : (-dribble.hand as -1 | 1);
  const latUnitX = inputMag > 0.15 ? moveDir.x / inputMag : fz * sideFallback;
  const latUnitZ = inputMag > 0.15 ? moveDir.z / inputMag : -fx * sideFallback;

  if (dribble.ballState === 'tripleThreat' && inputMag < 0.15) {
    return {
      type: 'jab',
      dir: dribble.hand,
      toHand: dribble.hand,
      duration: 18,
      cancelAfter: 0.50,
      launchAt: 0.60,
      staminaCost: 1.0,
      impulse: { x: attackSign * 0.45, z: 0 },
    };
  }

  // High-momentum drive pullback -> Snatch-Back; controlled/stationary pullback -> Step-Back.
  if (forward < -0.35) {
    if (velForward > 3.6) {
      return {
        type: 'snatchBack',
        dir: dribble.hand,
        toHand: dribble.hand,
        duration: scaleDur(19),
        cancelAfter: 0.48,
        launchAt: 0.66,
        staminaCost: 2.3,
        impulse: { x: -attackSign * 3.85 * burstMult, z: -p.velocity.z * 0.45 },
      };
    }
    return {
      type: 'stepBack',
      dir: dribble.hand,
      toHand: dribble.hand,
      duration: scaleDur(20),
      cancelAfter: 0.50,
      launchAt: 0.72,
      staminaCost: 2.2,
      impulse: { x: -attackSign * 3.2 * burstMult, z: p.velocity.z * -0.4 },
    };
  }

  if (rangeToRim < 4.8 && defDist < 1.55 && forward > 0.25 && speed > 2.4) {
    return {
      type: 'spin',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: scaleDur(22),
      cancelAfter: 0.54,
      launchAt: 0.70,
      staminaCost: 2.4,
      impulse: { x: attackSign * 2.3 * burstMult, z: latUnitZ * 2.5 * burstMult },
    };
  }

  if (defDist < 1.35 && forward < 0.2 && inputMag >= 0.2) {
    return {
      type: 'behindBack',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: scaleDur(18),
      cancelAfter: 0.48,
      launchAt: 0.62,
      staminaCost: 1.8,
      impulse: { x: latUnitX * 2.8 * burstMult - attackSign * 0.3, z: latUnitZ * 2.8 * burstMult },
    };
  }

  if (Math.abs(localSide) > 0.25 && Math.sign(localSide) === dribble.hand && forward >= -0.1) {
    return {
      type: 'inAndOut',
      dir: dribble.hand,
      toHand: dribble.hand,
      duration: scaleDur(18),
      cancelAfter: 0.48,
      launchAt: 0.65,
      staminaCost: 1.6,
      impulse: { x: attackSign * 1.45 * burstMult, z: latUnitZ * 2.75 * burstMult },
    };
  }

  if (defDist < 1.65 && Math.abs(localSide) > 0.25 && Math.sign(localSide) !== dribble.hand) {
    return {
      type: 'betweenLegs',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: scaleDur(18),
      cancelAfter: 0.46,
      launchAt: 0.58,
      staminaCost: 1.8,
      impulse: { x: attackSign * 1.2 * burstMult, z: latUnitZ * 3.1 * burstMult },
    };
  }

  if (Math.abs(localSide) > 0.2 || inputMag >= 0.2) {
    return {
      type: 'crossover',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: scaleDur(17),
      cancelAfter: 0.46,
      launchAt: 0.55,
      staminaCost: 1.8,
      impulse: { x: attackSign * 1.15 * burstMult, z: latUnitZ * 3.1 * burstMult },
    };
  }

  return {
    type: 'hesitation',
    dir: dribble.hand,
    toHand: dribble.hand,
    duration: scaleDur(18),
    cancelAfter: 0.48,
    launchAt: 0.68,
    staminaCost: 1.4,
    impulse: { x: attackSign * 1.7 * burstMult, z: -fx * dribble.hand * 0.45 * burstMult },
  };
}

export function applyDribbleMove(
  p: GamePlayer,
  dribble: DribbleRuntime,
  spec: MoveSpec,
  tick: number,
  nearestDef: GamePlayer | undefined,
  defIntenseD: boolean,
  attackSign: number,
  random: () => number,
): { stunnedDefId?: string; stumbleTicks: number; stunTicks: number; isAnkleBreaker: boolean } {
  if (dribble.move) commitMoveHand(dribble, tick);

  p.stamina = Math.max(0, p.stamina - spec.staminaCost);
  if (spec.type !== 'jab') {
    dribble.ballState = 'live';
    dribble.adrenaline = Math.max(0, dribble.adrenaline - 1);
  }
  dribble.comboCount = tick - dribble.lastMoveTick < 55 ? dribble.comboCount + 1 : 1;
  dribble.lastMoveTick = tick;
  dribble.lastMoveType = spec.type;
  dribble.move = {
    type: spec.type,
    started: tick,
    duration: spec.duration,
    fromHand: dribble.hand,
    toHand: spec.toHand,
    dir: spec.dir,
    cancelAfter: spec.cancelAfter,
    launchAt: spec.launchAt,
    peakSpeed: Math.hypot(spec.impulse.x, spec.impulse.z),
  };

  if (spec.type === 'snatchBack') {
    // Arrest forward momentum sharply and yank backward into separation space.
    if (p.velocity.x * attackSign > 0) p.velocity.x *= 0.22;
    p.velocity.x += spec.impulse.x;
    p.velocity.z += spec.impulse.z;
  } else if (spec.type === 'stepBack') {
    if (p.velocity.x * attackSign > 1.5) p.velocity.x *= 0.45;
    p.velocity.x += spec.impulse.x;
    p.velocity.z *= 0.55;
  } else {
    p.velocity.x += spec.impulse.x;
    p.velocity.z += spec.impulse.z;
  }

  if (!nearestDef || distance(nearestDef.position, p.position) >= 1.85) {
    return { stumbleTicks: 0, stunTicks: 0, isAnkleBreaker: false };
  }

  const defCommit = nearestDef.velocity.x * spec.impulse.x + nearestDef.velocity.z * spec.impulse.z;
  const defApproaching = nearestDef.velocity.x * attackSign < -0.6;
  const handling = p.profile.ratings.handling;
  const perimeter = nearestDef.profile.ratings.perimeter;
  const breakChance = clamp(
    0.09 +
      (handling - perimeter) * 0.008 +
      (defCommit < -1.1 ? 0.28 : defCommit < -0.6 ? 0.12 : 0) +
      ((spec.type === 'stepBack' || spec.type === 'snatchBack') && defApproaching ? 0.22 : 0) +
      (dribble.comboCount >= 2 ? 0.06 : 0) -
      (defIntenseD ? 0.14 : 0),
    0.03,
    0.64,
  );
  if (random() < breakChance) {
    const stunTicks = Math.round(22 + 12 * (1 - perimeter / 100));
    const majorBreak = handling >= 78 && (defCommit < -1.1 || ((spec.type === 'stepBack' || spec.type === 'snatchBack') && defApproaching && handling >= 82));
    const stumbleTicks = majorBreak ? 34 : 18;
    const isAnkleBreaker = majorBreak && (defCommit < -1.1 || breakChance >= 0.36);
    return { stunnedDefId: nearestDef.id, stumbleTicks, stunTicks, isAnkleBreaker };
  }
  return { stumbleTicks: 0, stunTicks: 0, isAnkleBreaker: false };
}

export function computeDribbleBallPose(
  p: GamePlayer,
  physique: PlayerBody,
  dribble: DribbleRuntime,
  speed: number,
  tick: number,
  nearestDef: GamePlayer | undefined,
  sprinting: boolean,
  dt: number,
): { position: Vec3; velocity: Vec3; spin: Vec3; dribbleHand: -1 | 1; protectBall: boolean } {
  const nearestDefDist = nearestDef ? distance(nearestDef.position, p.position) : 99;

  if (dribble.ballState === 'dead') {
    dribble.protectBall = nearestDefDist < 1.45;
    const y = physique.height * 0.68;
    const position = localBallPoint(p, 0.24, dribble.hand * 0.16, y);
    return {
      position,
      velocity: at(p.velocity.x, 0, p.velocity.z),
      spin: at(0, 0, 0),
      dribbleHand: dribble.hand,
      protectBall: dribble.protectBall,
    };
  }

  if (dribble.ballState === 'tripleThreat') {
    let jabThrust = 0;
    if (dribble.move?.type === 'jab') {
      const prog = clamp((tick - dribble.move.started) / dribble.move.duration, 0, 1);
      jabThrust = Math.sin(prog * Math.PI);
      if (prog >= 1) delete dribble.move;
    }
    dribble.protectBall = nearestDefDist < 1.4 && !jabThrust;
    const y = physique.height * (0.56 - 0.04 * jabThrust);
    const position = localBallPoint(p, 0.28 + jabThrust * 0.20, dribble.hand * (0.21 + jabThrust * 0.12), y);
    return {
      position,
      velocity: at(p.velocity.x, 0, p.velocity.z),
      spin: at(0, 0, 0),
      dribbleHand: dribble.hand,
      protectBall: dribble.protectBall,
    };
  }

  // Ball-hand awareness: check whether nearest defender crowds the current dribble hand.
  const fx = Math.cos(p.facing);
  const fz = Math.sin(p.facing);
  let defOnBallSide = false;
  if (nearestDef && nearestDefDist < 1.55) {
    const dx = nearestDef.position.x - p.position.x;
    const dz = nearestDef.position.z - p.position.z;
    const defLocalSide = fz * dx - fx * dz;
    defOnBallSide = defLocalSide * dribble.hand > 0.10;
  }

  const active = dribble.move;
  const protectBall = !active && !sprinting && nearestDefDist < 1.50 && defOnBallSide;
  dribble.protectBall = protectBall;

  const tightGuard = nearestDefDist < 1.35 ? 0.12 : 0;
  let handOffset: number = dribble.hand;
  let forward = protectBall ? 0.14 : 0.25 + Math.min(speed, 7) * 0.032;
  let heightScale = 0.61 - tightGuard - (protectBall ? 0.05 : 0);
  let yOverride: number | undefined;

  if (active) {
    const progress = clamp((tick - active.started) / active.duration, 0, 1);
    const peakSin = Math.sin(progress * Math.PI);
    if (active.type === 'crossover') {
      handOffset = active.fromHand * Math.cos(progress * Math.PI);
      const bounceCurve = Math.abs(progress - 0.48) / 0.48;
      yOverride = BALL_RADIUS + physique.height * 0.52 * clamp(bounceCurve * bounceCurve, 0, 1);
      if (active.cutBounce) {
        const age = tick - active.started;
        const { height, floorTick } = active.cutBounce;
        const down = clamp(age / floorTick, 0, 1);
        const up = clamp((age - floorTick) / (active.duration - floorTick), 0, 1);
        yOverride = BALL_RADIUS + (age <= floorTick
          ? (height - BALL_RADIUS) * (1 - down * down)
          : (physique.height * heightScale - BALL_RADIUS) * up * (2 - up));
        if (progress === 1) dribble.phase = 0;
      }
      forward = 0.30;
    } else if (active.type === 'betweenLegs') {
      handOffset = active.fromHand * Math.cos(progress * Math.PI);
      const bounceCurve = Math.abs(progress - 0.45) / 0.45;
      yOverride = BALL_RADIUS + physique.height * 0.47 * clamp(bounceCurve * bounceCurve, 0, 1);
      forward = 0.06;
    } else if (active.type === 'behindBack') {
      handOffset = active.fromHand * Math.cos(progress * Math.PI);
      forward = 0.22 - 0.46 * peakSin;
      const bounceCurve = Math.abs(progress - 0.5) / 0.5;
      yOverride = BALL_RADIUS + physique.height * 0.51 * clamp(bounceCurve * bounceCurve, 0, 1);
    } else if (active.type === 'inAndOut') {
      handOffset = active.fromHand * (1 - 0.92 * peakSin);
      const bounceCurve = Math.abs(progress - 0.44) / 0.44;
      yOverride = BALL_RADIUS + physique.height * 0.55 * clamp(bounceCurve * bounceCurve, 0, 1);
      forward = 0.29;
    } else if (active.type === 'hesitation') {
      handOffset = active.fromHand;
      const hang = progress > 0.22 && progress < 0.7 ? Math.sin(((progress - 0.22) / 0.48) * Math.PI) : 0;
      yOverride = BALL_RADIUS + physique.height * (0.48 + 0.22 * hang);
      forward = 0.27;
    } else if (active.type === 'spin') {
      const spinAngle = progress * Math.PI * 2 * active.dir;
      handOffset = active.fromHand * Math.cos(spinAngle * 0.5) * 0.72;
      forward = 0.16 + 0.14 * Math.cos(spinAngle);
      yOverride = BALL_RADIUS + physique.height * (0.50 - 0.16 * peakSin);
    } else if (active.type === 'stepBack') {
      handOffset = active.fromHand * (1 - 0.35 * progress);
      if (progress < 0.45) {
        const pound = Math.abs(progress - 0.24) / 0.24;
        yOverride = BALL_RADIUS + physique.height * 0.52 * clamp(pound * pound, 0, 1);
      } else {
        const pocket = (progress - 0.45) / 0.55;
        yOverride = physique.height * (0.50 + 0.16 * pocket);
      }
      forward = 0.30;
    } else if (active.type === 'snatchBack') {
      handOffset = active.fromHand * (1 - 0.28 * progress);
      if (progress < 0.42) {
        const pound = Math.abs(progress - 0.22) / 0.22;
        yOverride = BALL_RADIUS + physique.height * 0.44 * clamp(pound * pound, 0, 1);
      } else {
        const pocket = (progress - 0.42) / 0.58;
        yOverride = physique.height * (0.46 + 0.20 * pocket);
      }
      forward = 0.28 - 0.14 * peakSin;
    }
    if (progress >= 1) {
      dribble.hand = active.toHand;
      delete dribble.move;
    }
  }

  const staminaCadence = p.stamina < 40 ? 0.72 + (p.stamina / 40) * 0.28 : 1;
  const frequency = (1.28 + Math.min(0.45, speed * 0.075) + p.profile.ratings.handling * 0.0018) *
    (active ? 1.16 : 1) * staminaCadence;
  dribble.phase = (dribble.phase + dt * frequency) % 1;
  const halfStroke = dribble.phase < 0.5 ? dribble.phase : dribble.phase - 1;
  const height = physique.height * heightScale - BALL_RADIUS;
  const y = yOverride ?? BALL_RADIUS + height * (1 - 4 * halfStroke ** 2);
  const lateralScale = protectBall ? 0.20 : 0.25 + (physique.wingspan - 1.85) * 0.14;
  const lateral = lateralScale * handOffset;
  const position = localBallPoint(p, forward, lateral, y);
  return {
    position,
    velocity: active?.cutBounce && dribble.lastBallPos
      ? at((position.x - dribble.lastBallPos.x) / dt, (position.y - dribble.lastBallPos.y) / dt, (position.z - dribble.lastBallPos.z) / dt)
      : at(p.velocity.x, -8 * height * halfStroke * frequency, p.velocity.z),
    spin: at(p.velocity.z * 0.75, handOffset * 2.1, -p.velocity.x * 0.75),
    dribbleHand: handOffset < 0 ? -1 : 1,
    protectBall,
  };
}