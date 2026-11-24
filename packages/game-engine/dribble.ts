import type { BallState, DribbleMove, GamePlayer, Vec2, Vec3 } from '../contracts/index.ts';
import { BALL_RADIUS, vector as at } from './ball.ts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

export type PlayerBody = {
  height: number;
  mass: number;
  wingspan: number;
  reach: number;
  leverage: number;
  acceleration: number;
};

export type ActiveMove = {
  type: DribbleMove;
  started: number;
  duration: number;
  fromHand: -1 | 1;
  toHand: -1 | 1;
  dir: -1 | 1;
  launchAt: number;
  peakSpeed: number;
};

export type DribbleRuntime = {
  ownerId: string;
  hand: -1 | 1;
  phase: number;
  lastTick: number;
  held: boolean;
  ballState: BallState;
  adrenaline: number;
  comboCount: number;
  lastMoveTick: number;
  lastMoveType?: DribbleMove;
  clampHits: number;
  clampWindowUntil: number;
  move?: ActiveMove;
  crossover?: { traveled: number; floorAt: number };
};

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
  };
}

export function localBallPoint(p: GamePlayer, forward: number, side: number, height: number): Vec3 {
  const fx = Math.cos(p.facing);
  const fz = Math.sin(p.facing);
  return at(p.position.x + fx * forward + fz * side, height, p.position.z + fz * forward - fx * side);
}

