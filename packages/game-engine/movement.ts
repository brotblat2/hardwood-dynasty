import { trackDirectionalCut } from './dribble.ts';
import { COURT } from '../contracts/index.ts';
import type { Control, GamePlayer, Player, Side, Vec2 } from '../contracts/index.ts';
import { angleDiff, clamp, distance, DT, LIMIT_X, LIMIT_Z, normalizeAngle } from './types.ts';
import type { PlayerBody, Runtime, Snapshot } from './types.ts';

/** Compute deterministic biomechanical attributes from player measurements and ratings. */
export function computePlayerBody(profile: Player, cache?: WeakMap<Player, PlayerBody>): PlayerBody {
  const cached = cache?.get(profile);
  if (cached) return cached;
  const positionIndex = Math.max(0, ['PG', 'SG', 'SF', 'PF', 'C'].indexOf(profile.position));
  const typicalHeight = 1.88 + positionIndex * 0.055;
  const height = clamp(Number.isFinite(profile.height) && profile.height > 0 ? profile.height : typicalHeight, 1.55, 2.36);
  const typicalMass = (23.8 + positionIndex * 0.66) * height * height;
  const mass = clamp(Number.isFinite(profile.weight) && profile.weight! > 0 ? profile.weight! : typicalMass, 55, 165);
  const strength = clamp(
    Number.isFinite(profile.ratings.strength) ? profile.ratings.strength! : 55 + positionIndex * 6 + (mass - typicalMass) * 0.15,
    25,
    99,
  );
  const wingspan = clamp(
    Number.isFinite(profile.wingspan) && profile.wingspan! > 0 ? profile.wingspan! : height * 1.035,
    height * 0.91,
    height * 1.19,
  );
  const acceleration = clamp(0.28 * (95 / mass) ** 0.40 * (0.94 + strength / 850), 0.21, 0.34);
  const speedRating = clamp(Number.isFinite(profile.ratings.speed) ? profile.ratings.speed : 75, 25, 99);
  const turnRate = clamp(12.2 * (95 / mass) ** 0.32 * (0.85 + speedRating / 350), 8.2, 16.5);
  const brakeRate = Math.min(0.68, acceleration * 1.98);

  const result: PlayerBody = {
    height,
    mass,
    wingspan,
    reach: height * 1.26 + (wingspan - height * 1.035) * 0.58,
    leverage: (mass / 95) ** 0.72 * (0.6 + strength / 155),
    acceleration,
    turnRate,
    brakeRate,
  };
  cache?.set(profile, result);
  return result;
}

export type MoveContext = {
  state: Snapshot;
  sim: Runtime;
  half: boolean;
  sign: (side: Side) => number;
  body: (p: GamePlayer) => PlayerBody;
  canAct: (key: string, cooldown: number) => boolean;
};

function rotateToward(current: number, target: number, maxStep: number): number {
  const diff = angleDiff(current, target);
  if (Math.abs(diff) <= maxStep) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(diff) * maxStep);
}

