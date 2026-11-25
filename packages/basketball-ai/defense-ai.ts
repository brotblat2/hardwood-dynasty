import { zeroControl } from '../contracts/index.ts';
import type { Control, DefenseScheme, GamePlayer, GameState, Vec2 } from '../contracts/index.ts';
import { bestBy, clamp, distance, mix, move, noise, onArc, positions } from './spatial.ts';

export type ScreenCoverage = 'switch' | 'hedge' | 'drop' | 'goOver' | 'goUnder';
export type KickoutState = { targetId: string; until: number };

export type DefensePlan = {
  assignments: Map<string, GamePlayer>;
  guard: GamePlayer | undefined;
  helper: GamePlayer | undefined;
  helpSpot: Vec2;
  rotate: GamePlayer | undefined;
  exposed: GamePlayer | undefined;
  activeScreen: GamePlayer | undefined;
  hedgeId: string | undefined;
  hedgeSpot: Vec2 | undefined;
  dropId: string | undefined;
  dropSpot: Vec2 | undefined;
  onBallNav: 'goOver' | 'goUnder' | undefined;
  screenCoverage: ScreenCoverage | undefined;
  closeoutId: string | undefined;
  closeoutSpot: Vec2 | undefined;
  xOutId: string | undefined;
  xOutSpot: Vec2 | undefined;
  zoneAnchors: Map<string, Vec2>;
};

/** Compute full 5v5 defensive assignments, screen coverages, help rotations, and X-out closeouts. */
export function defensiveAssignments(
  team: readonly GamePlayer[],
  foes: readonly GamePlayer[],
  owner: GamePlayer,
  rim: Vec2,
  level: number,
  scheme: DefenseScheme,
  kickout?: KickoutState,
): DefensePlan {
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
    return {
      assignments, guard, helper: undefined, helpSpot: rim, rotate: undefined, exposed: undefined,
      activeScreen: undefined, hedgeId: undefined, hedgeSpot: undefined, dropId: undefined, dropSpot: undefined,
      onBallNav: undefined, screenCoverage: undefined, closeoutId: undefined, closeoutSpot: undefined,
      xOutId: undefined, xOutSpot: undefined, zoneAnchors,
    };
  }

  let guard = bestBy(team, p =>
    -distance(owner.position, p.position) * 3 +
    p.profile.ratings.perimeter * 0.055 -
    Math.abs(positions.indexOf(p.profile.position) - positions.indexOf(owner.profile.position)) * 0.65,
  );
  if (guard) assignments.set(guard.id, owner);

  const free = new Set(foes.filter(p => p !== owner));
  for (const p of team) {
    if (p === guard) continue;
    const match = bestBy([...free], q =>
      -distance(p.position, q.position) -
      Math.abs(positions.indexOf(p.profile.position) - positions.indexOf(q.profile.position)),
    );
    if (match) {
      assignments.set(p.id, match);
      free.delete(match);
    }
  }

  const activeScreen = foes.find(f => f !== owner && f.pose === 'screen' && distance(f.position, owner.position) < 2.5);
  let hedgeId: string | undefined;
  let hedgeSpot: Vec2 | undefined;
  let dropId: string | undefined;
  let dropSpot: Vec2 | undefined;
  let onBallNav: 'goOver' | 'goUnder' | undefined;
  let screenCoverage: ScreenCoverage | undefined;

  if (activeScreen && guard) {
    const screenerGuard = team.find(p => p !== guard && assignments.get(p.id)?.id === activeScreen.id);
    if (screenerGuard) {
      const canSwitch = scheme === 'switch' || (level >= 3 && Math.abs(guard.profile.height - screenerGuard.profile.height) < 0.14);
      if (canSwitch) {
        assignments.set(screenerGuard.id, owner);
        assignments.set(guard.id, activeScreen);
        guard = screenerGuard;
        screenCoverage = 'switch';
      } else {
        const handlerShooter = owner.profile.ratings.shooting >= 81 && distance(owner.position, rim) > 4.4;
        onBallNav = handlerShooter ? 'goOver' : 'goUnder';
        if (level >= 2 && screenerGuard.profile.ratings.speed >= 72 && handlerShooter && distance(owner.position, activeScreen.position) < 2.3) {
          hedgeId = screenerGuard.id;
          const awayFromScreen = Math.sign(owner.position.z - activeScreen.position.z || 1);
          const baseHedge = mix(owner.position, rim, 0.35);
          hedgeSpot = { x: baseHedge.x, z: clamp(baseHedge.z + awayFromScreen * 0.55, -6.5, 6.5) };
          screenCoverage = 'hedge';
        } else {
          dropId = screenerGuard.id;
          dropSpot = { x: rim.x - sign * 3.1, z: clamp(owner.position.z * 0.4, -1.8, 1.8) };
          screenCoverage = onBallNav;
        }
      }
    }
  }

  const drive = distance(owner.position, rim) < 4.6 + level * 0.43 &&
    (owner.velocity.x * sign > 1.6 || distance(owner.position, rim) < 3.8 || (!!guard && distance(owner.position, guard.position) > 2.0));
  const helpSpot = mix(owner.position, rim, 0.56);
  const helper = drive
    ? bestBy(team.filter(p => p !== guard && p.id !== hedgeId && p.id !== dropId && distance(p.position, helpSpot) < 3.7 + level * 0.38), p => {
      const match = assignments.get(p.id);
      const weakSide = match && match.position.z * owner.position.z < 0 ? 0.85 : 0;
      const cornerShooter = match && onArc(match.position, rim) ? Math.max(0, match.profile.ratings.shooting - 74) * (0.027 + level * 0.009) : 0;
      return 4.7 - distance(p.position, helpSpot) + weakSide + p.profile.ratings.interior * 0.021 - cornerShooter;
    })
    : undefined;
  const exposed = helper && assignments.get(helper.id);
  const rotate = level >= 2 && exposed
    ? bestBy(team.filter(p => p !== guard && p !== helper && p.id !== hedgeId), p => -distance(p.position, exposed.position))
    : undefined;

  // X-Out closeout rotation on perimeter kick-out passes.
  let closeoutId: string | undefined;
  let closeoutSpot: Vec2 | undefined;
  let xOutId: string | undefined;
  let xOutSpot: Vec2 | undefined;
  if (kickout) {
    const threat = foes.find(f => f.id === kickout.targetId);
    if (threat) {
      const closest = bestBy(team, p => -distance(p.position, threat.position));
      if (closest && distance(closest.position, threat.position) > 1.15) {
        closeoutId = closest.id;
        closeoutSpot = mix(threat.position, rim, 0.14);
        const directLeft = assignments.get(closest.id);
        const leftOpen = directLeft && directLeft !== threat
          ? directLeft
          : bestBy(
            foes.filter(f => f !== threat && onArc(f.position, rim)),
            f => Math.min(...team.filter(d => d.id !== closeoutId).map(d => distance(d.position, f.position))),
          );
        if (leftOpen) {
          const xDef = bestBy(
            team.filter(p => p.id !== closeoutId && (threat !== owner || p !== guard)),
            p => -distance(p.position, leftOpen.position),
          );
          if (xDef) {
            xOutId = xDef.id;
            xOutSpot = mix(leftOpen.position, rim, 0.18);
          }
        }
      }
    }
  }

  return {
    assignments, guard, helper, helpSpot, rotate, exposed, activeScreen,
    hedgeId, hedgeSpot, dropId, dropSpot, onBallNav, screenCoverage,
    closeoutId, closeoutSpot, xOutId, xOutSpot, zoneAnchors,
  };
}