export type MoveSpec = {
  type: DribbleMove;
  dir: -1 | 1;
  toHand: -1 | 1;
  duration: number;
  launchAt: number;
  staminaCost: number;
  impulse: Vec2;
};

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
  const localSide = fz * moveDir.x - fx * moveDir.z;
  const defDist = nearestDef ? distance(nearestDef.position, p.position) : 99;
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  const adMult = dribble.adrenaline > 0 ? 1 : 0.72;
  const sideFallback: -1 | 1 = Math.abs(localSide) > 0.12 ? (localSide >= 0 ? 1 : -1) : (-dribble.hand as -1 | 1);
  const latUnitX = inputMag > 0.15 ? moveDir.x / inputMag : fz * sideFallback;
  const latUnitZ = inputMag > 0.15 ? moveDir.z / inputMag : -fx * sideFallback;

  if (dribble.ballState === 'tripleThreat' && inputMag < 0.15) {
    return {
      type: 'jab',
      dir: dribble.hand,
      toHand: dribble.hand,
      duration: 18,
      launchAt: 0.6,
      staminaCost: 1.0,
      impulse: { x: attackSign * 0.45, z: 0 },
    };
  }

  if (forward < -0.35) {
    return {
      type: 'stepBack',
      dir: dribble.hand,
      toHand: dribble.hand,
      duration: 24,
      launchAt: 0.72,
      staminaCost: 2.6,
      impulse: { x: -attackSign * 2.85 * adMult, z: (p.velocity.z * -0.4) },
    };
  }

  if (rangeToRim < 4.8 && defDist < 1.55 && forward > 0.25 && speed > 2.4) {
    const dir: -1 | 1 = sideFallback;
    return {
      type: 'spin',
      dir,
      toHand: (-dribble.hand) as -1 | 1,
      duration: 26,
      launchAt: 0.7,
      staminaCost: 3.0,
      impulse: { x: attackSign * 1.9 * adMult, z: latUnitZ * 2.2 * adMult },
    };
  }

  if (defDist < 1.35 && forward < 0.2 && inputMag >= 0.2) {
    return {
      type: 'behindBack',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: 22,
      launchAt: 0.62,
      staminaCost: 2.2,
      impulse: { x: latUnitX * 2.4 * adMult - attackSign * 0.3, z: latUnitZ * 2.4 * adMult },
    };
  }

  if (Math.abs(localSide) > 0.25 && Math.sign(localSide) === dribble.hand && forward >= -0.1) {
    return {
      type: 'inAndOut',
      dir: dribble.hand,
      toHand: dribble.hand,
      duration: 20,
      launchAt: 0.65,
      staminaCost: 2.0,
      impulse: { x: attackSign * 1.15 * adMult, z: latUnitZ * 2.45 * adMult },
    };
  }

  if (defDist < 1.65 && Math.abs(localSide) > 0.25 && Math.sign(localSide) !== dribble.hand) {
    return {
      type: 'betweenLegs',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: 22,
      launchAt: 0.58,
      staminaCost: 2.2,
      impulse: { x: attackSign * 0.9 * adMult, z: latUnitZ * 2.65 * adMult },
    };
  }

  if (Math.abs(localSide) > 0.2 || inputMag >= 0.2) {
    return {
      type: 'crossover',
      dir: sideFallback,
      toHand: (-dribble.hand) as -1 | 1,
      duration: 20,
      launchAt: 0.55,
      staminaCost: 2.2,
      impulse: { x: attackSign * 0.85 * adMult, z: latUnitZ * 2.65 * adMult },
    };
  }

  return {
    type: 'hesitation',
    dir: dribble.hand,
    toHand: dribble.hand,
    duration: 22,
    launchAt: 0.68,
    staminaCost: 1.6,
    impulse: { x: attackSign * 1.45 * adMult, z: -fx * dribble.hand * 0.4 * adMult },
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
    launchAt: spec.launchAt,
    peakSpeed: Math.hypot(spec.impulse.x, spec.impulse.z),
  };

  if (spec.type === 'stepBack') {
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
    0.16 +
      (handling - perimeter) * 0.009 +
      (defCommit < -0.6 ? 0.28 : 0) +
      (spec.type === 'stepBack' && defApproaching ? 0.24 : 0) +
      (dribble.comboCount >= 2 ? 0.08 : 0) -
      (defIntenseD ? 0.14 : 0),
    0.05,
    0.72,
  );
  if (random() < breakChance) {
    const stunTicks = Math.round(24 + 12 * (1 - perimeter / 100));
    const stumbleTicks = defCommit < -0.5 || spec.type === 'stepBack' || handling >= 84 ? 34 : 20;
    const isAnkleBreaker = stumbleTicks >= 34 && (defCommit < -0.5 || breakChance >= 0.34);
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
  nearestDefDist: number,
  dt: number,
): { position: Vec3; velocity: Vec3; spin: Vec3; dribbleHand: -1 | 1 } {
  if (dribble.ballState === 'dead') {
    const y = physique.height * 0.68;
    const position = localBallPoint(p, 0.26, dribble.hand * 0.16, y);
    return {
      position,
      velocity: at(p.velocity.x, 0, p.velocity.z),
      spin: at(0, 0, 0),
      dribbleHand: dribble.hand,
    };
  }

  if (dribble.ballState === 'tripleThreat') {
    let jabThrust = 0;
    if (dribble.move?.type === 'jab') {
      const prog = clamp((tick - dribble.move.started) / dribble.move.duration, 0, 1);
      jabThrust = Math.sin(prog * Math.PI);
      if (prog >= 1) delete dribble.move;
    }
    const y = physique.height * (0.56 - 0.04 * jabThrust);
    const position = localBallPoint(p, 0.28 + jabThrust * 0.20, dribble.hand * (0.21 + jabThrust * 0.12), y);
    return {
      position,
      velocity: at(p.velocity.x, 0, p.velocity.z),
      spin: at(0, 0, 0),
      dribbleHand: dribble.hand,
    };
  }

  const tightGuard = nearestDefDist < 1.35 ? 0.12 : 0;
  const active = dribble.move;
  let handOffset: number = dribble.hand;
  let forward = 0.25 + Math.min(speed, 7) * 0.032;
  let heightScale = 0.61 - tightGuard;
  let yOverride: number | undefined;

  if (active) {
    const progress = clamp((tick - active.started) / active.duration, 0, 1);
    const peakSin = Math.sin(progress * Math.PI);
    if (active.type === 'crossover') {
      handOffset = active.fromHand * Math.cos(progress * Math.PI);
      const bounceCurve = Math.abs(progress - 0.48) / 0.48;
      yOverride = BALL_RADIUS + physique.height * 0.52 * clamp(bounceCurve * bounceCurve, 0, 1);
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
    }
    if (progress >= 1) {
      dribble.hand = active.toHand;
      delete dribble.move;
    }
  }

  const frequency = (1.0 + Math.min(0.37, speed * 0.06) + p.profile.ratings.handling * 0.0015) * (active ? 1.18 : 1);
  dribble.phase = (dribble.phase + dt * frequency) % 1;
  const halfStroke = dribble.phase < 0.5 ? dribble.phase : dribble.phase - 1;
  const height = physique.height * heightScale - BALL_RADIUS;
  const y = yOverride ?? BALL_RADIUS + height * (1 - 4 * halfStroke ** 2);
  const lateral = (0.25 + (physique.wingspan - 1.85) * 0.14) * handOffset;
  const position = localBallPoint(p, forward, lateral, y);
  return {
    position,
    velocity: at(p.velocity.x, -8 * height * halfStroke * frequency, p.velocity.z),
    spin: at(p.velocity.z * 0.75, handOffset * 2.1, -p.velocity.x * 0.75),
    dribbleHand: handOffset < 0 ? -1 : 1,
  };
}
