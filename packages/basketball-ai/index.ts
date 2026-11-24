import { COURT, attackSign, zeroControl } from '../contracts/index.ts';
import type { Control, DefenseScheme, Difficulty, GamePlayer, GameState, OffensePlay, Side, Vec2 } from '../contracts/index.ts';

const levels: Difficulty[] = ['Rookie', 'Pro', 'All-Star', 'Superstar', 'Hall of Fame', 'Legendary'];
const positions = ['PG', 'SG', 'SF', 'PF', 'C'];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const mix = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
const big = (p: GamePlayer) => p.profile.position === 'PF' || p.profile.position === 'C';
const highPostHub = (p: GamePlayer) => big(p) && p.profile.ratings.passing >= 87 && p.profile.ratings.iq >= 78;
const opposite = (s: Side): Side => s === 0 ? 1 : 0;

function move(from: Vec2, to: Vec2): Vec2 {
  const dx = clamp(to.x, -13.7, 13.7) - from.x;
  const dz = clamp(to.z, -7.05, 7.05) - from.z;
  const scale = Math.max(0.65, Math.hypot(dx, dz));
  return { x: dx / scale, z: dz / scale };
}

function noise(id: string, seed: number, cycle: number) {
  let hash = seed ^ Math.imul(cycle + 1, 2654435761);
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function bestBy<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  let best: T | undefined, bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) { best = item; bestScore = value; }
  }
  return best;
}

function closeout(point: Vec2, defenders: GamePlayer[], level: number) {
  return Math.min(5, ...defenders.map(p => distance(point, {
    x: p.position.x + p.velocity.x * level * 0.034,
    z: p.position.z + p.velocity.z * level * 0.034,
  })));
}

function passingLane(a: Vec2, b: Vec2, defenders: GamePlayer[]) {
  const dx = b.x - a.x, dz = b.z - a.z;
  let space = 5;
  for (const { position: p } of defenders) {
    const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1);
    if (t > 0.025 && t < 0.98) space = Math.min(space, distance(p, { x: a.x + t * dx, z: a.z + t * dz }));
  }
  return space;
}

function onArc(point: Vec2, rim: Vec2) {
  return distance(point, rim) >= COURT.three || Math.abs(point.z) >= 6.7 && point.x * Math.sign(rim.x) >= COURT.rimX - 2.7;
}

function shotValue(p: GamePlayer, point: Vec2, defenders: GamePlayer[], rim: Vec2, level: number, state: GameState) {
  const range = distance(point, rim);
  const space = closeout(point, defenders, level);
  const { shooting, finishing, handling } = p.profile.ratings;
  const arc = onArc(point, rim);
  const street = state.config.mode === 'blacktop';
  const points = arc ? street ? state.config.scoring?.outside ?? 2 : 3 : street ? state.config.scoring?.inside ?? 1 : 2;
  const pressure = Math.max(0, 1 - space / 2.65) * (0.28 + level * 0.028);
  const chance = clamp(0.56 + (range < 3.2 ? finishing : shooting) * 0.004 - range * 0.027 - pressure - (100 - p.stamina) * 0.001, 0.06, 0.96);
  const perimeterCost = arc ? Math.max(0, 92 - shooting) * 0.027 + Math.max(0, range - 7.5) * 0.24 : 0;
  const midrangeBonus = !arc && range >= 3.2 && range <= 6.8 ? Math.max(0, finishing + handling - shooting - 72) * 0.009 : 0;
  const rimBonus = range < 2.4 ? Math.max(0, finishing - 63) * 0.008 : 0;
  return (points * chance - perimeterCost + midrangeBonus + rimBonus) * (street ? 2 : 1);
}

type Screen = { screener: string; spot: Vec2; side: number; pop: boolean; started: number; planted?: number };

