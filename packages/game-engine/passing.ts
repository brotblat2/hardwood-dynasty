import { COURT } from '../contracts/index.ts';
import type { Control, GamePlayer, PassType, Vec2, Vec3 } from '../contracts/index.ts';
import { BALL_RADIUS, bouncePassVelocity, solveShotVelocity, vector as at } from './physics-ball.ts';
import { clamp, distance, LIMIT_X, LIMIT_Z } from './types.ts';
import type { PassFlight, PhysicalBall, PlayerBody, Runtime } from './types.ts';

function laneClearance(from: Vec2, to: Vec2, opponents?: readonly GamePlayer[]): number {
  if (!opponents?.length) return 3.5;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return 3.5;
  let minClear = 3.5;
  for (const opp of opponents) {
    const t = ((opp.position.x - from.x) * dx + (opp.position.z - from.z) * dz) / lenSq;
    if (t > 0.06 && t < 0.96) {
      const px = from.x + t * dx;
      const pz = from.z + t * dz;
      minClear = Math.min(minClear, Math.hypot(opp.position.x - px, opp.position.z - pz));
    }
  }
  return minClear;
}

/** Select best teammate aligned with `aim`, factoring openness, lane clearance, and active cuts. */
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

  const foes = opponents?.filter(o => o.side !== passer.side);
  const hoop = { x: attackDirection * COURT.rimX, z: 0 };
  let best: string | undefined;
  let bestScore = -Infinity;

  for (const teammate of candidates) {
    const dx = teammate.position.x - passer.position.x;
    const dz = teammate.position.z - passer.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.01) continue;
    const alignment = (dx * aim.x + dz * aim.z) / (d * magnitude);
    if (alignment < 0.25) continue;

    const openBonus = foes?.length
      ? Math.min(2.0, Math.min(...foes.map(o => distance(teammate.position, o.position))) * 0.42)
      : 0;
    const laneBonus = foes?.length
      ? clamp(laneClearance(passer.position, teammate.position, foes) * 0.28, 0, 0.9)
      : 0;

    const speed = Math.hypot(teammate.velocity.x, teammate.velocity.z);
    let cutterBonus = 0;
    if (speed > 1.8) {
      const rx = hoop.x - teammate.position.x;
      const rz = hoop.z - teammate.position.z;
      const rDist = Math.hypot(rx, rz);
      const rimAlign = rDist > 0.1 ? (teammate.velocity.x * rx + teammate.velocity.z * rz) / (speed * rDist) : 0;
      if (rimAlign > 0.2 || laneClearance(passer.position, teammate.position, foes) > 1.1) {
        cutterBonus = 0.55;
      }
    }

    const score = alignment * 6.8 - d * 0.10 + openBonus + laneBonus + cutterBonus + dx * attackDirection * 0.04;
    if (score > bestScore) {
      bestScore = score;
      best = teammate.id;
    }
  }
  return best;
}

/** Automatic best teammate when neither icon slot nor directional aim selects a target. */
export function pickAutoPassTarget(
  passer: GamePlayer,
  mates: readonly GamePlayer[],
  foes: readonly GamePlayer[],
  aim: Vec2,
  attackDir: number,
): GamePlayer | undefined {
  return [...mates].sort((a, b) => {
    const merit = (q: GamePlayer) => {
      const dx = q.position.x - passer.position.x;
      const dz = q.position.z - passer.position.z;
      const d = Math.hypot(dx, dz);
      const openBonus = foes.length
        ? Math.min(2.2, Math.min(...foes.map(o => distance(q.position, o.position))) * 0.45)
        : 0;
      const laneBonus = foes.length ? clamp(laneClearance(passer.position, q.position, foes) * 0.32, 0, 1.0) : 0;
      return (dx * aim.x + dz * aim.z) / Math.max(0.1, d) * 12 - d * 0.12 + dx * attackDir * 0.14 + openBonus + laneBonus;
    };
    return merit(b) - merit(a);
  })[0];
}

export type PassLaunchContext = {
  attackDir: number;
  half: boolean;
  body: (p: GamePlayer) => PlayerBody;
  dunkReach: (p: GamePlayer, approach: number) => number;
  localBall: (p: GamePlayer, forward: number, side: number, height: number) => Vec3;
  backspin: (velocity: Vec3, speed: number) => Vec3;
  random: () => number;
};