/** Generate per-player defensive controls honoring screen coverage, closeouts, rotations, and contest discipline. */
export function defend(
  p: GamePlayer,
  owner: GamePlayer,
  rim: Vec2,
  state: GameState,
  level: number,
  defense: DefensePlan,
  scheme: DefenseScheme,
  lateFoul: boolean,
): Control {
  const match = defense.assignments.get(p.id);
  const onBall = p === defense.guard;
  const pressure = distance(p.position, owner.position);
  const zoneAnchor = defense.zoneAnchors.get(p.id);
  const halfCourt = state.config.halfCourt ?? state.config.mode === 'blacktop';
  const sign = Math.sign(rim.x);
  let target: Vec2;

  if (scheme === 'zone23' && zoneAnchor) {
    target = match && distance(match.position, zoneAnchor) < 2.4 ? mix(zoneAnchor, match.position, 0.65) : zoneAnchor;
  } else {
    const cushion = scheme === 'press' && onBall
      ? 0.72
      : onBall
        ? 1.12 + (5 - level) * 0.16
        : match && match.profile.ratings.shooting >= 85
          ? 1.05
          : 1.75;
    target = match ? mix(match.position, rim, Math.min(0.68, cushion / Math.max(1, distance(match.position, rim)))) : mix(owner.position, rim, 0.73);
    if (scheme === 'press' && !onBall) {
      if (owner.position.x * sign < -1 && p === defense.helper) target = mix(owner.position, rim, 0.18);
      else if (match) target = mix(match.position, owner.position, 0.35);
    }
    if (onBall && owner.velocity.x * sign > 1.2) target.x += owner.velocity.x * level * 0.035;

    // Go Over vs Go Under screen navigation around active ball screens.
    if (onBall && defense.activeScreen && distance(p.position, defense.activeScreen.position) < 1.35) {
      const scr = defense.activeScreen.position;
      if (defense.onBallNav === 'goOver') {
        const awayZ = Math.sign(owner.position.z - scr.z || 1);
        target = { x: scr.x - sign * 0.95, z: scr.z + awayZ * 0.25 };
      } else if (defense.onBallNav === 'goUnder') {
        target = { x: scr.x + sign * 1.05, z: scr.z * 0.7 };
      } else if (Math.sign(target.z - scr.z) !== Math.sign(p.position.z - scr.z)) {
        const awayZ = target.z >= scr.z ? 1 : -1;
        target = { x: target.x + sign * 0.4, z: scr.z + awayZ * 1.1 };
      }
    }

    if (p.id === defense.closeoutId && defense.closeoutSpot) target = defense.closeoutSpot;
    else if (p.id === defense.xOutId && defense.xOutSpot) target = defense.xOutSpot;
    else if (p.id === defense.hedgeId && defense.hedgeSpot) target = defense.hedgeSpot;
    else if (p.id === defense.dropId && defense.dropSpot) target = defense.dropSpot;
    else if (p === defense.helper) target = defense.helpSpot;
    if (p === defense.rotate && defense.exposed) target = mix(target, defense.exposed.position, 0.4 + level * 0.055);
  }

  const sprinting = p.id === defense.closeoutId || p.id === defense.xOutId
    ? distance(p.position, target) > 1.05
    : distance(p.position, target) > (p.id === defense.hedgeId ? 1.6 : 2.25);

  const deadBonus = owner.action?.deadDribble ? 0.25 : 0;
  const recklessMove = !!owner.action?.dribbleMove && p.profile.ratings.perimeter + level * 3 < owner.profile.ratings.handling;
  const readyToSteal = onBall && owner.pose !== 'shoot' && !recklessMove &&
    (p.profile.ratings.perimeter + level * 3 > owner.profile.ratings.handling || pressure < 0.82 || !!owner.action?.deadDribble);
  const stealMod = Math.max(96, 265 - 28 * level);
  const pumpFakeBite = owner.pose === 'pumpFake' && (onBall || p === defense.helper) && pressure < 1.95 &&
    noise(p.id, state.tick >> 3, 7) < clamp(0.62 - level * 0.11, 0.08, 0.62);
  const canClose = onBall || p === defense.helper || p.id === defense.dropId || p.id === defense.closeoutId ||
    (scheme === 'zone23' && pressure < 2.2);
  const contesting = pumpFakeBite || (canClose && owner.pose === 'shoot' && pressure < 2.05 + level * 0.12);
  const handsUp = !contesting && canClose && pressure < 2.15 + level * 0.10;

  return {
    move: move(p.position, target),
    sprint: sprinting,
    intenseD: level >= 2 && onBall && !sprinting && pressure < 2.35 && (halfCourt || owner.position.x * sign > -1.0),
    handsUp,
    contest: contesting,
    steal: (lateFoul && pressure < 1.3) || (
      readyToSteal &&
      pressure < (level <= 1 ? 0.76 : 1.02) + deadBonus &&
      state.tick % stealMod === Math.floor(noise(p.id, 3, 0) * Math.min(38, stealMod))
    ),
  };
}