function screenCall(owner: GamePlayer, mates: GamePlayer[], foes: GamePlayer[], rim: Vec2, tick: number, manual = false): Screen | undefined {
  const range = distance(owner.position, rim);
  const minRange = manual ? 2.8 : 4.2;
  const maxRange = manual ? 11.5 : 9.4;
  if (range < minRange || range > maxRange || Math.abs(owner.position.z) > (manual ? 6.8 : 5.6)) return;
  const marker = bestBy(foes, p => -distance(owner.position, p.position));
  if (!marker || distance(marker.position, owner.position) > (manual ? 5.5 : 3.8)) return;
  const screener = bestBy(mates.filter(p => distance(p.position, owner.position) < (manual ? 11 : 7.8)), p =>
    (big(p) ? 16 : 0) + (p.profile.ratings.strength ?? 60) * 0.2 + p.profile.ratings.finishing * 0.09 - distance(owner.position, p.position) * 3);
  if (!screener || (!manual && highPostHub(owner) && !big(screener))) return;
  const side = Math.abs(owner.position.z) > 2 ? -Math.sign(owner.position.z) : marker.position.z < owner.position.z ? 1 : -1;
  const spot = { x: clamp(marker.position.x - Math.sign(rim.x) * 0.12, owner.position.x - 1.25, owner.position.x + 1.25), z: owner.position.z + side * 1.15 };
  return { screener: screener.id, spot, side, pop: screener.profile.ratings.shooting >= Math.max(83, screener.profile.ratings.finishing + 3), started: tick };
}

function screenLane(screen: Screen, rim: Vec2) {
  return { x: screen.spot.x + Math.sign(rim.x) * 1.65, z: screen.spot.z + screen.side * 0.75 };
}

function offensiveSupport(
  p: GamePlayer, owner: GamePlayer, mates: GamePlayer[], foes: GamePlayer[],
  rim: Vec2, tick: number, screen: Screen | undefined, transition: boolean, play: OffensePlay,
): Control {
  const sign = Math.sign(rim.x);
  const slot = mates.indexOf(p);
  const flank = slot % 2 ? -1 : 1;
  const corner = slot < 2;
  const cornerDepth = p.profile.ratings.shooting >= 76 ? 1.2 : 3.1;
  let target = { x: rim.x - sign * (corner ? cornerDepth : 5.95), z: flank * (corner ? 6.85 : 4.65) };
  if (play === 'iso') {
    const oppSide = owner.position.z >= 0 ? -1 : 1;
    const spreadZ = slot === 0 ? oppSide * 6.85 : slot === 1 ? -oppSide * 6.85 : slot === 2 ? oppSide * 5.85 : -oppSide * 5.65;
    target = { x: rim.x - sign * (slot < 2 ? 1.3 : 6.75), z: spreadZ };
  } else if (play === 'fiveOut') {
    target = { x: rim.x - sign * (corner ? 1.4 : 6.4), z: flank * (corner ? 6.9 : 5.6) };
    const guard = bestBy(foes, q => -distance(p.position, q.position));
    if (guard && distance(guard.position, p.position) < 1.2 && distance(guard.position, rim) > distance(p.position, rim) - 0.15 && passingLane(owner.position, { x: rim.x - sign * 1.35, z: flank * 1.35 }, foes) > 0.7) {
      target = { x: rim.x - sign * 1.35, z: flank * 1.35 };
    }
  } else if (play === 'pickAndRoll' && screen?.screener !== p.id) {
    const away = screen ? -screen.side : (owner.position.z >= 0 ? -1 : 1);
    target = { x: rim.x - sign * (corner ? 1.25 : 6.0), z: slot === 0 ? away * 6.85 : flank * 5.8 };
  }
  if (distance(target, owner.position) < 2.4) target.x -= sign * 3.6;
  if (transition) {
    const inside = big(p) && p === bestBy(mates, q => q.profile.ratings.finishing + (big(q) ? 15 : 0));
    target = { x: clamp(owner.position.x + sign * (inside ? 7.8 : 4.7 - (slot > 1 ? 4 : 0)), -11.4, 11.4), z: inside ? flank * 1.5 : flank * (slot > 1 ? 3.4 : 5.9) };
    return { move: move(p.position, target), sprint: distance(p.position, target) > 3.4 };
  }
  if (screen?.screener === p.id) {
    const hold = screen.planted === undefined || tick < screen.planted + 24;
    if (hold) {
      if (distance(p.position, screen.spot) < 0.48) return { ...zeroControl(), screen: true };
      return { move: move(p.position, screen.spot), sprint: distance(p.position, screen.spot) > 3.8 };
    }
    target = screen.pop ? { x: rim.x - sign * 6.4, z: -screen.side * 4.7 } : { x: rim.x - sign * 0.9, z: -screen.side * 1.05 };
    return { move: move(p.position, target), sprint: !screen.pop && distance(p.position, target) > 1.2 };
  }
  if (play === 'motion' && highPostHub(p) && distance(owner.position, rim) > 4.5) {
    const elbow = { x: rim.x - sign * 4.85, z: owner.position.z > 0 ? -2.1 : 2.1 };
    if (distance(p.position, rim) > 3.45 && passingLane(owner.position, elbow, foes) > 0.66) target = elbow;
    return { move: move(p.position, target), sprint: distance(p.position, target) > 3.6 };
  }
  if (play === 'motion' && corner && p.profile.ratings.shooting >= 92 && distance(owner.position, rim) < 4.1) {
    const wing = { x: rim.x - sign * 5.25, z: flank * 5.55 };
    if (passingLane(owner.position, wing, foes) > passingLane(owner.position, target, foes) + 0.6) target = wing;
  }
  if (play === 'motion' && !screen && distance(owner.position, rim) < 4.2 && p.profile.ratings.shooting >= 74) {
    const alt = corner ? { x: rim.x - sign * 4.6, z: flank * 5.9 } : { x: rim.x - sign * 6.7, z: flank * 3.1 };
    if (passingLane(owner.position, target, foes) < 0.72 && passingLane(owner.position, alt, foes) > passingLane(owner.position, target, foes) + 0.45) {
      target = alt;
    }
  }
  const cutter = bestBy(mates, q => q.profile.ratings.finishing + (big(q) ? 9 : 0) - q.profile.ratings.shooting * 0.62);
  if (play === 'motion' && !screen && p === cutter && distance(owner.position, rim) > 3.8 && (tick % 210 < 75 || highPostHub(owner))) {
    const cut = { x: rim.x - sign * 1.28, z: owner.position.z > 0 ? -1.35 : 1.35 };
    const lane = passingLane(p.position, cut, foes);
    if (lane > 0.65 || distance(p.position, cut) < 2) target = cut;
  }
  return { move: move(p.position, target), sprint: distance(p.position, target) > 3.1 };
}

