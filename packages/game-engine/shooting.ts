import { COURT } from '../contracts/index.ts';
import type { GamePlayer, ShotType, Vec3 } from '../contracts/index.ts';
import { vector as at } from './ball.ts';
import { localBallPoint } from './dribble.ts';
import type { DribbleRuntime, PlayerBody } from './dribble.ts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type GatherState = {
  ownerId: string;
  height: number;
  handOffset: number;
  approach: number;
  sprint: boolean;
  backward: boolean;
  style?: ShotType;
  rhythm?: boolean;
};

export function chooseShotStyle(
  p: GamePlayer,
  range: number,
  gather: Pick<GatherState, 'style' | 'approach' | 'sprint' | 'backward'>,
  dribble: DribbleRuntime | undefined,
  dunkReachHeight: number,
  tick: number,
): ShotType {
  const inside = range < 2.3;
  const canDunk = inside && dunkReachHeight >= COURT.rimHeight + 0.07;
  if (gather.style === 'dunk') return canDunk ? 'dunk' : inside ? 'layup' : 'jump';
  if (gather.style === 'euro') return range < 3.6 ? 'euro' : 'floater';
  if (gather.style === 'layup' && !inside) return 'floater';
  if (gather.style) return gather.style;
  if (inside) return canDunk && gather.sprint ? 'dunk' : 'layup';
  if (dribble?.lastMoveType === 'stepBack' && tick - dribble.lastMoveTick <= 36 && range >= 2.6) return 'stepBack';
  if (gather.backward) return 'fadeaway';
  if (range >= 4.4) return 'jump';
  return p.profile.position === 'PF' || p.profile.position === 'C' ? 'hook' : 'floater';
}

export function shotReleasePoint(
  p: GamePlayer,
  physique: PlayerBody,
  range: number,
  style: ShotType,
  dunkReachHeight: number,
): Vec3 {
  const height = style === 'dunk'
    ? dunkReachHeight - 0.015
    : physique.reach + (style === 'layup' || style === 'euro' ? 0.22 : style === 'hook' ? 0.17 : 0.13);
  const forward = Math.min(style === 'dunk' ? 0.52 : 0.24, Math.max(0, range - 0.05));
  const lateral = style === 'dunk' ? 0.036 : style === 'hook' ? 0.26 * (p.position.z >= 0 ? -1 : 1) : 0.068;
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
  const gatherPhase = clamp(charge / 0.62, 0, 1);
  const peakJump = style === 'dunk' ? 0.62
    : style === 'layup' || style === 'euro' ? 0.42
      : style === 'stepBack' || style === 'fadeaway' ? 0.38
        : 0.32;
  const riseT = clamp((charge - 0.20) / 0.42, 0, 1);
  const jumpHeight = riseT > 0 ? Math.sin(riseT * Math.PI * 0.5) * peakJump : 0;

  const rest = localBallPoint(p, 0.30, gather.handOffset, gather.height);
  const pocket = localBallPoint(p, 0.28, 0.05, physique.height * 0.66);
  const release = shotReleasePoint(p, physique, range, style, dunkReachHeight);

  let ballPosition: Vec3;
  if (charge < 0.20) {
    const t = clamp(charge / 0.20, 0, 1);
    const ease = t * t * (3 - 2 * t);
    ballPosition = at(
      rest.x + (pocket.x - rest.x) * ease,
      rest.y + (pocket.y - rest.y) * ease,
      rest.z + (pocket.z - rest.z) * ease,
    );
  } else {
    const t = clamp((charge - 0.20) / 0.42, 0, 1);
    const ease = t * t * (3 - 2 * t);
    ballPosition = at(
      pocket.x + (release.x - pocket.x) * ease,
      pocket.y + (release.y - pocket.y) * ease,
      pocket.z + (release.z - pocket.z) * ease,
    );
  }
  return { jumpHeight, gatherPhase, ballPosition };
}

export function computeGreenWindow(
  rating: number,
  error: number,
  pressure: number,
  contact: number,
  catchAndShoot: boolean,
  rhythm: boolean,
): { greenWindow: number; isGreen: boolean } {
  const greenWindow = clamp(
    0.040 + (rating - 60) * 0.00072 - pressure * 0.032 + (catchAndShoot ? 0.011 : 0) + (rhythm ? 0.012 : 0),
    0.015,
    0.078,
  );
  const isGreen = Math.abs(error) <= greenWindow && pressure < 0.38 && contact < 0.30;
  return { greenWindow, isGreen };
}
