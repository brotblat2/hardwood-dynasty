import type { BodyUpKind, ContestLevel, DribbleMove, GamePlayer, ShotType, Vec2, Vec3 } from '../contracts/index.ts';
import { clamp, distance } from './types.ts';
import type { DribbleRuntime, PlayerBody } from './types.ts';

export type BodyUpResolution = {
  kind: BodyUpKind;
  normal: Vec2;
  tangent: Vec2;
  force: number;
};

/**
 * Evaluate physical chest/hip contact between a live ball-handler and on-ball defender.
 * Computes physical wall-off (`clamp`), hip-ride steering (`ride`), or over-commitment (`blowby`).
 */
export function resolveBodyUp(
  handler: GamePlayer,
  defender: GamePlayer,
  handlerBody: PlayerBody,
  defBody: PlayerBody,
  defIntenseD: boolean,
  defDisabled: boolean,
  handlerBurst: boolean,
  handlerMove: DribbleMove | undefined,
  ballState: DribbleRuntime['ballState'],
): BodyUpResolution | undefined {
  if (defDisabled || ballState !== 'live') return undefined;
  const dist = distance(handler.position, defender.position);
  if (dist >= 1.02 || dist < 0.01) return undefined;
  const speed = Math.hypot(handler.velocity.x, handler.velocity.z);
  const minSpeed = defIntenseD && dist < 0.92 ? 0.35 : 1.15;
  if (speed < minSpeed) return undefined;

  const toDefX = (defender.position.x - handler.position.x) / dist;
  const toDefZ = (defender.position.z - handler.position.z) / dist;
  const approachDot = (handler.velocity.x * toDefX + handler.velocity.z * toDefZ) / speed;
  if (approachDot < 0.05) return undefined;

  // Normal points from defender toward handler; tangent steers laterally toward the open driving hip.
  const normal = { x: -toDefX, z: -toDefZ };
  let tanX = -toDefZ;
  let tanZ = toDefX;
  const latAlign = handler.velocity.x * tanX + handler.velocity.z * tanZ;
  if (latAlign < 0 || (Math.abs(latAlign) < 0.05 && handler.position.z * tanZ < 0)) {
    tanX = -tanX;
    tanZ = -tanZ;
  }
  const tangent = { x: tanX, z: tanZ };

  // Detect defender over-commitment (sliding hard in the opposite lateral direction or beaten past hip).
  const handlerLat = handler.velocity.x * (-toDefZ) + handler.velocity.z * toDefX;
  const defLat = defender.velocity.x * (-toDefZ) + defender.velocity.z * toDefX;
  const overCommitted = (handlerLat * defLat < -0.5 && Math.abs(handlerLat - defLat) > 2.3) ||
    (approachDot < 0.28 && Math.hypot(defender.velocity.x, defender.velocity.z) > 2.2);

  const hStrength = handler.profile.ratings.strength ?? 65;
  const dStrength = defender.profile.ratings.strength ?? 65;
  const clampScore = defender.profile.ratings.perimeter * 0.5 + dStrength * 0.35 + defBody.leverage * 22 +
    (defIntenseD ? 16 : 0) - (overCommitted ? 10 : 0);
  const driveScore = handler.profile.ratings.handling * 0.45 + hStrength * 0.3 + handlerBody.leverage * 20 +
    (handlerBurst ? 14 : 0) + (handlerMove === 'spin' ? 18 : 0) + (overCommitted ? 16 : 0);
  const force = clamp((clampScore - driveScore + 28) / 40, 0.35, 1.45);

  if (approachDot > 0.58 && !overCommitted) {
    return {
      kind: clampScore >= driveScore - 4 ? 'clamp' : 'ride',
      normal,
      tangent,
      force,
    };
  }
  if (overCommitted || ((handlerBurst || handlerMove === 'spin') && driveScore > clampScore + 4)) {
    return { kind: 'blowby', normal, tangent, force };
  }
  return defIntenseD ? { kind: 'ride', normal, tangent, force } : undefined;
}

/**
 * Timing quality curve in [0, 1] for a jump-to-block attempt.
 * Immediate leap (`0..1` ticks) keeps reactive blocks viable (0.85); ticks `2..14` hit full apex (1.0);
 * descending late (`15..22`) tapers cleanly so mistimed early jumps get punished.
 */
export function jumpApexQuality(startTick: number | undefined, currentTick: number, pressingContest: boolean): number {
  if (startTick !== undefined) {
    const age = currentTick - startTick;
    if (age < 0 || age > 22) return 0;
    if (age <= 1) return 0.85;
    if (age <= 14) return 1.0;
    return clamp(1 - (age - 14) / 13, 0.35, 0.95);
  }
  return pressingContest ? 0.85 : 0;
}