function defensiveAssignments(team: GamePlayer[], foes: GamePlayer[], owner: GamePlayer, rim: Vec2, level: number, scheme: DefenseScheme) {
  const sign = Math.sign(rim.x);
  const assignments = new Map<string, GamePlayer>();
  const zoneAnchors = new Map<string, Vec2>();
  if (scheme === 'zone23') {
    const shift = owner.position.z * 0.32;
    const anchors: Vec2[] = [
      { x: rim.x - sign * 6.4, z: -2.9 + shift },
      { x: rim.x - sign * 6.4, z: 2.9 + shift },
      { x: rim.x - sign * 2.6, z: -4.9 + shift * 0.4 },
      { x: rim.x - sign * 2.6, z: 4.9 + shift * 0.4 },
      { x: rim.x - sign * 1.9, z: clamp(owner.position.z * 0.25, -1.2, 1.2) },
    ];
    const sorted = [...team].sort((a, b) => positions.indexOf(a.profile.position) - positions.indexOf(b.profile.position));
    sorted.forEach((p, i) => {
      const anchor = anchors[Math.min(i, anchors.length - 1)];
      zoneAnchors.set(p.id, anchor);
      const threat = bestBy(foes, f => -distance(f.position, anchor) + (f === owner ? 0.6 : 0));
      if (threat) assignments.set(p.id, threat);
    });
    const guard = bestBy(team, p => -distance(owner.position, p.position));
    return { assignments, guard, helper: undefined, helpSpot: rim, rotate: undefined, exposed: undefined, activeScreen: undefined, hedgeId: undefined, hedgeSpot: undefined, dropId: undefined, dropSpot: undefined, zoneAnchors };
  }

  let guard = bestBy(team, p => -distance(owner.position, p.position) * 3 + p.profile.ratings.perimeter * 0.055
    - Math.abs(positions.indexOf(p.profile.position) - positions.indexOf(owner.profile.position)) * 0.65);
  if (guard) assignments.set(guard.id, owner);
  const free = new Set(foes.filter(p => p !== owner));
  for (const p of team) {
    if (p === guard) continue;
    const match = bestBy([...free], q => -distance(p.position, q.position) - Math.abs(positions.indexOf(p.profile.position) - positions.indexOf(q.profile.position)));
    if (match) { assignments.set(p.id, match); free.delete(match); }
  }

  const activeScreen = foes.find(f => f !== owner && f.pose === 'screen' && distance(f.position, owner.position) < 2.4);
  let hedgeId: string | undefined;
  let hedgeSpot: Vec2 | undefined;
  let dropId: string | undefined;
  let dropSpot: Vec2 | undefined;
  if (activeScreen && guard) {
    const screenerGuard = team.find(p => p !== guard && assignments.get(p.id)?.id === activeScreen.id);
    if (screenerGuard) {
      const canSwitch = scheme === 'switch' || (level >= 3 && Math.abs(guard.profile.height - screenerGuard.profile.height) < 0.14);
      if (canSwitch) {
        assignments.set(screenerGuard.id, owner);
        assignments.set(guard.id, activeScreen);
        guard = screenerGuard;
      } else if (level >= 2 && screenerGuard.profile.ratings.speed >= 72) {
        hedgeId = screenerGuard.id;
        const awayFromScreen = Math.sign(owner.position.z - activeScreen.position.z || 1);
        const baseHedge = mix(owner.position, rim, 0.35);
        hedgeSpot = { x: baseHedge.x, z: clamp(baseHedge.z + awayFromScreen * 0.55, -6.5, 6.5) };
      } else {
        dropId = screenerGuard.id;
        dropSpot = { x: rim.x - sign * 3.3, z: clamp(owner.position.z * 0.4, -1.8, 1.8) };
      }
    }
  }

  const drive = distance(owner.position, rim) < 4.6 + level * 0.43 && (owner.velocity.x * sign > 1.6 || distance(owner.position, rim) < 3.8 || !!guard && distance(owner.position, guard.position) > 2.0);
  const helpSpot = mix(owner.position, rim, 0.56);
  const helper = drive ? bestBy(team.filter(p => p !== guard && p.id !== hedgeId && p.id !== dropId && distance(p.position, helpSpot) < 3.7 + level * 0.38), p => {
    const match = assignments.get(p.id);
    const weakSide = match && match.position.z * owner.position.z < 0 ? 0.85 : 0;
    const cornerShooter = match && onArc(match.position, rim) ? Math.max(0, match.profile.ratings.shooting - 74) * (0.027 + level * 0.009) : 0;
    return 4.7 - distance(p.position, helpSpot) + weakSide + p.profile.ratings.interior * 0.021 - cornerShooter;
  }) : undefined;
  const exposed = helper && assignments.get(helper.id);
  const rotate = level >= 2 && exposed ? bestBy(team.filter(p => p !== guard && p !== helper && p.id !== hedgeId), p => -distance(p.position, exposed.position)) : undefined;
  return { assignments, guard, helper, helpSpot, rotate, exposed, activeScreen, hedgeId, hedgeSpot, dropId, dropSpot, zoneAnchors };
}