/** Step player locomotion with true inertia, turning radius, stamina curves, and stance poses. */
export function stepPlayerMovement(p: GamePlayer, cmd: Control | undefined, ctx: MoveContext): void {
  const { state, sim, half, sign, body, canAct } = ctx;
  const dx = Number.isFinite(cmd?.move?.x) ? cmd!.move.x : 0;
  const dz = Number.isFinite(cmd?.move?.z) ? cmd!.move.z : 0;
  const norm = Math.hypot(dx, dz);
  const owner = state.ball.ownerId === p.id;
  const dribble = owner && sim.dribble?.ownerId === p.id ? sim.dribble : undefined;
  const deadDribble = !!dribble && dribble.ballState === 'dead';
  const intenseD = !owner && !!(cmd?.intenseD);
  sim.intenseD ??= {};
  sim.intenseD[p.id] = intenseD;

  const hoopX = sign(p.side) * COURT.rimX;
  const rangeToRim = Math.hypot(hoopX - p.position.x, -p.position.z);
  const wantsSprint = !!cmd?.sprint && norm > 0.1 && p.stamina > 8 && !intenseD && !deadDribble && !(owner && cmd?.postUp);
  const handsUp = !owner && !!cmd?.handsUp && !wantsSprint;
  sim.handsUp ??= {};
  sim.handsUp[p.id] = handsUp;
  const charge = owner && (cmd?.shoot || state.charge[p.id]);
  const settingScreen = !!cmd?.screen && !cmd?.callScreen;
  const posting = !!(owner && cmd?.postUp && !wantsSprint && rangeToRim < 7.8 && !deadDribble);
  sim.postUp ??= {};
  sim.postUp[p.id] = posting;

  sim.contestHeld ??= {};
  const contesting = !!cmd?.contest;
  const wasContesting = !!sim.contestHeld[p.id];
  sim.contestHeld[p.id] = contesting;
  if (contesting && !wasContesting && canAct(p.id + '/contest', 30)) {
    sim.jumpContest ??= {};
    sim.jumpContest[p.id] = state.tick + 22;
    sim.jumpContestStart ??= {};
    sim.jumpContestStart[p.id] = state.tick;
    p.stamina = Math.max(0, p.stamina - 2.0);
  }

  // Track explosive sprint starts for adrenaline bursts.
  sim.lastSprintTick ??= {};
  const prevSprintTick = sim.lastSprintTick[p.id] ?? -999;
  const sprintEdge = wantsSprint && state.tick - prevSprintTick > 4;
  if (wantsSprint) sim.lastSprintTick[p.id] = state.tick;

  if (dribble && dribble.ballState === 'tripleThreat' && norm > 0.15 && !cmd?.dribble && !charge && !cmd?.pumpFake && !posting) {
    dribble.ballState = 'live';
    if (dribble.adrenaline > 0) {
      sim.burst ??= {};
      sim.burst[p.id] = Math.max(sim.burst[p.id] ?? 0, state.tick + 18);
    }
  } else if (dribble && dribble.ballState === 'live' && sprintEdge && dribble.adrenaline > 0 && !dribble.move) {
    dribble.adrenaline = Math.max(0, dribble.adrenaline - 1);
    sim.burst ??= {};
    sim.burst[p.id] = Math.max(sim.burst[p.id] ?? 0, state.tick + 20);
  }

  // Fatigue visibly slows top speed, sprint ceiling, and lateral cut snap.
  const staminaFactor = p.stamina >= 45 ? 1 : 0.72 + (p.stamina / 45) * 0.28;
  const sprintTopMult = wantsSprint ? 1 + 0.46 * clamp((p.stamina - 8) / 37, 0.38, 1) : 1;
  const burstActive = (sim.burst?.[p.id] ?? 0) > state.tick;
  const hasAdrenaline = !dribble || dribble.adrenaline > 0;
  const burstFactor = burstActive ? (hasAdrenaline ? 1.20 : 1.05) : 1;

  const contestSlow = contesting ? 0.70 : 1;
  const handsUpSlow = handsUp && !intenseD ? 0.84 : 1;
  const intenseSlow = intenseD ? 0.84 : 1;
  const postSlow = posting ? 0.46 : 1;
  const stumbling = (sim.stumble?.[p.id] ?? 0) > state.tick;
  const stunned = (sim.stun?.[p.id] ?? 0) > state.tick;
  const flyBy = (sim.flyBy?.[p.id] ?? 0) > state.tick;
  const lunging = (sim.stealLunge?.[p.id] ?? 0) > state.tick;
  const stunAccel = lunging ? 0.38 : stunned ? 0.48 : stumbling ? 0.62 : flyBy ? 0.70 : 1;
  const bodyUp = sim.bodyUp?.[p.id];
  const bodyUpFactor = bodyUp === 'clamp' ? 0.78 : bodyUp === 'ride' ? 0.88 : bodyUp === 'blowby' ? 1.16 : 1;
  const deadFactor = deadDribble ? 0.14 : 1;
  const bobbleFactor = dribble?.bobbleTicks && dribble.bobbleTicks > state.tick ? 0.65 : 1;

  // Ball-hand awareness: attacking along the ball-hand side grants a slight driving angle edge.
  let handDriveBonus = 1;
  if (owner && dribble && dribble.ballState === 'live' && norm > 0.25 && !dribble.move) {
    const fx = Math.cos(p.facing);
    const fz = Math.sin(p.facing);
    const localSide = (fz * dx - fx * dz) / norm;
    if (localSide * dribble.hand > 0.25) handDriveBonus = 1.04;
    else if (localSide * dribble.hand < -0.35 && wantsSprint) handDriveBonus = 0.96;
  }

  if (dribble) {
    if (dribble.ballState === 'live' && !dribble.move && !charge && !cmd?.postUp && !cmd?.pumpFake &&
      !cmd?.pass && !cmd?.dribble && !sim.gather && (sim.pumpFake?.[p.id] ?? 0) <= state.tick) {
      trackDirectionalCut(p, dribble, { x: dx, z: dz }, state.tick, state.ball.position.y);
    } else {
      delete dribble.pendingCut;
      delete dribble.cutHeading;
    }
  }

  let cutFactor = 1;
  sim.prevMoveDir ??= {};
  if (norm > 0.25) {
    const ux = dx / norm;
    const uz = dz / norm;
    const prev = sim.prevMoveDir[p.id];
    if (prev) {
      const dot = prev.x * ux + prev.z * uz;
      if (dot < 0.2) cutFactor = clamp(0.86 + (dot + 1) * 0.06, 0.86, 0.98);
    }
    sim.prevMoveDir[p.id] = { x: ux, z: uz };
  }

  const shotIntent = cmd?.shotType ?? sim.gather?.style ??
    (rangeToRim < 2.45 && wantsSprint ? 'dunk' : rangeToRim < 2.45 && norm > 0.45 ? 'layup' : undefined);
  const drivingFinish = !!(charge && (
    shotIntent === 'dunk' ||
    shotIntent === 'contactDunk' ||
    shotIntent === 'layup' ||
    shotIntent === 'reverseLayup' ||
    shotIntent === 'euro'
  ));

  const maxSpeed = (3.5 + p.profile.ratings.speed * 0.024) * staminaFactor * sprintTopMult * burstFactor *
    (owner ? 0.94 : 1) * (drivingFinish ? 0.68 : charge ? 0.24 : settingScreen ? 0.12 : contestSlow) *
    intenseSlow * handsUpSlow * postSlow * cutFactor * bodyUpFactor * deadFactor * bobbleFactor * handDriveBonus;

  const physique = body(p);
  const massExp = (physique.mass / 95) ** 0.3;
  const drain = wantsSprint
    ? -7.5 * massExp
    : intenseD && norm > 0.1
      ? -1.6 * massExp
      : handsUp
        ? -0.4 * massExp
        : state.tick - prevSprintTick < 35
          ? 1.4
          : 3.6;
  p.stamina = clamp(p.stamina + DT * drain, 0, 100);

  // True inertia, turning radius, and momentum-preserving cuts (with crisp intense-D lateral slides).
  const lateralSlideBoost = intenseD && !stunned && !stumbling && !flyBy && !lunging
    ? clamp(1.20 + (p.profile.ratings.perimeter - 65) * 0.004, 1.08, 1.36)
    : 1;
  const accel = physique.acceleration * stunAccel * (p.stamina < 30 ? 0.86 : 1) * lateralSlideBoost;
  const curSpeed = Math.hypot(p.velocity.x, p.velocity.z);
  const activeDribbleMove = !!(dribble?.move && !dribble.move.cutBounce && state.tick - dribble.move.started < dribble.move.duration);

  if (norm < 0.08) {
    // Crisp athletic two-foot braking when user releases stick/keys (slowed during lunge recovery).
    const brake = lunging ? accel : activeDribbleMove ? accel * 0.45 : physique.brakeRate;
    p.velocity.x += -p.velocity.x * brake;
    p.velocity.z += -p.velocity.z * brake;
  } else {
    const inputMag = Math.min(1, norm);
    const ux = dx / norm;
    const uz = dz / norm;
    const targetVx = ux * maxSpeed * inputMag;
    const targetVz = uz * maxSpeed * inputMag;

    if (curSpeed > 1.8 && !activeDribbleMove && !charge) {
      const ovx = p.velocity.x / curSpeed;
      const ovz = p.velocity.z / curSpeed;
      const align = ovx * ux + ovz * uz;

      if (align < -0.35) {
        // Hard 180-degree reversal at speed: bleed forward momentum smoothly while planting.
        sim.plantCut ??= {};
        sim.plantCut[p.id] = state.tick + 8;
        const bleed = clamp(0.14 + (95 / physique.mass) * 0.06, 0.14, 0.23) * (intenseD ? 1.18 : 1);
        const retained = curSpeed * (1 - bleed);
        const pushAccel = accel * 0.44;
        p.velocity.x = ovx * retained + (targetVx - ovx * retained) * pushAccel;
        p.velocity.z = ovz * retained + (targetVz - ovz * retained) * pushAccel;
      } else if (align < 0.88) {
        // Curved turn: constrain lateral velocity decay by tire-like court traction -> genuine turning radius!
        const vPar = p.velocity.x * ux + p.velocity.z * uz;
        const vPerpX = p.velocity.x - vPar * ux;
        const vPerpZ = p.velocity.z - vPar * uz;
        const vPerpMag = Math.hypot(vPerpX, vPerpZ);
        const maxLateralDelta = (9.5 + p.profile.ratings.speed * 0.085) * (95 / physique.mass) ** 0.45 *
          staminaFactor * (intenseD ? 1.28 : 1) * stunAccel * DT;
        const nextPerpScale = vPerpMag > maxLateralDelta ? (vPerpMag - maxLateralDelta) / vPerpMag : 0;
        const nextPar = vPar + (maxSpeed * inputMag - vPar) * accel;
        p.velocity.x = ux * nextPar + vPerpX * nextPerpScale;
        p.velocity.z = uz * nextPar + vPerpZ * nextPerpScale;
      } else {
        // Straight acceleration curve: explosive first-step response, tapering at top sprint speed.
        const stepFactor = curSpeed < maxSpeed * 0.55 ? Math.min(0.42, accel * 1.18) : accel;
        p.velocity.x += (targetVx - p.velocity.x) * stepFactor;
        p.velocity.z += (targetVz - p.velocity.z) * stepFactor;
      }
    } else {
      const stepFactor = curSpeed < 1.5 ? Math.min(0.42, accel * 1.15) : accel;
      p.velocity.x += (targetVx - p.velocity.x) * stepFactor;
      p.velocity.z += (targetVz - p.velocity.z) * stepFactor;
    }
  }

  // Intense-D light pocket shading assist (only when neutral or aligned; wrong lateral guesses stay off-line).
  const ballOwner = state.ball.ownerId ? state.players.find(q => q.id === state.ball.ownerId) : undefined;
  if (!owner && intenseD && ballOwner && ballOwner.id !== p.id && distance(p.position, ballOwner.position) < 2.4 && !stunned && !stumbling && !flyBy && !lunging) {
    const defHoopX = sign(ballOwner.side) * COURT.rimX;
    const bhDist = Math.max(0.1, Math.hypot(defHoopX - ballOwner.position.x, -ballOwner.position.z));
    const idealX = ballOwner.position.x + ((defHoopX - ballOwner.position.x) / bhDist) * 0.85;
    const idealZ = ballOwner.position.z + (-ballOwner.position.z / bhDist) * 0.85;
    const toIdealX = idealX - p.position.x;
    const toIdealZ = idealZ - p.position.z;
    const steerAlign = norm < 0.15 ? 1 : (dx * toIdealX + dz * toIdealZ) / (norm * Math.max(0.05, Math.hypot(toIdealX, toIdealZ)));
    if (steerAlign > 0.25) {
      p.velocity.x += clamp(toIdealX * 2.1, -1.5, 1.5) * 0.06;
      p.velocity.z += clamp(toIdealZ * 2.1, -1.5, 1.5) * 0.06;
    }
  }

  // Shot gather momentum (fadeaway, step-back, euro weave, driving rim carry).
  if (charge && (shotIntent === 'fadeaway' || sim.gather?.backward)) {
    p.velocity.x -= sign(p.side) * 0.16;
  } else if (charge && shotIntent === 'stepBack') {
    p.velocity.x -= sign(p.side) * 0.18;
  } else if (charge && shotIntent === 'euro') {
    const ch = state.charge[p.id] || 0;
    const sideSign = p.position.z >= 0 ? -1 : 1;
    const zig = ch < 0.26 ? sideSign : -sideSign;
    p.velocity.z += zig * 0.14;
    p.velocity.x += sign(p.side) * 0.12;
  } else if (charge && (shotIntent === 'dunk' || shotIntent === 'contactDunk' || shotIntent === 'layup' || shotIntent === 'reverseLayup') &&
    (state.charge[p.id] || 0) < 0.36 && rangeToRim > 0.65 && rangeToRim < 3.8 && (sim.gather?.approach ?? norm) >= 0.8) {
    const toRimUx = (hoopX - p.position.x) / rangeToRim;
    const toRimUz = -p.position.z / rangeToRim;
    const carrySpeed = Math.max(3.1, (sim.gather?.approach ?? 3.1) * 0.78);
    p.velocity.x += (toRimUx * carrySpeed - p.velocity.x) * 0.24;
    p.velocity.z += (toRimUz * carrySpeed - p.velocity.z) * 0.24;
  }

  p.position.x = clamp(p.position.x + p.velocity.x * DT, half ? 0.32 : -LIMIT_X, LIMIT_X);
  p.position.z = clamp(p.position.z + p.velocity.z * DT, -LIMIT_Z, LIMIT_Z);

  // Smooth angular turning (capped by speed & weight) instead of instant 180° snaps.
  const sliding = !owner && p.side !== state.possession && norm > 0.08 && !wantsSprint &&
    state.ball.ownerId !== null && distance(p.position, state.ball.position) < 3.6;
  const hoopAngle = Math.atan2(-p.position.z, hoopX - p.position.x);
  const speedTurnScale = curSpeed > 2.6 ? clamp(1 - (curSpeed - 2.6) * 0.11, 0.42, 1) : 1.15;
  const moveMaxTurn = physique.turnRate * DT * speedTurnScale;
  const pivotMaxTurn = 32 * DT;

  if (owner && posting && !charge) {
    const awayX = p.position.x - hoopX;
    const awayZ = p.position.z;
    if (Math.hypot(awayX, awayZ) > 0.05) p.facing = rotateToward(p.facing, Math.atan2(awayZ, awayX), pivotMaxTurn);
  } else if (owner && ((rangeToRim < 11.5 && !wantsSprint) || charge || dribble?.ballState === 'tripleThreat' ||
    dribble?.move?.type === 'stepBack' || dribble?.move?.type === 'snatchBack' || dribble?.move?.type === 'hesitation')) {
    if (Math.hypot(hoopX - p.position.x, p.position.z) > 0.05) {
      p.facing = rotateToward(p.facing, hoopAngle, charge ? 48 * DT : pivotMaxTurn);
    }
  } else if ((intenseD || handsUp || sliding) && ballOwner && ballOwner.id !== p.id && distance(p.position, ballOwner.position) < 4.8) {
    const fx = ballOwner.position.x - p.position.x;
    const fz = ballOwner.position.z - p.position.z;
    if (Math.hypot(fx, fz) > 0.05) p.facing = rotateToward(p.facing, Math.atan2(fz, fx), lunging ? 8 * DT : pivotMaxTurn);
  } else if (norm > 0.08) {
    p.facing = rotateToward(p.facing, Math.atan2(dz, dx), lunging ? 8 * DT : moveMaxTurn);
  }

  const released = sim.release?.playerId === p.id && sim.release.until > state.tick;
  const jumpContesting = (sim.jumpContest?.[p.id] ?? 0) > state.tick;
  const pumpFaking = (sim.pumpFake?.[p.id] ?? 0) > state.tick;
  const stealing = (sim.stealPose?.[p.id] ?? 0) > state.tick;
  p.pose = pumpFaking ? 'pumpFake'
    : stealing ? 'steal'
    : charge || released ? 'shoot'
    : contesting || jumpContesting ? 'contest'
    : flyBy ? 'flyBy'
    : stumbling ? 'stumble'
    : settingScreen ? 'screen'
    : bodyUp && bodyUp !== 'blowby' ? 'bodyUp'
    : posting ? 'postUp'
    : owner ? 'dribble'
    : intenseD || handsUp || sliding ? 'slide'
    : norm > 0.08 ? 'run'
    : 'idle';
}