export type PassLaunchResult = {
  target: GamePlayer;
  start: Vec3;
  velocity: Vec3;
  spin: Vec3;
  flight: PassFlight;
  facing: number;
};

/** Compute 3D pass trajectory, cutter lead, spin/Magnus curve, and disguise/telegraph risk. */
export function computePassLaunch(
  passer: GamePlayer,
  target: GamePlayer,
  passType: PassType,
  foes: readonly GamePlayer[],
  ctx: PassLaunchContext,
): PassLaunchResult {
  const { attackDir, half, dunkReach, localBall, backspin, random } = ctx;
  const passing = passer.profile.ratings.passing;
  const ratingSpeedScale = 1.14 - passing * 0.0016;
  const gap = distance(passer.position, target.position);
  const hoop = { x: attackDir * COURT.rimX, z: 0 };

  const lob = passType === 'lob';
  const bounce = passType === 'bounce';
  const flashy = passType === 'flashy';

  const targetSpeed = Math.hypot(target.velocity.x, target.velocity.z);
  const baseLead = clamp(0.54 + (passing - 60) * 0.0045, 0.44, 0.84);
  let effectiveLead = baseLead;
  if (targetSpeed > 1.6) {
    const rx = hoop.x - target.position.x;
    const rz = hoop.z - target.position.z;
    const rDist = Math.hypot(rx, rz);
    const toHoopDot = rDist > 0.1 ? (target.velocity.x * rx + target.velocity.z * rz) / (targetSpeed * rDist) : 0;
    const nearestToTarget = foes.reduce<GamePlayer | undefined>(
      (best, f) => (!best || distance(f.position, target.position) < distance(best.position, target.position) ? f : best),
      undefined,
    );
    const awayFromDefDot = nearestToTarget && distance(nearestToTarget.position, target.position) > 0.05
      ? (target.velocity.x * (target.position.x - nearestToTarget.position.x) +
        target.velocity.z * (target.position.z - nearestToTarget.position.z)) /
        (targetSpeed * distance(nearestToTarget.position, target.position))
      : 0;
    if (toHoopDot > 0.15 || awayFromDefDot > 0.15) {
      effectiveLead = clamp(baseLead * 1.14, 0.50, 0.92);
    }
  }

  const rawDur = lob
    ? clamp(gap / 9.6 * ratingSpeedScale, 0.56, 1.38)
    : bounce
      ? clamp(gap / 14.5 * ratingSpeedScale, 0.22, 1.08)
      : flashy
        ? clamp(gap / 17.4 * ratingSpeedScale, 0.17, 0.96)
        : clamp(gap / 16.0 * ratingSpeedScale, 0.18, 1.05);

  const minX = half ? 0.55 : -LIMIT_X + 0.35;
  let predictedX = clamp(target.position.x + target.velocity.x * rawDur * effectiveLead, minX, LIMIT_X - 0.35);
  let predictedZ = clamp(target.position.z + target.velocity.z * rawDur * effectiveLead, -LIMIT_Z + 0.35, LIMIT_Z - 0.35);

  const alleyOop = lob && distance({ x: predictedX, z: predictedZ }, hoop) < 3.1;
  const duration = alleyOop ? clamp(gap / 8.5 * ratingSpeedScale, 0.56, 1.38) : rawDur;

  // Defender-separation lead bias for moving non-alley-oop cutters.
  if (!alleyOop && targetSpeed > 1.2 && foes.length > 0) {
    const predictedPt = { x: predictedX, z: predictedZ };
    const nearestDef = foes.reduce<GamePlayer | undefined>(
      (best, f) => (!best || distance(f.position, predictedPt) < distance(best.position, predictedPt) ? f : best),
      undefined,
    );
    if (nearestDef) {
      const defDist = distance(nearestDef.position, predictedPt);
      if (defDist < 2.4 && defDist > 0.05) {
        const nudgeMag = 0.40 * clamp((passing - 55) / 40, 0.2, 1) * clamp(1 - defDist / 2.4, 0.2, 1);
        predictedX = clamp(predictedX + ((predictedX - nearestDef.position.x) / defDist) * nudgeMag, minX, LIMIT_X - 0.35);
        predictedZ = clamp(predictedZ + ((predictedZ - nearestDef.position.z) / defDist) * nudgeMag, -LIMIT_Z + 0.35, LIMIT_Z - 0.35);
      }
    }
  }

  const endY = alleyOop
    ? Math.min(COURT.rimHeight - 0.12, dunkReach(target, 3.2))
    : lob
      ? 1.98
      : bounce
        ? 1.24
        : flashy
          ? 1.26
          : 1.28;

  const clearInLane = laneClearance(passer.position, { x: predictedX, z: predictedZ }, foes);

  // Flashy pass risk/reward: low-rating passers or crowded long flashy attempts scatter off target.
  if (flashy) {
    const crowdPenalty = clearInLane < 1.1 ? (1.1 - clearInLane) * 1.15 : 0;
    const distancePenalty = gap > 8.5 ? (gap - 8.5) * 0.35 + 0.35 : 0;
    const ratingScatter = Math.max(0, 80 - passing) * 0.055;
    const scatterRadius = passing >= 78 && distancePenalty === 0 && crowdPenalty === 0
      ? 0
      : ratingScatter + distancePenalty + crowdPenalty;
    if (scatterRadius > 0.05) {
      const scatterAngle = random() * Math.PI * 2;
      const scatterMag = (0.45 + random() * 0.55) * scatterRadius;
      predictedX = clamp(predictedX + Math.cos(scatterAngle) * scatterMag, minX - 0.15, LIMIT_X);
      predictedZ = clamp(predictedZ + Math.sin(scatterAngle) * scatterMag, -LIMIT_Z, LIMIT_Z);
    }
  }

  const end = at(predictedX, endY, predictedZ);
  const facing = Math.atan2(end.z - passer.position.z, end.x - passer.position.x);
  const start = localBall(passer, 0.19, 0, ctx.body(passer).height * 0.75);
  const spinDir = at(end.x - start.x, 0, end.z - start.z);

  const disguise = flashy ? clamp((passing - 66) * 0.015, 0, 0.42) : bounce ? 0.12 : 0;
  const telegraphed = clamp(
    (gap > 6.5 ? (gap - 6.5) * 0.07 : 0) + Math.max(0, 80 - passing) * 0.012 - disguise,
    0,
    1,
  );

  let velocity: Vec3;
  let spin: Vec3;
  const flight: PassFlight = {
    kind: 'pass',
    from: passer.id,
    target: target.id,
    age: 0,
    duration,
    bounce,
    lob,
    ...(flashy ? { flashy: true } : {}),
    ...(alleyOop ? { alleyOop: true } : {}),
    ...(disguise > 0 ? { disguise } : {}),
    ...(telegraphed > 0 ? { telegraphed } : {}),
  };

  if (bounce) {
    const bounced = bouncePassVelocity(start, end, duration);
    velocity = bounced.velocity;
    spin = backspin(velocity, -Math.hypot(velocity.x, velocity.z) / BALL_RADIUS * 0.73);
    flight.floorTime = bounced.floorTime;
  } else if (flashy) {
    // Curve laterally away from the closest lane defender via aerodynamic Magnus spin.y.
    const passDx = end.x - start.x;
    const passDz = end.z - start.z;
    let sideSign: -1 | 1 = passer.position.z >= 0 ? -1 : 1;
    if (foes.length > 0) {
      const closestLaneDef = foes.reduce<GamePlayer | undefined>(
        (best, f) => (!best || distance(f.position, end) < distance(best.position, end) ? f : best),
        undefined,
      );
      if (closestLaneDef) {
        const crossZ = passDx * (closestLaneDef.position.z - start.z) - passDz * (closestLaneDef.position.x - start.x);
        if (Math.abs(crossZ) > 0.05) sideSign = crossZ > 0 ? -1 : 1;
      }
    }
    const baseSpin = backspin(spinDir, 2.5);
    const sideSpin = sideSign * (10 + clamp((passing - 65) * 0.08, 0, 3.2));
    spin = at(baseSpin.x, sideSpin, baseSpin.z);
    velocity = solveShotVelocity(start, end, duration, spin);
  } else {
    spin = backspin(spinDir, lob ? 3.5 : 4);
    velocity = solveShotVelocity(start, end, duration, spin);
  }

  return { target, start, velocity, spin, flight, facing };
}

