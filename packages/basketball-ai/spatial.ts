import { COURT } from '../contracts/index.ts';
import type { Difficulty, GamePlayer, GameState, Side, Vec2 } from '../contracts/index.ts';

export const levels: Difficulty[] = ['Rookie', 'Pro', 'All-Star', 'Superstar', 'Hall of Fame', 'Legendary'];
export const positions = ['PG', 'SG', 'SF', 'PF', 'C'];

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
export const mix = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const big = (p: GamePlayer) => p.profile.position === 'PF' || p.profile.position === 'C';
export const highPostHub = (p: GamePlayer) => big(p) && p.profile.ratings.passing >= 87 && p.profile.ratings.iq >= 78;
export const opposite = (s: Side): Side => (s === 0 ? 1 : 0);

export function move(from: Vec2, to: Vec2): Vec2 {
  const dx = clamp(to.x, -13.7, 13.7) - from.x;
  const dz = clamp(to.z, -7.05, 7.05) - from.z;
  const scale = Math.max(0.65, Math.hypot(dx, dz));
  return { x: dx / scale, z: dz / scale };
}

export function noise(id: string, seed: number, cycle: number): number {
  let hash = seed ^ Math.imul(cycle + 1, 2654435761);
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

export function bestBy<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

export function closeout(point: Vec2, defenders: readonly GamePlayer[], level: number): number {
  return Math.min(5, ...defenders.map(p => distance(point, {
    x: p.position.x + p.velocity.x * level * 0.034,
    z: p.position.z + p.velocity.z * level * 0.034,
  })));
}

export function passingLane(a: Vec2, b: Vec2, defenders: readonly GamePlayer[]): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let space = 5;
  for (const { position: p } of defenders) {
    const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1);
    if (t > 0.025 && t < 0.98) space = Math.min(space, distance(p, { x: a.x + t * dx, z: a.z + t * dz }));
  }
  return space;
}

export function onArc(point: Vec2, rim: Vec2): boolean {
  return distance(point, rim) >= COURT.three || (Math.abs(point.z) >= 6.7 && point.x * Math.sign(rim.x) >= COURT.rimX - 2.7);
}

export function shotValue(p: GamePlayer, point: Vec2, defenders: readonly GamePlayer[], rim: Vec2, level: number, state: GameState): number {
  const range = distance(point, rim);
  const space = closeout(point, defenders, level);
  const { shooting, finishing, handling } = p.profile.ratings;
  const arc = onArc(point, rim);
  const street = state.config.mode === 'blacktop';
  const points = arc ? (street ? state.config.scoring?.outside ?? 2 : 3) : (street ? state.config.scoring?.inside ?? 1 : 2);
  const pressure = Math.max(0, 1 - space / 2.65) * (0.28 + level * 0.028);
  const chance = clamp(0.56 + (range < 3.2 ? finishing : shooting) * 0.004 - range * 0.027 - pressure - (100 - p.stamina) * 0.001, 0.06, 0.96);
  const perimeterCost = arc ? Math.max(0, 92 - shooting) * 0.027 + Math.max(0, range - 7.5) * 0.24 : 0;
  const midrangeBonus = !arc && range >= 3.2 && range <= 6.8 ? Math.max(0, finishing + handling - shooting - 72) * 0.009 : 0;
  const rimBonus = range < 2.4 ? Math.max(0, finishing - 63) * 0.008 : 0;
  return (points * chance - perimeterCost + midrangeBonus + rimBonus) * (street ? 2 : 1);
}