function defend(p: GamePlayer, owner: GamePlayer, rim: Vec2, state: GameState, level: number, defense: ReturnType<typeof defensiveAssignments>, scheme: DefenseScheme, lateFoul: boolean): Control {
  const match = defense.assignments.get(p.id);
  const onBall = p === defense.guard;
  const pressure = distance(p.position, owner.position);
  const zoneAnchor = defense.zoneAnchors.get(p.id);
  const halfCourt = state.config.halfCourt ?? state.config.mode === 'blacktop';
  let target: Vec2;
  if (scheme === 'zone23' && zoneAnchor) {
    target = match && distance(match.position, zoneAnchor) < 2.4 ? mix(zoneAnchor, match.position, 0.65) : zoneAnchor;
  } else {
    const cushion = scheme === 'press' && onBall ? 0.58 : onBall ? 0.82 + (5 - level) * 0.11 : match && match.profile.ratings.shooting >= 85 ? 0.95 : 1.65;
    target = match ? mix(match.position, rim, Math.min(0.68, cushion / Math.max(1, distance(match.position, rim)))) : mix(owner.position, rim, 0.73);
    if (scheme === 'press' && !onBall) {
      const sign = Math.sign(rim.x);
      if (owner.position.x * sign < -1 && p === defense.helper) target = mix(owner.position, rim, 0.18);
      else if (match) target = mix(match.position, owner.position, 0.35);
    }
    if (onBall && owner.velocity.x * Math.sign(rim.x) > 1.2) target.x += owner.velocity.x * level * 0.035;
    if (onBall && defense.activeScreen && distance(p.position, defense.activeScreen.position) < 1.0 &&
        Math.sign(target.z - defense.activeScreen.position.z) !== Math.sign(p.position.z - defense.activeScreen.position.z)) {
      const awayZ = target.z >= defense.activeScreen.position.z ? 1 : -1;
      target = { x: target.x + Math.sign(rim.x) * 0.4, z: defense.activeScreen.position.z + awayZ * 1.1 };
    }
    if (p.id === defense.hedgeId && defense.hedgeSpot) target = defense.hedgeSpot;
    else if (p.id === defense.dropId && defense.dropSpot) target = defense.dropSpot;
    else if (p === defense.helper) target = defense.helpSpot;
    if (p === defense.rotate && defense.exposed) target = mix(target, defense.exposed.position, 0.4 + level * 0.055);
  }
  const sprinting = distance(p.position, target) > (p.id === defense.hedgeId ? 1.6 : 2.25);
  const deadBonus = owner.action?.deadDribble ? 0.25 : 0;
  const recklessMove = !!owner.action?.dribbleMove && p.profile.ratings.perimeter + level * 3 < owner.profile.ratings.handling;
  const readyToSteal = onBall && owner.pose !== 'shoot' && !recklessMove &&
    (p.profile.ratings.perimeter + level * 3 > owner.profile.ratings.handling || pressure < 0.82 || !!owner.action?.deadDribble);
  const stealMod = Math.max(24, (owner.action?.deadDribble ? 78 : 112) - 9 * level);
  const pumpFakeBite = owner.pose === 'pumpFake' && (onBall || p === defense.helper) && pressure < 1.95 &&
    noise(p.id, state.tick >> 3, 7) < clamp(0.62 - level * 0.11, 0.08, 0.62);
  const contesting = pumpFakeBite || ((onBall || p === defense.helper || p.id === defense.dropId || (scheme === 'zone23' && pressure < 2.1)) &&
    pressure < (owner.pose === 'shoot' ? 2.05 : 1.02) + level * 0.12);
  return {
    move: move(p.position, target),
    sprint: sprinting,
    intenseD: onBall && !sprinting && pressure < 2.35 && (halfCourt || owner.position.x * Math.sign(rim.x) > -1.0),
    contest: contesting,
    steal: (lateFoul && pressure < 1.3) || (readyToSteal && pressure < 1.23 + deadBonus && state.tick % stealMod === Math.floor(noise(p.id, 3, 0) * Math.min(38, stealMod))),
  };
}