/** Coordinated 5v5 rebound box-out assignments, offensive crash vs defensive transition leak-out. */
export function reboundControls(
  p: GamePlayer,
  team: readonly GamePlayer[],
  foes: readonly GamePlayer[],
  rim: Vec2,
  state: GameState,
): Control {
  const ball = state.ball;
  const shot = ball.kind === 'shot';
  const sign = Math.sign(rim.x);
  const landing = shot ? rim : { x: ball.position.x + 0.24 * ball.velocity.x, z: ball.position.z + 0.24 * ball.velocity.z };
  const chase = [...team]
    .sort((a, b) => (distance(a.position, landing) - a.profile.ratings.rebounding * 0.025) - (distance(b.position, landing) - b.profile.ratings.rebounding * 0.025))
    .slice(0, 2);

  if (!shot && chase.includes(p)) {
    return { move: move(p.position, landing), sprint: distance(p.position, landing) > 1.5, contest: distance(p.position, landing) < 1.55 };
  }

  // Transition leak-out when shot is up and defense already has inside paint numbers covered.
  if (shot && p.side !== state.possession && team.length >= 4) {
    const paintDefenders = team.filter(q => distance(q.position, rim) < 4.5).length;
    const paintCrashers = foes.filter(q => distance(q.position, rim) < 4.6).length;
    const leakPlayer = bestBy(team, q => distance(q.position, rim) * 1.1 + q.profile.ratings.speed * 0.04 - q.profile.ratings.rebounding * 0.03);
    if (p === leakPlayer && !chase.includes(p) && paintDefenders >= Math.max(2, paintCrashers)) {
      const leakSpot = { x: rim.x - sign * 7.4, z: clamp(p.position.z, -5.2, 5.2) };
      return { move: move(p.position, leakSpot), sprint: true };
    }
  }

  const rival = bestBy(foes, q => -distance(p.position, q.position) - distance(q.position, rim) * 0.35);
  if (rival && distance(rival.position, rim) < 4.4 && (p.side !== state.possession || chase.includes(p))) {
    const seal = mix(rival.position, rim, Math.min(0.75, 0.72 / Math.max(0.1, distance(rival.position, rim))));
    if (distance(p.position, seal) < 0.56) return { ...zeroControl(), screen: true };
    return { move: move(p.position, seal), sprint: distance(p.position, seal) > 2.5 };
  }

  if (chase.includes(p)) return { move: move(p.position, mix(p.position, landing, 0.75)), sprint: distance(p.position, landing) > 2.2 };
  const x = rim.x - sign * (p.side === state.possession ? 8.3 : 5.5);
  return { move: move(p.position, { x, z: p.position.z > 0 ? 4.2 : -4.2 }) };
}
