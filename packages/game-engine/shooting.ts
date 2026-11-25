import { COURT } from '../contracts/index.ts';
import type { ContestLevel, GamePlayer, ShotMeterState, ShotType, Vec2, Vec3 } from '../contracts/index.ts';
import { localBallPoint } from './dribble.ts';
import { vector as at } from './physics-ball.ts';
import { clamp, distance, IDEAL_RELEASE, MAX_CHARGE } from './types.ts';
import type { DribbleRuntime, GatherState, PlayerBody } from './types.ts';

export type { GatherState } from './types.ts';

export const SHOT_LABELS: Record<ShotType, string> = {
  dunk: 'Dunk',
  contactDunk: 'Contact dunk',
  layup: 'Layup',
  reverseLayup: 'Reverse layup',
  floater: 'Floater',
  hook: 'Hook',
  fadeaway: 'Fadeaway',
  jump: 'Jump shot',
  pullUp: 'Pull-up',
  stepBack: 'Step-back',
  euro: 'Euro step',
};

/** Select the contextual shot/finishing style from spacing, speed, dribble history, and defenders. */
export function chooseShotStyle(
  p: GamePlayer,
  range: number,
  gather: Pick<GatherState, 'style' | 'approach' | 'sprint' | 'backward'>,
  dribble: DribbleRuntime | undefined,
  dunkReachHeight: number,
  tick: number,
  nearestDefDist = 99,
  defInPaintLane = false,
): ShotType {
  const driving = gather.approach >= 2.3 && range < 3.4;
  const inside = range < 2.45 || driving;
  const canDunk = (range < (gather.sprint ? 2.9 : 2.35) || driving) && dunkReachHeight >= COURT.rimHeight + 0.07;
  const canContactDunk = canDunk && defInPaintLane && nearestDefDist < 1.55 &&
    (p.profile.ratings.finishing >= 78 || (p.profile.ratings.strength ?? 65) >= 75);
  const attack = p.position.x >= 0 ? 1 : -1;
  const deepBaseline = p.position.x * attack > COURT.rimX - 0.62 && Math.abs(p.position.z) > 0.65;

  if (gather.style === 'contactDunk') return canDunk ? 'contactDunk' : inside ? 'layup' : 'jump';
  if (gather.style === 'dunk') return canContactDunk ? 'contactDunk' : canDunk ? 'dunk' : inside ? 'layup' : 'jump';
  if (gather.style === 'reverseLayup') return inside || range < 3.4 ? 'reverseLayup' : 'floater';
  if (gather.style === 'euro') return range < 3.8 ? 'euro' : 'floater';
  if (gather.style === 'layup' && !inside) return 'floater';
  if (gather.style) return gather.style;

  if (inside) {
    if (canDunk && (gather.sprint || driving)) return canContactDunk ? 'contactDunk' : 'dunk';
    if (deepBaseline && (driving || gather.approach >= 1.5)) return 'reverseLayup';
    return 'layup';
  }
  if ((dribble?.lastMoveType === 'stepBack' || dribble?.lastMoveType === 'snatchBack') &&
    tick - dribble.lastMoveTick <= 36 && range >= 2.6) {
    return 'stepBack';
  }
  if (gather.backward) return 'fadeaway';
  if (range >= 3.2 && gather.approach >= 2.1) return 'pullUp';
  if (range >= 4.4) return 'jump';
  return p.profile.position === 'PF' || p.profile.position === 'C' ? 'hook' : 'floater';
}

/** Per-style ideal release timing in seconds (driving finishes release faster than set jumpers). */
export function idealReleaseFor(style: ShotType, driving: boolean): number {
  if (driving && (style === 'dunk' || style === 'contactDunk' || style === 'layup' || style === 'reverseLayup' || style === 'euro')) {
    return 0.46;
  }
  switch (style) {
    case 'floater': return 0.54;
    case 'layup':
    case 'reverseLayup':
    case 'euro':
    case 'hook':
      return 0.58;
    case 'pullUp': return 0.60;
    case 'stepBack':
    case 'fadeaway':
      return 0.64;
    default: return IDEAL_RELEASE;
  }
}