function reboundControls(p: GamePlayer, team: GamePlayer[], foes: GamePlayer[], rim: Vec2, state: GameState): Control {
  const ball = state.ball;
  const shot = ball.kind === 'shot';
  const landing = shot ? rim : { x: ball.position.x + 0.24 * ball.velocity.x, z: ball.position.z + 0.24 * ball.velocity.z };
  const chase = [...team].sort((a, b) => (distance(a.position, landing) - a.profile.ratings.rebounding * 0.025) - (distance(b.position, landing) - b.profile.ratings.rebounding * 0.025)).slice(0, 2);
  if (!shot && chase.includes(p)) return { move: move(p.position, landing), sprint: distance(p.position, landing) > 1.5, contest: distance(p.position, landing) < 1.55 };
  const rival = bestBy(foes, q => -distance(p.position, q.position) - distance(q.position, rim) * 0.35);
  if (rival && distance(rival.position, rim) < 4.4 && (p.side !== state.possession || chase.includes(p))) {
    const seal = mix(rival.position, rim, Math.min(0.75, 0.72 / Math.max(0.1, distance(rival.position, rim))));
    if (distance(p.position, seal) < 0.56) return { ...zeroControl(), screen: true };
    return { move: move(p.position, seal), sprint: distance(p.position, seal) > 2.5 };
  }
  if (chase.includes(p)) return { move: move(p.position, mix(p.position, landing, 0.75)), sprint: distance(p.position, landing) > 2.2 };
  const x = rim.x - Math.sign(rim.x) * (p.side === state.possession ? 8.3 : 5.5);
  return { move: move(p.position, { x, z: p.position.z > 0 ? 4.2 : -4.2 }) };
}

function driveTarget(owner: GamePlayer, rim: Vec2, foes: GamePlayer[], level: number) {
  const sign = Math.sign(rim.x);
  const range = distance(owner.position, rim);
  const { shooting, finishing, handling } = owner.profile.ratings;
  const lanes = [-1, 1].map(side => ({ x: rim.x - sign * (range > 8.2 ? 6.3 : 0.9), z: side * (range > 4 ? 2.3 : 0.35) }));
  const target = bestBy(lanes, point => passingLane(owner.position, point, foes) * (0.72 + level * 0.13) - distance(owner.position, point) * 0.11)!;
  if (range > 8.5 && shooting >= 92 && shooting >= finishing - 4) return { x: rim.x - sign * 7.5, z: Math.sign(target.z) * 1.9 };
  if (range > 6.4 && range < 8.8 && highPostHub(owner)) return { x: rim.x - sign * 4.55, z: Math.sign(target.z) * 2.1 };
  if (range > 5.9 && range < 8.3 && handling >= 86 && finishing >= 87 && shooting < 90) return { x: rim.x - sign * 5.1, z: Math.sign(target.z) * 1.8 };
  return target;
}