export type StealOutcome = 'steal' | 'poke' | 'foul' | 'whiff';

export function evaluateSteal(
  defender: GamePlayer,
  owner: GamePlayer,
  ballPos: Vec3,
  dribble: DribbleRuntime | undefined,
  tick: number,
  random: () => number,
  postUp = false,
  spamCount = 0,
  inBallSide = false,
): StealOutcome {
  const roll = random();
  const ballDist = distance(defender.position, ballPos);
  const bodyDist = distance(defender.position, owner.position);
  const bypassPassiveShield = defender.profile.ratings.perimeter >= owner.profile.ratings.handling + 15 && bodyDist < 0.85;
  const ballExposed = ballDist < bodyDist + 0.08 && (!dribble?.protectBall || bypassPassiveShield);
  const active = dribble?.move;
  const progress = active ? clamp((tick - active.started) / active.duration, 0, 1) : 0;
  const midCross = (active?.type === 'crossover' || active?.type === 'inAndOut') && progress > 0.20 && progress < 0.76;
  const protectedMove = active?.type === 'behindBack' || active?.type === 'betweenLegs' || active?.type === 'spin';
  const spamPenalty = Math.min(4, Math.max(0, spamCount));

  const skill = (defender.profile.ratings.perimeter - owner.profile.ratings.handling) * 0.009;
  const reach = clamp((1.25 - ballDist) * (ballExposed && !postUp ? 0.22 : 0.15), -0.09, ballExposed && !postUp ? 0.20 : 0.08);
  const spamStealDrop = spamPenalty <= 1 ? spamPenalty * 0.02 : 0.02 + (spamPenalty - 1) * 0.08;
  const stealChance = clamp(
    0.16 + skill + reach +
      (ballExposed ? 0.06 : -0.06) +
      (ballExposed && inBallSide ? 0.06 : 0) +
      (midCross ? 0.16 : 0) -
      (protectedMove || postUp ? 0.18 : 0) -
      spamStealDrop,
    0.02,
    0.66,
  );
  const pokeChance = clamp(stealChance + (ballExposed ? 0.10 : 0.06) + (midCross ? 0.06 : 0), stealChance, 0.70);
  const baseFoul = postUp ? 0.78 : ballExposed ? 0.91 : 0.84;
  const foulDrop = spamPenalty <= 1 ? spamPenalty * 0.06 : 0.06 + (spamPenalty - 1) * 0.13;
  const foulThreshold = clamp(baseFoul + (midCross ? 0.04 : 0) - (protectedMove ? 0.06 : 0) - foulDrop, 0.32, 0.95);

  if (roll < stealChance) return 'steal';
  if (roll < pokeChance) return 'poke';
  if (roll > foulThreshold) return 'foul';
  return 'whiff';
}

export type ContestResult = {
  rawPressure: number;
  pressure: number;
  contestPct: number;
  contestLevel: ContestLevel;
  closest?: GamePlayer;
};