function pusherRatio(a: GamePlayer, b: GamePlayer, body: (p: GamePlayer) => PlayerBody, sim: Runtime): number {
  const leverage = (p: GamePlayer) => body(p).leverage * (p.pose === 'screen' ? 3.2 : p.pose === 'postUp' || sim.postUp?.[p.id] ? 1.35 : 1);
  const aHold = leverage(a);
  const bHold = leverage(b);
  return bHold / (aHold + bHold);
}

/** Resolve pairwise body collisions using player mass, strength, and screen/post leverage. */
export function separatePlayers(
  players: GamePlayer[],
  body: (p: GamePlayer) => PlayerBody,
  half: boolean,
  sim: Runtime,
): void {
  const minX = half ? 0.32 : -LIMIT_X;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const d = distance(a.position, b.position);
      if (d >= 0.67) continue;
      const dx = d ? (a.position.x - b.position.x) / d : 1;
      const dz = d ? (a.position.z - b.position.z) / d : 0;
      const push = pusherRatio(a, b, body, sim) * (0.67 - d);
      const rest = 0.67 - d - push;
      a.position.x = clamp(a.position.x + dx * push, minX, LIMIT_X);
      a.position.z = clamp(a.position.z + dz * push, -LIMIT_Z, LIMIT_Z);
      b.position.x = clamp(b.position.x - dx * rest, minX, LIMIT_X);
      b.position.z = clamp(b.position.z - dz * rest, -LIMIT_Z, LIMIT_Z);
    }
  }
}