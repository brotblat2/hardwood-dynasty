import type { Control, GamePlayer, Vec3 } from '../contracts/index.ts';
import { BALL_RADIUS, vector as at } from './physics-ball.ts';
import { clamp, distance } from './types.ts';
import type { DribbleRuntime, PlayerBody, Runtime } from './types.ts';

export type LiveBallOutcome =
  | { kind: 'none' }
  | { kind: 'bobble'; defender: GamePlayer }
  | { kind: 'loose'; defender: GamePlayer; velocity: Vec3; reason: 'bump' | 'poke' }
  | { kind: 'steal'; defender: GamePlayer };

/** Closest squared distance between a 3D segment [a, b] and a point p. */
function segmentPointDistSq(a: Vec3, b: Vec3, p: Vec3): { distSq: number; closest: Vec3 } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  const t = lenSq > 1e-8
    ? clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lenSq, 0, 1)
    : 0;
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const cz = a.z + abz * t;
  return {
    distSq: (cx - p.x) ** 2 + (cy - p.y) ** 2 + (cz - p.z) ** 2,
    closest: at(cx, cy, cz),
  };
}

/**
 * Evaluate physical live-ball collisions while dribbling against defender hips, knees, and reaching hands.
 */
export function checkLiveBallCollisions(
  owner: GamePlayer,
  dribble: DribbleRuntime,
  prevBallPos: Vec3 | undefined,
  currBallPos: Vec3,
  defenders: readonly GamePlayer[],
  controls: Readonly<Record<string, Control>>,
  getBody: (p: GamePlayer) => PlayerBody,
  tick: number,
  random: () => number,
  sim: Runtime,
): LiveBallOutcome {
  if (dribble.ballState !== 'live') return { kind: 'none' };
  const start = prevBallPos ?? currBallPos;
  const speed = Math.hypot(owner.velocity.x, owner.velocity.z);
  const active = dribble.move;
  const moveProg = active ? clamp((tick - active.started) / Math.max(1, active.duration), 0, 1) : 0;
  const exposedMove = active?.type === 'crossover' || active?.type === 'inAndOut' || active?.type === 'hesitation';
  const protectedMove = active?.type === 'behindBack' || active?.type === 'betweenLegs' || active?.type === 'spin';
  const sprinting = !!controls[owner.id]?.sprint && speed > 3.8;
  const carelessDrive = sprinting || (exposedMove && moveProg > 0.18 && moveProg < 0.78);

  for (const def of defenders) {
    if (distance(def.position, owner.position) > 1.75) continue;
    if ((sim.stun?.[def.id] ?? 0) > tick || (sim.flyBy?.[def.id] ?? 0) > tick) continue;

    const defBody = getBody(def);
    const hipY = clamp(currBallPos.y, 0.18, defBody.height * 0.65);
    const hipCenter = at(def.position.x, hipY, def.position.z);
    const hipSeg = segmentPointDistSq(start, currBallPos, hipCenter);
    const hipRadius = 0.19 + BALL_RADIUS;

    // 1. Reaching hand sphere (active authorized swipe after steal evaluation, excluding recovering lunges)
    const swiping = (sim.stealPose?.[def.id] ?? 0) > tick && !((sim.stealLunge?.[def.id] ?? 0) > tick);
    if (swiping) {
      const handCenter = at(
        def.position.x + Math.cos(def.facing) * 0.56,
        clamp(currBallPos.y, 0.45, 1.15),
        def.position.z + Math.sin(def.facing) * 0.56,
      );
      const handSeg = segmentPointDistSq(start, currBallPos, handCenter);
      const handRadius = 0.17 + BALL_RADIUS;
      if (handSeg.distSq <= handRadius * handRadius && (sim.locks[owner.id + '/liveJar'] ?? 0) <= tick) {
        sim.locks[owner.id + '/liveJar'] = tick + 28;
        const skillDiff = (def.profile.ratings.perimeter - owner.profile.ratings.handling) * 0.008;
        const stealScore = clamp(
          0.14 + skillDiff + (exposedMove ? 0.12 : 0) + (sprinting ? 0.08 : 0) - (protectedMove ? 0.16 : 0) - (dribble.protectBall ? 0.14 : 0),
          0.04,
          0.42,
        );
        const roll = random();
        if (roll < stealScore * 0.55) return { kind: 'steal', defender: def };
        if (roll < stealScore) {
          const nx = currBallPos.x - handCenter.x;
          const nz = currBallPos.z - handCenter.z;
          const nLen = Math.max(0.05, Math.hypot(nx, nz));
          return {
            kind: 'loose',
            defender: def,
            reason: 'poke',
            velocity: at((nx / nLen) * 3.1 + (random() - 0.5) * 1.4, 2.0, (nz / nLen) * 3.1 + (random() - 0.5) * 1.4),
          };
        }
      }
    }

    // 2. Physical hip/knee collision when ball path drives straight through a defender's lower body.
    if (hipSeg.distSq <= hipRadius * hipRadius) {
      // If handler is shielding cleanly at walk speed, let chest body-up handle contact without cheap turnovers.
      if (dribble.protectBall && !carelessDrive) continue;
      if ((sim.locks[owner.id + '/liveJar'] ?? 0) > tick) continue;
      if (!carelessDrive && speed < 4.6) continue;

      sim.locks[owner.id + '/liveJar'] = tick + 36;
      const nx = hipSeg.closest.x - def.position.x;
      const nz = hipSeg.closest.z - def.position.z;
      const nLen = Math.max(0.05, Math.hypot(nx, nz));
      const normalX = nx / nLen;
      const normalZ = nz / nLen;

      // High-handling guards resist bumps cleanly unless sprinting recklessly or exposing crossovers into locked-in D.
      const security = clamp(
        0.74 +
          (owner.profile.ratings.handling - def.profile.ratings.perimeter) * 0.008 +
          (owner.stamina < 35 ? -0.12 : 0) -
          (sprinting ? 0.13 : 0) -
          (exposedMove ? 0.16 : 0) -
          (sim.intenseD?.[def.id] ? 0.10 : 0),
        0.26,
        0.94,
      );

      if (random() > security) {
        const bounceSpeed = 2.4 + Math.min(3.0, speed * 0.45);
        return {
          kind: 'loose',
          defender: def,
          reason: 'bump',
          velocity: at(
            normalX * bounceSpeed + (random() - 0.5) * 1.2,
            1.7 + random() * 0.6,
            normalZ * bounceSpeed + (random() - 0.5) * 1.2,
          ),
        };
      }
      return { kind: 'bobble', defender: def };
    }
  }

  return { kind: 'none' };
}
