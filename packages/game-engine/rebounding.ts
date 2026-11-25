import type { Control, GamePlayer, Vec2, Vec3 } from '../contracts/index.ts';
import { vector as at } from './physics-ball.ts';
import { clamp, distance, DT, LIMIT_X, LIMIT_Z } from './types.ts';
import type { PlayerBody, Runtime, Snapshot } from './types.ts';

/** Compute physical inside box-out seals during live shots and pending rebounds. */
export function stepBoxOuts(
  state: Snapshot,
  sim: Runtime,
  controls: Readonly<Record<string, Control>>,
  body: (p: GamePlayer) => PlayerBody,
  rim: Vec2,
  half: boolean,
): void {
  const glassActive = state.ball.kind === 'shot' || (state.ball.kind === 'loose' && !!sim.pendingRebound);
  if (!glassActive) {
    sim.boxOut = {};
    return;
  }

  const nextBoxOut: Record<string, string> = {};
  const minX = half ? 0.32 : -LIMIT_X;

  for (const p of state.players) {
    const ctrl = controls[p.id];
    const wantsBox = (!!ctrl?.screen && !ctrl?.callScreen) || !!ctrl?.intenseD || p.pose === 'screen';
    if (!wantsBox) continue;

    const pRimDist = distance(p.position, rim);
    let bestOpp: GamePlayer | undefined;
    let bestDist = Infinity;
    for (const opp of state.players) {
      if (opp.side === p.side) continue;
      const d = distance(p.position, opp.position);
      if (d > 1.55) continue;
      const oppRimDist = distance(opp.position, rim);
      if (pRimDist <= oppRimDist + 0.14 && d < bestDist) {
        bestDist = d;
        bestOpp = opp;
      }
    }
    if (!bestOpp) continue;

    nextBoxOut[p.id] = bestOpp.id;

    const pBody = body(p);
    const oBody = body(bestOpp);
    const pPower = pBody.leverage * (0.65 + p.profile.ratings.rebounding * 0.006);
    const oPower = oBody.leverage * (0.65 + bestOpp.profile.ratings.rebounding * 0.006 + (controls[bestOpp.id]?.sprint ? 0.10 : 0));
    const sealStrength = clamp(pPower / Math.max(0.25, oPower), 0.55, 1.85);

    let outX = bestOpp.position.x - rim.x;
    let outZ = bestOpp.position.z - rim.z;
    let outLen = Math.hypot(outX, outZ);
    if (outLen < 0.05) {
      outX = bestOpp.position.x - p.position.x;
      outZ = bestOpp.position.z - p.position.z;
      outLen = Math.max(0.05, Math.hypot(outX, outZ));
    }
    outX /= outLen;
    outZ /= outLen;

    const outVel = bestOpp.velocity.x * outX + bestOpp.velocity.z * outZ;
    if (outVel < 0) {
      const cancelFrac = clamp(0.55 * sealStrength, 0.42, 0.90);
      bestOpp.velocity.x -= outX * outVel * cancelFrac;
      bestOpp.velocity.z -= outZ * outVel * cancelFrac;
    }

    const nudge = 0.45 * sealStrength * DT;
    bestOpp.position.x = clamp(bestOpp.position.x + outX * nudge, minX, LIMIT_X);
    bestOpp.position.z = clamp(bestOpp.position.z + outZ * nudge, -LIMIT_Z, LIMIT_Z);
  }

  sim.boxOut = nextBoxOut;
}

/** Vertical reach ceiling for rebound or loose-ball attempts, incorporating jump apex curve & seal leverage. */
export function reboundReachY(
  p: GamePlayer,
  physique: PlayerBody,
  controls: Readonly<Record<string, Control>>,
  sim: Runtime,
  tick: number,
  isSealed: boolean,
): { reachY: number; apexBonus: number; jumping: boolean } {
  const jumping = !!controls[p.id]?.contest || (sim.jumpContest?.[p.id] ?? 0) > tick;
  const elapsed = sim.jumpContestStart?.[p.id] !== undefined ? Math.max(0, tick - sim.jumpContestStart[p.id]) : 0;
  const apexBonus = jumping ? 0.06 + 0.18 * Math.sin(clamp(elapsed / 22, 0, 1) * Math.PI) : 0;
  const ratingBonus = (p.profile.ratings.rebounding - 70) * 0.0015;
  const sealPenalty = isSealed ? 0.15 : 0;
  const reachY = jumping
    ? physique.reach + 0.22 + apexBonus + ratingBonus - sealPenalty
    : physique.reach - 0.14 - sealPenalty * 0.5;
  return { reachY, apexBonus, jumping };
}