export type PassLaneOutcome =
  | { kind: 'intercept'; defender: GamePlayer }
  | { kind: 'deflect'; defender: GamePlayer; velocity: Vec3; spin: Vec3 }
  | null;

/** Swept 3D segment test checking defender hands/vertical reach along `[prevPos, currPos]`. */
export function checkPassLaneCollisions(
  prevPos: Vec3,
  currPos: Vec3,
  ball: PhysicalBall,
  flight: PassFlight,
  passer: GamePlayer,
  players: readonly GamePlayer[],
  controls: Readonly<Record<string, Control>>,
  sim: Runtime,
  body: (p: GamePlayer) => PlayerBody,
  tick: number,
  canAct: (key: string, cooldown: number) => boolean,
  random: () => number,
): PassLaneOutcome {
  if (flight.age < 0.09) return null;

  const segDx = currPos.x - prevPos.x;
  const segDz = currPos.z - prevPos.z;
  const segLenSq = segDx * segDx + segDz * segDz;
  const ballSpeed = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z);

  for (const q of players) {
    if (q.side === passer.side) continue;
    const ctrl = controls[q.id];
    const isStealing = !!ctrl?.steal;
    const isJumping = !!ctrl?.contest || (sim.jumpContest?.[q.id] ?? 0) > tick;
    const isHandsUp = !!sim.handsUp?.[q.id] && !isJumping;
    const physique = body(q);
    const perimeter = q.profile.ratings.perimeter;

    const t = segLenSq > 1e-8
      ? clamp(((q.position.x - prevPos.x) * segDx + (q.position.z - prevPos.z) * segDz) / segLenSq, 0, 1)
      : 1;
    const closestX = prevPos.x + t * segDx;
    const closestZ = prevPos.z + t * segDz;
    const closestY = prevPos.y + t * (currPos.y - prevPos.y);
    const xzDist = Math.hypot(q.position.x - closestX, q.position.z - closestZ);

    const maxReachY = physique.reach + (isJumping ? 0.36 : isHandsUp ? 0.14 : -0.04);
    if (closestY < 0.08 || closestY > maxReachY) continue;

    let reachDist = (isStealing ? 1.06 + (perimeter - 75) * 0.004 : isJumping ? 0.84 : isHandsUp ? 0.62 : 0.34)
      + (physique.wingspan - 2.0) * 0.30;
    if (flight.bounce && closestY < 0.85 && (isHandsUp || isJumping)) reachDist *= 0.70;
    reachDist *= clamp(1 - (flight.disguise ?? 0) * 0.45 + (flight.telegraphed ?? 0) * 0.16, 0.55, 1.25);
    if ((sim.stun?.[q.id] ?? 0) > tick || (sim.flyBy?.[q.id] ?? 0) > tick) reachDist *= 0.55;

    if (xzDist > reachDist) continue;

    const cleanDist = clamp(
      (isStealing ? 0.72 : isHandsUp ? 0.40 : 0.26) + (perimeter - 78) * 0.004 - Math.max(0, ballSpeed - 12) * 0.025,
      0.18,
      0.86,
    );
    if (xzDist <= cleanDist || (isStealing && perimeter >= 86 && xzDist <= reachDist * 0.82 && !flight.flashy)) {
      return { kind: 'intercept', defender: q };
    }

    if ((isStealing || isJumping || isHandsUp || xzDist <= 0.42) && canAct(q.id + '/deflect', 22)) {
      const defNormalX = xzDist > 0.03 ? (closestX - q.position.x) / xzDist : -Math.cos(q.facing);
      const defNormalZ = xzDist > 0.03 ? (closestZ - q.position.z) / xzDist : -Math.sin(q.facing);
      const vx = ball.velocity.x * -0.32 + defNormalX * 2.4 + (random() - 0.5) * 2.8;
      const vy = Math.max(1.9, Math.abs(ball.velocity.y) + 1.5);
      const vz = ball.velocity.z * -0.32 + defNormalZ * 2.4 + (random() - 0.5) * 2.8;
      return {
        kind: 'deflect',
        defender: q,
        velocity: at(vx, vy, vz),
        spin: at((random() - 0.5) * 6, (random() - 0.5) * 6, (random() - 0.5) * 6),
      };
    }
  }

  return null;
}
