import type { BodyUpKind, ContestLevel, DribbleMove, GamePlayer, ShotType, Vec2, Vec3 } from '../contracts/index.ts';
import type { DribbleRuntime, PlayerBody } from './dribble.ts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

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
): BodyUpKind | undefined {
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

  const hStrength = handler.profile.ratings.strength ?? 65;
  const dStrength = defender.profile.ratings.strength ?? 65;
  const clampScore = defender.profile.ratings.perimeter * 0.5 + dStrength * 0.35 + defBody.leverage * 22 + (defIntenseD ? 16 : 0);
  const driveScore = handler.profile.ratings.handling * 0.45 + hStrength * 0.3 + handlerBody.leverage * 20 +
    (handlerBurst ? 14 : 0) + (handlerMove === 'spin' ? 18 : 0);

  if (approachDot > 0.58) {
    return clampScore >= driveScore - 4 ? 'clamp' : 'ride';
  }
  if ((handlerBurst || handlerMove === 'spin') && driveScore > clampScore + 4) {
    return 'blowby';
  }
  return defIntenseD ? 'ride' : undefined;
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
): StealOutcome {
  const roll = random();
  const ballDist = distance(defender.position, ballPos);
  const bodyDist = distance(defender.position, owner.position);
  const ballExposed = ballDist < bodyDist + 0.08;
  const active = dribble?.move;
  const progress = active ? clamp((tick - active.started) / active.duration, 0, 1) : 0;
  const midCross = active?.type === 'crossover' && progress > 0.25 && progress < 0.72;
  const protectedMove = active?.type === 'behindBack' || active?.type === 'betweenLegs' || active?.type === 'spin';

  const skill = (defender.profile.ratings.perimeter - owner.profile.ratings.handling) * 0.008;
  const reach = clamp((1.25 - ballDist) * 0.15, -0.09, 0.08);
  const stealChance = clamp(
    0.16 + skill + reach + (ballExposed ? 0.06 : -0.06) + (midCross ? 0.12 : 0) - (protectedMove || postUp ? 0.14 : 0),
    0.03,
    0.48,
  );
  const pokeChance = clamp(stealChance + (ballExposed ? 0.10 : 0.06), stealChance, 0.60);
  const foulThreshold = postUp ? 0.78 : ballExposed ? 0.91 : 0.84;

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
): ContestResult {
  const closest = defenders.reduce<GamePlayer | undefined>(
    (a, q) => !a || distance(shooter.position, q.position) < distance(shooter.position, a.position) ? q : a,
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
    const prox = clamp(1 - d / (2.35 + reachAdv * 0.55), 0, 1);
    if (prox <= 0) continue;

    const dx = d > 0.01 ? (q.position.x - shooter.position.x) / d : rimUx;
    const dz = d > 0.01 ? (q.position.z - shooter.position.z) / d : rimUz;
    const inFront = rimUx * dx + rimUz * dz;
    const angleWeight = inFront > 0.35 ? 1.0 : inFront > 0 ? 0.72 : 0.38;

    const jumping = isJumpContesting(q);
    const activeHands = isContesting(q) || isIntenseD(q);
    const effectiveReach = defBody.reach + (jumping ? 0.34 : activeHands ? 0.14 : -0.10);
    const heightMatch = clamp(1 - Math.max(0, releaseHeight - effectiveReach) * 0.8, 0.45, 1.15);

    const stanceMult = jumping
      ? 0.64 + reachAdv * 0.30
      : activeHands
        ? 0.44 + reachAdv * 0.22
        : 0.15 + reachAdv * 0.09;

    const disableMult = isFlyBy(q) ? 0.22 : isStunned(q) ? 0.45 : 1;
    const score = prox * stanceMult * angleWeight * heightMatch * disableMult;
    if (score > rawPressure) rawPressure = score;
  }

  const stylePressureMult =
    style === 'stepBack' ? 0.54
      : style === 'fadeaway' ? 0.58
        : style === 'euro' ? 0.58
          : style === 'dunk' ? 0.55
            : 1;
  const pressure = rawPressure * stylePressureMult;
  const contestPct = Math.round(clamp(pressure * 145, 0, 100));
  const contestLevel: ContestLevel =
    contestPct < 10 ? 'Open'
      : contestPct < 28 ? 'Light'
        : contestPct < 58 ? 'Tight'
          : 'Smothered';

  return { rawPressure, pressure, contestPct, contestLevel, closest };
}