export type LooseBallOutcome =
  | { kind: 'grab'; winner: GamePlayer }
  | { kind: 'tip'; tipper: GamePlayer; velocity: Vec3; spin: Vec3 }
  | null;

/** Resolve contested glass rebounds, tip-outs, and loose-ball hustle battles. */
export function resolveLooseBall(
  state: Snapshot,
  sim: Runtime,
  controls: Readonly<Record<string, Control>>,
  body: (p: GamePlayer) => PlayerBody,
  rim: Vec2,
  canAct: (key: string, cooldown: number) => boolean,
  random: () => number,
): LooseBallOutcome {
  const ball = state.ball;
  const boxMap = sim.boxOut ?? {};
  const sealerIds = new Set(Object.keys(boxMap));
  const sealedIds = new Set(Object.values(boxMap));

  const contenders: Array<{ player: GamePlayer; score: number }> = [];
  for (const p of state.players) {
    const physique = body(p);
    const isSealing = sealerIds.has(p.id);
    const isSealed = sealedIds.has(p.id);
    const { reachY, apexBonus, jumping } = reboundReachY(p, physique, controls, sim, state.tick, isSealed);
    const grabRadius = 1.04 + (physique.wingspan - 2) * 0.38 + (jumping ? 0.10 : 0) + (!sim.pendingRebound && controls[p.id]?.steal ? 0.14 : 0);
    const d = distance(p.position, ball.position);
    if (d > grabRadius || ball.position.y >= reachY) continue;

    const proximityScore = 1.5 - d;
    const ratingScore = p.profile.ratings.rebounding * 0.0085;
    const verticalScore = (reachY - ball.position.y) * 0.32 + (jumping ? apexBonus * 1.1 : 0);
    const boxScore = (isSealing ? 0.38 * physique.leverage : 0) - (isSealed ? 0.32 : 0);
    const hustleScore = !sim.pendingRebound
      ? Math.hypot(p.velocity.x, p.velocity.z) * 0.055 + (controls[p.id]?.steal ? 0.22 : 0)
      : 0;
    contenders.push({ player: p, score: proximityScore + ratingScore + verticalScore + boxScore + hustleScore });
  }

  if (!contenders.length) return null;
  contenders.sort((a, b) => b.score - a.score);
  const top = contenders[0];
  const rival = contenders.find(c => c.player.side !== top.player.side);

  // Closely contested high rebound battles can spark physical tip-outs into open space.
  if (
    sim.pendingRebound &&
    rival &&
    top.score - rival.score < 0.22 &&
    ball.position.y > 1.75 &&
    canAct('glass/tip', 28) &&
    random() < 0.40
  ) {
    const mates = state.players.filter(q => q.side === top.player.side && q.id !== top.player.id && distance(q.position, rim) > 3.2);
    let dirX = top.player.position.x - rim.x;
    let dirZ = top.player.position.z - rim.z;
    if (mates.length > 0) {
      const nearestMate = mates.reduce((best, m) =>
        distance(m.position, ball.position) < distance(best.position, ball.position) ? m : best,
      );
      dirX = nearestMate.position.x - ball.position.x;
      dirZ = nearestMate.position.z - ball.position.z;
    }
    const dirLen = Math.max(0.05, Math.hypot(dirX, dirZ));
    const speed = 2.6 + random() * 1.4;
    return {
      kind: 'tip',
      tipper: top.player,
      velocity: at((dirX / dirLen) * speed, 3.0 + random() * 0.9, (dirZ / dirLen) * speed),
      spin: at((random() - 0.5) * 6, (random() - 0.5) * 6, (random() - 0.5) * 6),
    };
  }

  return { kind: 'grab', winner: top.player };
}