export function shotReleasePoint(
  p: GamePlayer,
  physique: PlayerBody,
  range: number,
  style: ShotType,
  dunkReachHeight: number,
): Vec3 {
  const height = style === 'dunk' || style === 'contactDunk'
    ? dunkReachHeight - 0.015
    : physique.reach + (style === 'layup' || style === 'reverseLayup' || style === 'euro' ? 0.22 : style === 'hook' ? 0.17 : 0.13);
  const forward = Math.min(style === 'dunk' || style === 'contactDunk' ? 0.52 : 0.24, Math.max(0, range - 0.05));
  const lateral = style === 'dunk' || style === 'contactDunk'
    ? 0.036
    : style === 'hook' || style === 'reverseLayup'
      ? 0.26 * (p.position.z >= 0 ? -1 : 1)
      : 0.068;
  return localBallPoint(p, forward, lateral, height);
}

export function computeGatherMotion(
  p: GamePlayer,
  physique: PlayerBody,
  range: number,
  style: ShotType,
  charge: number,
  gather: GatherState,
  dunkReachHeight: number,
): { jumpHeight: number; gatherPhase: number; ballPosition: Vec3 } {
  const ideal = gather.idealRelease ?? IDEAL_RELEASE;
  const gatherPhase = clamp(charge / ideal, 0, 1);
  const peakJump = style === 'contactDunk' ? 0.68
    : style === 'dunk' ? 0.62
      : style === 'layup' || style === 'reverseLayup' || style === 'euro' ? 0.42
        : style === 'stepBack' || style === 'fadeaway' || style === 'pullUp' ? 0.37
          : 0.32;
  const riseStart = ideal * 0.32;
  const riseSpan = Math.max(0.16, ideal - riseStart);
  const riseT = clamp((charge - riseStart) / riseSpan, 0, 1);
  const jumpHeight = riseT > 0 ? Math.sin(riseT * Math.PI * 0.5) * peakJump : 0;

  const rest = localBallPoint(p, 0.30, gather.handOffset, gather.height);
  const pocket = localBallPoint(p, 0.28, gather.handOffset * 0.2, physique.height * 0.66);
  const release = shotReleasePoint(p, physique, range, style, dunkReachHeight);

  let ballPosition: Vec3;
  if (charge < riseStart) {
    const t = clamp(charge / Math.max(0.05, riseStart), 0, 1);
    const ease = t * t * (3 - 2 * t);
    ballPosition = at(
      rest.x + (pocket.x - rest.x) * ease,
      rest.y + (pocket.y - rest.y) * ease,
      rest.z + (pocket.z - rest.z) * ease,
    );
  } else {
    const t = riseT;
    const ease = t * t * (3 - 2 * t);
    ballPosition = at(
      pocket.x + (release.x - pocket.x) * ease,
      pocket.y + (release.y - pocket.y) * ease,
      pocket.z + (release.z - pocket.z) * ease,
    );
  }
  return { jumpHeight, gatherPhase, ballPosition };
}

/**
 * Compute dynamic green release window scaled by rating, fatigue (stamina),
 * distance from the rim, defensive pressure, catch-and-shoot, rhythm, and hot streak.
 */
export function computeGreenWindow(
  rating: number,
  error: number,
  pressure: number,
  contact: number,
  catchAndShoot: boolean,
  rhythm: boolean,
  hotStreak = false,
  stamina = 100,
  range = 4.0,
): { greenWindow: number; isGreen: boolean } {
  const staminaFactor = stamina >= 70 ? 1 : clamp(0.55 + (stamina / 70) * 0.45, 0.55, 1);
  const distPenalty = Math.max(0, range - 6.8) * 0.0046;
  const baseWindow = (0.068 + (rating - 60) * 0.00095) * staminaFactor;
  const greenWindow = clamp(
    baseWindow - pressure * 0.028 - distPenalty + (catchAndShoot ? 0.015 : 0) + (rhythm ? 0.015 : 0) + (hotStreak ? 0.010 : 0),
    0.020,
    0.125,
  );
  const isGreen = Math.abs(error) <= greenWindow && pressure < 0.48 && contact < 0.34;
  return { greenWindow, isGreen };
}

/** Build authoritative HUD shot meter telemetry for the currently charging shooter. */
export function computeShotMeterState(
  p: GamePlayer,
  charge: number,
  ideal: number,
  rating: number,
  pressure: number,
  contact: number,
  contestLevel: ContestLevel,
  style: ShotType,
  catchAndShoot: boolean,
  rhythm: boolean,
  hotStreak: boolean,
  rim: Vec2,
): ShotMeterState {
  const range = distance(p.position, rim);
  const { greenWindow } = computeGreenWindow(rating, 0, pressure, contact, catchAndShoot, rhythm, hotStreak, p.stamina, range);
  return {
    playerId: p.id,
    progress: charge,
    ideal,
    maxCharge: MAX_CHARGE,
    greenWindow,
    contestLevel,
    style,
  };
}
