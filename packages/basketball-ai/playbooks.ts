import { zeroControl } from '../contracts/index.ts';
import type { Control, GamePlayer, ScreenMode, Vec2 } from '../contracts/index.ts';
import { bestBy, big, clamp, closeout, distance, move, passingLane } from './spatial.ts';

export type Screen = {
  screener: string;
  spot: Vec2;
  side: number;
  pop: boolean;
  started: number;
  planted?: number;
  manual?: boolean;
};

/** Select screener, screen spot, and Roll-vs-Fade behavior. */
export function screenCall(
  owner: GamePlayer,
  mates: readonly GamePlayer[],
  foes: readonly GamePlayer[],
  rim: Vec2,
  tick: number,
  manual = false,
  preferredMode?: ScreenMode,
): Screen | undefined {
  const range = distance(owner.position, rim);
  const minRange = manual ? 2.6 : 3.2;
  const maxRange = manual ? 12.0 : 11.2;
  if (range < minRange || range > maxRange || Math.abs(owner.position.z) > (manual ? 6.8 : 6.0)) return undefined;
  const marker = bestBy(foes, p => -distance(owner.position, p.position));
  if (!marker || distance(marker.position, owner.position) > (manual ? 5.8 : 5.2)) return undefined;
  const screener = bestBy(
    mates.filter(p => distance(p.position, owner.position) < (manual ? 11.5 : 9.8)),
    p => (big(p) ? 16 : 0) + (p.profile.ratings.strength ?? 60) * 0.2 + p.profile.ratings.finishing * 0.09 - distance(owner.position, p.position) * 3,
  );
  if (!screener) return undefined;
  const side = Math.abs(owner.position.z) > 2 ? -Math.sign(owner.position.z) : marker.position.z < owner.position.z ? 1 : -1;
  const spot = {
    x: clamp(marker.position.x - Math.sign(rim.x) * 0.12, owner.position.x - 1.25, owner.position.x + 1.25),
    z: owner.position.z + side * 1.15,
  };
  const pop = preferredMode
    ? preferredMode === 'fade'
    : screener.profile.ratings.shooting >= Math.max(83, screener.profile.ratings.finishing + 3);
  return { screener: screener.id, spot, side, pop, started: tick, ...(manual ? { manual: true } : {}) };
}

export function screenLane(screen: Screen, rim: Vec2): Vec2 {
  return { x: screen.spot.x + Math.sign(rim.x) * 1.65, z: screen.spot.z + screen.side * 0.75 };
}

/** Off-ball double pin-down Floppy action for top shooter and twin big screeners. */
export function floppyAction(
  p: GamePlayer,
  owner: GamePlayer,
  mates: readonly GamePlayer[],
  foes: readonly GamePlayer[],
  rim: Vec2,
  tick: number,
): Control {
  const sign = Math.sign(rim.x);
  const shooter = bestBy(mates, q => q.profile.ratings.shooting + (big(q) ? -8 : 0)) ?? mates[0];
  const others = mates
    .filter(q => q !== shooter)
    .sort((a, b) =>
      ((big(b) ? 20 : 0) + (b.profile.ratings.strength ?? 60) * 0.25 + b.profile.ratings.rebounding * 0.1) -
      ((big(a) ? 20 : 0) + (a.profile.ratings.strength ?? 60) * 0.25 + a.profile.ratings.rebounding * 0.1),
    );
  const screeners = others.slice(0, 2);

  const wingScore = (side: -1 | 1) => {
    const spot = { x: rim.x - sign * 5.75, z: side * 5.35 };
    return passingLane(owner.position, spot, foes) * 1.4 + closeout(spot, foes, 2);
  };
  const curlSide: -1 | 1 = wingScore(1) >= wingScore(-1) ? 1 : -1;

  if (p === shooter) {
    const setupPhase = tick % 160 < 28 && distance(p.position, { x: rim.x - sign * 2.1, z: 0 }) > 2.4 && distance(p.position, rim) > 3.6;
    const target = setupPhase
      ? { x: rim.x - sign * 1.9, z: 0 }
      : { x: rim.x - sign * 5.75, z: curlSide * 5.35 };
    return { move: move(p.position, target), sprint: distance(p.position, target) > 1.8 };
  }

  const screenerIdx = screeners.indexOf(p);
  if (screenerIdx >= 0) {
    let side: -1 | 1 = curlSide;
    if (screeners.length === 2) {
      const [first, second] = screeners;
      const firstOnPos = first.position.z >= second.position.z;
      side = screenerIdx === 0 ? (firstOnPos ? 1 : -1) : (firstOnPos ? -1 : 1);
    }
    const pinSpot = { x: rim.x - sign * 3.15, z: side * 2.45 };
    if (distance(p.position, pinSpot) < 0.55) {
      return { ...zeroControl(), screen: true };
    }
    return { move: move(p.position, pinSpot), sprint: distance(p.position, pinSpot) > 2.4 };
  }

  // Remaining wing spaces opposite deep corner for balanced floor kick-out.
  const spacer = { x: rim.x - sign * 1.35, z: -curlSide * 6.85 };
  return { move: move(p.position, spacer), sprint: distance(p.position, spacer) > 2.8 };
}

export function driveTarget(owner: GamePlayer, rim: Vec2, foes: readonly GamePlayer[], level: number): Vec2 {
  const sign = Math.sign(rim.x);
  const range = distance(owner.position, rim);
  const { shooting, finishing, handling } = owner.profile.ratings;
  const highPost = big(owner) && owner.profile.ratings.passing >= 87 && owner.profile.ratings.iq >= 78;
  const lanes = [-1, 1].map(side => ({ x: rim.x - sign * (range > 8.2 ? 6.3 : 0.9), z: side * (range > 4 ? 2.3 : 0.35) }));
  const target = bestBy(lanes, point => passingLane(owner.position, point, foes) * (0.72 + level * 0.13) - distance(owner.position, point) * 0.11)!;
  if (range > 8.5 && shooting >= 92 && shooting >= finishing - 4) return { x: rim.x - sign * 7.5, z: Math.sign(target.z) * 1.9 };
  if (range > 6.4 && range < 8.8 && highPost) return { x: rim.x - sign * 4.55, z: Math.sign(target.z) * 2.1 };
  if (range > 5.9 && range < 8.3 && handling >= 86 && finishing >= 87 && shooting < 90) return { x: rim.x - sign * 5.1, z: Math.sign(target.z) * 1.8 };
  return target;
}

export function shotType(owner: GamePlayer, rim: Vec2, foes: readonly GamePlayer[]): Control['shotType'] {
  const range = distance(owner.position, rim);
  const { finishing, shooting, handling } = owner.profile.ratings;
  const space = closeout(owner.position, foes, 0);
  if (range < 2.25 && finishing >= 89 && space > 1.35 && owner.profile.height >= 1.92) return 'dunk';
  if (range >= 1.9 && range < 3.6 && !big(owner) && finishing >= 83 && handling >= 80 && space < 1.75) return 'euro';
  if (range < 2.25) return 'layup';
  if (range < 3.75 && big(owner) && space < 2.2) return 'hook';
  if (range < 3.9 && !big(owner) && space < 2.3) return 'floater';
  if ((owner.action?.dribbleMove === 'stepBack' || (shooting >= 84 && range >= 5.4 && range < 8.6 && space >= 0.85 && space < 1.75)) && handling >= 75) return 'stepBack';
  if (range < 5.7 && !big(owner) && finishing > shooting + 4 && handling >= 86 && space < 2.3) return 'fadeaway';
  return 'jump';
}
