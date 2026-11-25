import { zeroControl } from '../contracts/index.ts';
import type { Control, GamePlayer, OffensePlay, PassType, Vec2 } from '../contracts/index.ts';
import { floppyAction } from './playbooks.ts';
import type { Screen } from './playbooks.ts';
import { bestBy, big, clamp, closeout, distance, highPostHub, move, noise, passingLane } from './spatial.ts';

/** Select pass type cleanly from cutter context, passing lane tightness, and passer flair. */
export function choosePassType(
  passer: GamePlayer,
  mate: GamePlayer,
  lane: number,
  gap: number,
  lobCut: boolean,
  level: number,
  tick: number,
  seed: number,
): PassType {
  if (lobCut) return 'lob';
  if (
    level >= 2 &&
    passer.profile.ratings.passing >= 88 &&
    gap >= 3.5 &&
    gap <= 8.0 &&
    lane > 0.95 &&
    noise(passer.id + mate.id, seed, Math.floor(tick / 12)) < 0.22
  ) {
    return 'flashy';
  }
  if (lane > 0.72 && lane < 1.25 && gap < 6.8) return 'bounce';
  return 'chest';
}

/** Off-ball spacing, active relocation to passing windows, backdoor cuts on overplays, P&R & Floppy actions. */
export function offensiveSupport(
  p: GamePlayer,
  owner: GamePlayer,
  mates: readonly GamePlayer[],
  foes: readonly GamePlayer[],
  rim: Vec2,
  tick: number,
  screen: Screen | undefined,
  transition: boolean,
  play: OffensePlay,
): Control {
  const sign = Math.sign(rim.x);
  const slot = mates.indexOf(p);
  const flank = slot % 2 ? -1 : 1;
  const corner = slot < 2;
  const cornerDepth = p.profile.ratings.shooting >= 76 ? 1.2 : 3.1;
  let target: Vec2 = { x: rim.x - sign * (corner ? cornerDepth : 5.95), z: flank * (corner ? 6.85 : 4.65) };

  if (play === 'iso') {
    const oppSide = owner.position.z >= 0 ? -1 : 1;
    const spreadZ = slot === 0 ? oppSide * 6.85 : slot === 1 ? -oppSide * 6.85 : slot === 2 ? oppSide * 5.85 : -oppSide * 5.65;
    target = { x: rim.x - sign * (slot < 2 ? 1.3 : 6.75), z: spreadZ };
  } else if (play === 'fiveOut') {
    target = { x: rim.x - sign * (corner ? 1.4 : 6.4), z: flank * (corner ? 6.9 : 5.6) };
  } else if (play === 'pickAndRoll' && screen?.screener !== p.id) {
    const away = screen ? -screen.side : (owner.position.z >= 0 ? -1 : 1);
    target = { x: rim.x - sign * (corner ? 1.25 : 6.0), z: slot === 0 ? away * 6.85 : flank * 5.8 };
  }

  if (distance(target, owner.position) < 2.4) target.x -= sign * 3.6;

  if (transition) {
    const inside = big(p) && p === bestBy(mates, q => q.profile.ratings.finishing + (big(q) ? 15 : 0));
    target = {
      x: clamp(owner.position.x + sign * (inside ? 7.8 : 4.7 - (slot > 1 ? 4 : 0)), -11.4, 11.4),
      z: inside ? flank * 1.5 : flank * (slot > 1 ? 3.4 : 5.9),
    };
    return { move: move(p.position, target), sprint: distance(p.position, target) > 3.4 };
  }

  if (screen?.screener === p.id) {
    const hold = screen.planted === undefined || tick < screen.planted + 24;
    if (hold) {
      if (distance(p.position, screen.spot) < 0.48) return { ...zeroControl(), screen: true };
      return { move: move(p.position, screen.spot), sprint: distance(p.position, screen.spot) > 3.8 };
    }
    target = screen.pop
      ? { x: rim.x - sign * 7.2, z: -screen.side * 4.4 }
      : { x: rim.x - sign * 0.9, z: -screen.side * 1.05 };
    return { move: move(p.position, target), sprint: !screen.pop && distance(p.position, target) > 1.2 };
  }

  if (play === 'floppy' && !screen) {
    return floppyAction(p, owner, mates, foes, rim, tick);
  }

  if (play === 'motion' && highPostHub(p) && distance(owner.position, rim) > 4.5) {
    const elbow = { x: rim.x - sign * 4.85, z: owner.position.z > 0 ? -2.1 : 2.1 };
    if (distance(p.position, rim) > 3.45 && passingLane(owner.position, elbow, foes) > 0.66) target = elbow;
    return { move: move(p.position, target), sprint: distance(p.position, target) > 3.6 };
  }

  // Overplay backdoor cut when defender hugs or denies passing lane along the wing/corner.
  if (play === 'motion' || play === 'fiveOut' || play === 'pickAndRoll') {
    const guard = bestBy(foes, q => -distance(p.position, q.position));
    const cutSpot = { x: rim.x - sign * 1.35, z: clamp(p.position.z * 0.35, -1.65, 1.65) };
    if (
      guard &&
      distance(guard.position, p.position) < 1.35 &&
      distance(p.position, rim) > 3.2 &&
      (distance(guard.position, rim) > distance(p.position, rim) - 0.15 || passingLane(owner.position, p.position, [guard]) < 0.55) &&
      passingLane(owner.position, cutSpot, foes) > 0.65
    ) {
      return { move: move(p.position, cutSpot), sprint: true };
    }
  }

  // Motion corner/wing relocation & timed cuts.
  let cutting = false;
  if (play === 'motion' && corner && p.profile.ratings.shooting >= 92 && distance(owner.position, rim) < 4.1) {
    const wing = { x: rim.x - sign * 5.25, z: flank * 5.55 };
    if (passingLane(owner.position, wing, foes) > passingLane(owner.position, target, foes) + 0.6) target = wing;
  }

  const cutter = bestBy(mates, q => q.profile.ratings.finishing + (big(q) ? 9 : 0) - q.profile.ratings.shooting * 0.62);
  if (play === 'motion' && !screen && p === cutter && distance(owner.position, rim) > 3.8 && (tick % 210 < 75 || highPostHub(owner))) {
    const cut = { x: rim.x - sign * 1.28, z: owner.position.z > 0 ? -1.35 : 1.35 };
    const lane = passingLane(p.position, cut, foes);
    if (lane > 0.65 || distance(p.position, cut) < 2) {
      target = cut;
      cutting = true;
    }
  } else if (play === 'motion') {
    const wave = Math.sin(tick * 0.025 + slot * 1.65);
    const drift = Math.cos(tick * 0.022 + slot * 1.4);
    target = {
      x: clamp(target.x + wave * (corner ? 0.65 : 1.15), -12.6, 12.6),
      z: clamp(target.z + drift * (corner ? 0.35 : 0.95) * -flank, -7.0, 7.0),
    };
    if (Math.sign(owner.position.z || 1) === Math.sign(target.z || 1) && distance(owner.position, target) < 3.4) {
      target = corner
        ? { x: rim.x - sign * 5.8, z: flank * 4.4 }
        : { x: rim.x - sign * 1.5, z: -Math.sign(owner.position.z || 1) * 6.75 };
    }
    if (!screen && p.profile.ratings.finishing >= 78 && (tick + slot * 55) % 165 < 42 && distance(owner.position, rim) > 3.5) {
      const cutSpot = { x: rim.x - sign * 1.35, z: -flank * 1.35 };
      if (passingLane(p.position, cutSpot, foes) > 0.72) {
        target = cutSpot;
        cutting = true;
      }
    }
  }

  // Active relocation into open passing windows when lane is clogged or handler drives deep.
  if (!cutting && !screen && p.profile.ratings.shooting >= 74 && play !== 'iso') {
    const currentLane = passingLane(owner.position, target, foes);
    const ownerDriving = distance(owner.position, rim) < 4.5;
    if (currentLane < 0.78 || ownerDriving) {
      const candidates: Vec2[] = [
        { x: rim.x - sign * 1.45, z: flank * 6.85 },
        { x: rim.x - sign * 4.95, z: flank * 5.75 },
        { x: rim.x - sign * 6.85, z: flank * 2.95 },
      ];
      const windowSpot = bestBy(candidates, spot => passingLane(owner.position, spot, foes) + closeout(spot, foes, 2) * 0.5);
      if (
        windowSpot &&
        passingLane(owner.position, windowSpot, foes) + closeout(windowSpot, foes, 2) * 0.45 >
          currentLane + closeout(target, foes, 2) * 0.45 + 0.32
      ) {
        target = windowSpot;
      }
    }
  }

  // Teammate spacing repulsion to preserve clean 5-man driving & passing lanes.
  if (!cutting && play !== 'iso') {
    for (const mate of mates) {
      if (mate === p) continue;
      const d = distance(target, mate.position);
      if (d < 2.55) {
        const pushZ = Math.sign(target.z - mate.position.z || flank) * (2.55 - d) * 0.55;
        target = { x: target.x, z: clamp(target.z + pushZ, -7.0, 7.0) };
      }
    }
  }

  return { move: move(p.position, target), sprint: distance(p.position, target) > 2.8 || cutting };
}