export function computeShotContest(
  shooter: GamePlayer,
  shooterBody: PlayerBody,
  releaseHeight: number,
  rim: Vec2,
  defenders: readonly GamePlayer[],
  getBody: (p: GamePlayer) => PlayerBody,
  isContesting: (p: GamePlayer) => boolean,
  isJumpContesting: (p: GamePlayer) => boolean,
  isIntenseD: (p: GamePlayer) => boolean,
  isStunned: (p: GamePlayer) => boolean,
  isFlyBy: (p: GamePlayer) => boolean,
  style: ShotType,
  isHandsUp: (p: GamePlayer) => boolean = () => false,
  getJumpQuality: (p: GamePlayer) => number = () => 0.85,
): ContestResult {
  const closest = defenders.reduce<GamePlayer | undefined>(
    (a, q) => (!a || distance(shooter.position, q.position) < distance(shooter.position, a.position) ? q : a),
    undefined,
  );
  const toRimX = rim.x - shooter.position.x;
  const toRimZ = rim.z - shooter.position.z;
  const rimDist = Math.max(0.05, Math.hypot(toRimX, toRimZ));
  const rimUx = toRimX / rimDist;
  const rimUz = toRimZ / rimDist;

  let rawPressure = 0;
  for (const q of defenders) {
    const defBody = getBody(q);
    const reachAdv = clamp(defBody.reach - shooterBody.reach, -0.65, 0.65);
    const d = distance(q.position, shooter.position);
    const prox = clamp(1 - d / (2.40 + reachAdv * 0.55), 0, 1);
    if (prox <= 0) continue;

    const dx = d > 0.01 ? (q.position.x - shooter.position.x) / d : rimUx;
    const dz = d > 0.01 ? (q.position.z - shooter.position.z) / d : rimUz;
    const inFront = rimUx * dx + rimUz * dz;
    const angleWeight = inFront > 0.35 ? 1.0 : inFront > 0 ? 0.72 : 0.38;

    const jumping = isJumpContesting(q);
    const jumpQ = jumping ? getJumpQuality(q) : 0;
    const handsUp = isHandsUp(q);
    const contestingHeld = isContesting(q);
    const intense = isIntenseD(q);

    let effectiveReach: number;
    let stanceMult: number;
    if (jumping && jumpQ > 0) {
      effectiveReach = defBody.reach + 0.22 + 0.24 * jumpQ;
      stanceMult = (0.48 + 0.30 * jumpQ) + reachAdv * 0.32;
    } else if (handsUp || contestingHeld) {
      effectiveReach = defBody.reach + (handsUp ? 0.24 : 0.16);
      stanceMult = (handsUp ? 0.56 : 0.48) + reachAdv * 0.24;
    } else if (intense) {
      effectiveReach = defBody.reach + 0.08;
      stanceMult = 0.36 + reachAdv * 0.18;
    } else {
      effectiveReach = defBody.reach - 0.10;
      stanceMult = 0.14 + reachAdv * 0.08;
    }

    const heightMatch = clamp(1 - Math.max(0, releaseHeight - effectiveReach) * 0.8, 0.45, 1.15);
    const disableMult = isFlyBy(q) ? 0.22 : isStunned(q) ? 0.45 : 1;
    const score = prox * stanceMult * angleWeight * heightMatch * disableMult;
    if (score > rawPressure) rawPressure = score;
  }

  const stylePressureMult =
    style === 'stepBack' ? 0.54
      : style === 'fadeaway' ? 0.58
        : style === 'euro' ? 0.58
          : style === 'dunk' ? 0.55
            : style === 'contactDunk' ? 0.52
              : style === 'reverseLayup' ? 0.68
                : style === 'pullUp' ? 0.95
                  : 1;
  const pressure = rawPressure * stylePressureMult;
  const contestPct = Math.round(clamp(pressure * 145, 0, 100));
  const contestLevel: ContestLevel =
    contestPct < 4 ? 'Wide Open'
      : contestPct < 12 ? 'Open'
        : contestPct < 30 ? 'Light'
          : contestPct < 60 ? 'Tight'
            : 'Smothered';

  return { rawPressure, pressure, contestPct, contestLevel, closest };
}

/** Evaluate whether a close defender physically blocks the shot release. */
export function evaluateBlock(
  shooterBody: PlayerBody,
  defender: GamePlayer,
  defBody: PlayerBody,
  dist: number,
  style: ShotType,
  isJumpBlock: boolean,
  isHandsUp: boolean,
  apexQuality: number,
  isStunned: boolean,
  isFlyBy: boolean,
  random: () => number,
): boolean {
  const reachAdv = clamp(defBody.reach - shooterBody.reach, -0.65, 0.65);
  const blockMult = style === 'fadeaway' ? 0.55
    : style === 'stepBack' ? 0.52
      : style === 'floater' ? 0.58
        : style === 'hook' ? 0.62
          : style === 'contactDunk' ? 0.45
            : 1;

  if (isJumpBlock && apexQuality > 0) {
    if (dist >= 1.18 + reachAdv * 0.44) return false;
    const timingScale = 0.45 + 0.58 * apexQuality;
    const disableScale = isFlyBy ? 0.15 : isStunned ? 0.45 : 1;
    const chance = clamp(0.12 + defender.profile.ratings.interior * 0.002 + reachAdv * 0.45, 0.04, 0.58) *
      blockMult * timingScale * disableScale;
    return random() < chance;
  }

  // Grounded hands-up can only swat tight low-release paint attempts; perimeter jumpers shoot over it.
  if (isHandsUp && dist < 0.82 && (style === 'layup' || style === 'reverseLayup' || style === 'euro')) {
    const chance = clamp(0.06 + defender.profile.ratings.interior * 0.001 + reachAdv * 0.25, 0.02, 0.22) *
      (isFlyBy ? 0.15 : isStunned ? 0.45 : 1);
    return random() < chance * 0.45;
  }

  return false;
}