function shotType(owner: GamePlayer, rim: Vec2, foes: GamePlayer[]): Control['shotType'] {
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

export function createCoach() {
  let holder = '', received = 0, release = -1, lastTick = -1;
  let possession: Side | undefined, gained = 0;
  let attempt: Control['shotType'];
  let screen: Screen | undefined, screenCalled = false;
  let intendedPass: { receiver: string; sender: string; spot: Vec2 } | undefined;
  let lastPasser = '', passes = 0, outletAttempted = false;
  const offensePlays: [OffensePlay, OffensePlay] = ['motion', 'motion'];
  const defenseSchemes: [DefenseScheme, DefenseScheme] = ['man', 'man'];
  return {
    controls(state: GameState, userPlayerIds: ReadonlySet<string> = new Set(), userControls: Readonly<Record<string, Control>> = {}): Record<string, Control> {
      const result: Record<string, Control> = {};
      if (state.offensePlay) { offensePlays[0] = state.offensePlay[0]; offensePlays[1] = state.offensePlay[1]; }
      if (state.defenseScheme) { defenseSchemes[0] = state.defenseScheme[0]; defenseSchemes[1] = state.defenseScheme[1]; }
      for (const p of state.players) {
        const u = userControls[p.id];
        if (u?.offensePlay) offensePlays[p.side] = u.offensePlay;
        if (u?.defenseScheme) defenseSchemes[p.side] = u.defenseScheme;
      }
      const owner = state.players.find(p => p.id === state.ball.ownerId);
      const ownerId = owner?.id ?? '';
      if (possession !== state.possession || state.tick < lastTick) {
        possession = state.possession;
        gained = state.tick;
        lastPasser = '';
        passes = 0;
        outletAttempted = false;
        intendedPass = undefined;
      }
      if (holder !== ownerId || state.tick < lastTick || state.phase !== 'live') {
        if (ownerId && intendedPass?.receiver === ownerId && holder !== ownerId) {
          lastPasser = intendedPass.sender;
          passes++;
        }
        holder = ownerId;
        received = state.tick;
        release = -1;
        attempt = undefined;
        screen = undefined;
        screenCalled = false;
      }
      if (state.ball.kind !== 'pass' && (state.ball.kind !== 'held' || ownerId !== intendedPass?.sender)) intendedPass = undefined;
      if (state.phase !== 'live' || state.ball.kind === 'shot') {
        lastPasser = '';
        passes = 0;
        outletAttempted = false;
      }
      lastTick = state.tick;
      const level = Math.max(0, levels.indexOf(state.config.difficulty ?? 'Pro'));
      const seed = state.config.seed ?? 1;
      const halfCourt = state.config.halfCourt ?? state.config.mode === 'blacktop';
      const sign = halfCourt ? 1 : attackSign(state.possession);
      const rim = { x: sign * COURT.rimX, z: 0 };
      const team = state.players.filter(p => p.side === state.possession);
      const foes = state.players.filter(p => p.side !== state.possession);
      const mates = team.filter(p => p !== owner).sort((a, b) => b.profile.ratings.shooting - a.profile.ratings.shooting);
      const age = state.tick - received;
      const transition = owner && !halfCourt && (owner.position.x * sign < 1 || state.tick - gained < 125 && distance(owner.position, rim) > 9.4);
      const activePlay = offensePlays[state.possession];
      const defSide = opposite(state.possession);
      const offScore = state.score[state.possession];
      const defScore = state.score[defSide];
      const lateRegulation = state.config.mode === 'regulation' && state.period >= (state.config.periods ?? 4);
      const lateFoul = lateRegulation && defScore < offScore && offScore - defScore <= 7 && state.clock < 26;
      const milkClock = lateRegulation && offScore > defScore && offScore - defScore <= 8 && state.clock < 24 && state.shotClock >= state.clock && state.clock > 4.5;
      const activeScheme: DefenseScheme = lateFoul ? 'press' : defenseSchemes[defSide];

      const humanCallScreen = owner && userPlayerIds.has(owner.id) && (userControls[owner.id]?.callScreen || userControls[owner.id]?.screen);
      if (owner && humanCallScreen && state.phase === 'live' && (!screen || !mates.some(p => p.id === screen!.screener && !userPlayerIds.has(p.id)))) {
        screen = screenCall(owner, mates.filter(p => !userPlayerIds.has(p.id)), foes, rim, state.tick, true);
        screenCalled = !!screen;
      } else if (owner && !transition && !screenCalled && activePlay !== 'iso' && state.phase === 'live' && age >= (activePlay === 'pickAndRoll' ? 8 : 16) && state.shotClock > 5 && release < 0) {
        screen = screenCall(owner, mates.filter(p => !userPlayerIds.has(p.id)), foes, rim, state.tick);
        screenCalled = !!screen;
      }
      if (screen) {
        const screener = mates.find(p => p.id === screen?.screener);
        if (!screener || userPlayerIds.has(screener.id) || screen.planted === undefined && state.tick > screen.started + 94 || screen.planted !== undefined && state.tick > screen.planted + 105) screen = undefined;
        else if (screen.planted === undefined && distance(screener.position, screen.spot) < 0.48) screen.planted = state.tick;
      }
      const defense = owner && defensiveAssignments(foes, team, owner, rim, level, activeScheme);
      for (const p of state.players) {
        if (userPlayerIds.has(p.id)) {
          if (ownerId === p.id) release = -1;
          continue;
        }
        let c = zeroControl();
        if (state.phase !== 'live') { result[p.id] = c; continue; }
        if (!owner && (state.ball.kind === 'loose' || state.ball.kind === 'shot')) {
          c = reboundControls(p, p.side === state.possession ? team : foes, p.side === state.possession ? foes : team, rim, state);
        } else if (!owner && state.ball.kind === 'pass') {
          if (p.id === intendedPass?.receiver) {
            c = { move: move(p.position, intendedPass.spot) };
          } else if (p.side !== state.possession && state.ball.position.y < 2.9) {
            const point = { x: state.ball.position.x + state.ball.velocity.x * 0.075, z: state.ball.position.z + state.ball.velocity.z * 0.075 };
            if (distance(p.position, point) < 0.82 + level * 0.08 && p.profile.ratings.perimeter + level * 3 >= 64) {
              c = { move: move(p.position, point), steal: true };
            }
          }
        } else if (owner && p.side !== state.possession && defense) {
          c = defend(p, owner, rim, state, level, defense, activeScheme, lateFoul);
        } else if (owner && owner.id !== p.id) {
          c = offensiveSupport(p, owner, mates, foes, rim, state.tick, screen, !!transition, activePlay);
        } else if (owner) {
          const range = distance(p.position, rim);
          const cycle = Math.floor(age / (31 - 4 * level));
          const variance = (id: string) => (noise(id, seed, cycle) - 0.5) * (0.36 - level * 0.06);
          const value = shotValue(p, p.position, foes, rim, level, state) + variance(p.id);
          const { passing, shooting } = p.profile.ratings;
          const target = milkClock ? { x: rim.x - sign * 8.2, z: clamp(p.position.z, -4.5, 4.5) } :
            screen && (screen.planted === undefined || state.tick < screen.planted + 34)
              ? screen.planted === undefined ? mix(screen.spot, p.position, 0.8) : screenLane(screen, rim)
              : driveTarget(p, rim, foes, level);
          const arc = onArc(p.position, rim);
          const space = closeout(p.position, foes, level);
          const urgent = Math.min(state.shotClock, state.clock) < 1.35;
          const comfortable = !milkClock && (range < 2.4 && (space > 1.23 || p.profile.ratings.finishing >= 87) ||
            arc && range < 8.8 && shooting >= 77 && value > 1.55 + (94 - shooting) * 0.014 ||
            !arc && range >= 2.4 && range < 6.8 && value > 1.71 && (!screen || screen.planted !== undefined));
          let best: { mate: GamePlayer; lead: Vec2; lane: number; gap: number; lob: boolean; calling: boolean } | undefined;
          const opening = !outletAttempted && passes === 0 && !comfortable && age >= 24 && age < 132
            && state.shotClock > 19 && range > 7.6;
          let bestValue = Math.max(value, comfortable ? 1.55 : 1.12) + 0.29
            - level * 0.016 - (passing - 70) * 0.006 + Math.min(0.27, passes * 0.077);
          for (const mate of mates) {
            const calling = userPlayerIds.has(mate.id) && !!(userControls[mate.id]?.callPass || userControls[mate.id]?.pass);
            const gap = distance(p.position, mate.position);
            if (gap < (calling ? 1.0 : 1.7) || gap > 7.8 + passing * 0.055 || (!calling && mate.id === lastPasser && age < 80)) continue;
            const leadTime = clamp(gap / 16 * (1.14 - passing * 0.0016), 0.18, 1.05) * 0.65;
            const lead = { x: mate.position.x + mate.velocity.x * leadTime, z: mate.position.z + mate.velocity.z * leadTime };
            const read = mix(mate.position, lead, 0.58 + level * 0.084);
            if (!halfCourt && p.position.x * sign > 0 && read.x * sign < 0.35) continue;
            const lane = Math.min(passingLane(p.position, read, foes), passingLane(p.position, lead, foes) + 0.1 * (5 - level));
            const receiverSpace = closeout(read, foes, level);
            if (lane < (calling ? 0.36 : 0.44 + level * 0.09) || (!calling && p.position.x * sign < 0 && gap > 9.2 && lane < 2.15)) continue;
            const receivingRange = distance(read, rim);
            const advances = receivingRange < range - 2.3;
            const hub = passes < 2 && highPostHub(mate) && receivingRange >= 3.5 && receivingRange < 6.6 ? 0.24 : 0;
            const hitRoll = screen?.screener === mate.id && screen.planted !== undefined && state.tick >= screen.planted + 24
              && receiverSpace > 1.4 && lane > 1 ? 0.28 : 0;
            const safeOutlet = opening && gap >= 2.8 && gap < 10.5 && lane >= 1.14 + level * 0.035
              && receiverSpace > 1.6 && (advances || !transition && Math.abs(read.z - p.position.z) > 2.8);
            const outlet = safeOutlet ? 0.7 + (mate.profile.ratings.handling - 65) * 0.009 : 0;
            const callBonus = calling ? 1.65 : 0;
            const option = shotValue(mate, read, foes, rim, level, state) + variance(mate.id) + hub + hitRoll + outlet + callBonus
              - Math.max(0, 1.18 - lane) * (0.28 + level * 0.07) - gap * 0.022;
            const lobCut = (screen?.screener === mate.id && !screen.pop && receiverSpace > 1.1) ||
              (receivingRange < 3.1 && mate.profile.ratings.finishing >= 80 && lane < 1.05 && receiverSpace > 0.65);
            if (option > bestValue && (calling || !transition || advances)) {
              bestValue = option;
              best = { mate, lead, lane, gap, lob: lobCut, calling };
            }
          }
          if (release < 0 && (urgent || best?.calling || age > 24 - level * 2)) {
            if (!urgent && best && (best.calling || opening || age % (18 - 2 * level) === 0)) {
              outletAttempted = true;
              intendedPass = { receiver: best.mate.id, sender: p.id, spot: best.lead };
              c.pass = true;
              c.targetId = best.mate.id;
              c.passType = best.lob ? 'lob' : best.lane > 0.76 && best.lane < 1.25 && best.gap < 6.8 ? 'bounce' : 'chest';
            } else if (urgent || (!milkClock && (comfortable && !best || age > 195 && range < 9.1 && (space > 1.2 || age > 285)))) {
              release = state.tick + Math.max(4, Math.min(Math.round(Math.min(state.clock, state.shotClock) * 60) - 2, 37 + Math.round(variance(p.id) * 43)));
              attempt = shotType(p, rim, foes);
            }
          }
          if (!c.pass && release < 0) {
            c.move = move(p.position, target);
            c.sprint = range > 9.2 && p.stamina > 24;
            const wantsDribble = (level >= 2 && p.profile.ratings.handling >= 80 && space < 1.35 && range > 3.2 && range < 8.5)
              ? (state.tick + Math.floor(noise(p.id, seed, 1) * 40)) % 45 === 0
              : space < 1.5 && p.stamina > 17;
            c.dribble = wantsDribble;
            if (wantsDribble) {
              if (p.profile.ratings.shooting >= 82 && range >= 5.2 && range < 8.4 && space < 1.65) {
                c.dribbleDir = { x: -sign, z: 0 };
              } else if (p.profile.ratings.handling >= 80 && range >= 2.8 && range < 6.8) {
                const sideZ = Math.abs(target.z - p.position.z) > 0.15 ? Math.sign(target.z - p.position.z) : (p.position.z >= 0 ? -1 : 1);
                c.dribbleDir = { x: sign * 0.25, z: sideZ };
              }
            }
          } else if (release >= 0) {
            c.shoot = state.tick < release;
            c.shotType = attempt;
          }
        }
        result[p.id] = c;
      }
      return result;
    }
  };
}
