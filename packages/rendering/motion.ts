import type { GameEvent, GamePlayer, GameState, Vec3 } from '../contracts/index.ts';
import { TICK_RATE } from '../contracts/index.ts';
import { MathUtils } from 'three';

const { clamp, lerp } = MathUtils;
const point = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const jointChain = () => ({ start: point(0, 0, 0), joint: point(0, 0, 0), end: point(0, 0, 0), pitch: 0 });
const change = (p: Vec3, x: number, y: number, z: number) => { p.x = x; p.y = y; p.z = z; };
const blend = (p: Vec3, x: number, y: number, z: number, amount: number) => change(p, lerp(p.x, x, amount), lerp(p.y, y, amount), lerp(p.z, z, amount));
const angleDistance = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function motionEvents(state: GameState) {
  const latest = new Map<string, GameEvent>();
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i];
    if (state.tick - event.tick > 45) break;
    if (event.playerId && !latest.has(event.playerId) && ['shot', 'pass', 'rebound', 'block', 'steal'].includes(event.type)) latest.set(event.playerId, event);
  }
  return latest;
}

export function makeMotion(stature: number, thickness: number, hash: number, armScale = 1) {
  const scale = stature / 2.02;
  const arms = [jointChain(), jointChain()];
  const legs = [jointChain(), jointChain()];
  const pose = { arms, legs, facing: 0, rise: 0, crouch: 0, tilt: 0, roll: 0, twist: 0 };
  let stride = (hash % 79) * 0.08;
  let lastTick = -1;
  let lastContest = -1;
  let smoothFacing = 0;
  let contest = 0;
  let screen = 0;
  let gather = 0;
  let dribble = 0;
  let slide = 0;
  let pumpFake = 0;
  let stealSwipe = 0;
  let intenseD = 0;
  let bodyUp = 0;
  let stumble = 0;
  let flyBy = 0;
  let deadDribble = 0;
  let tripleThreat = 0;
  let postUp = 0;
  let speed = 0;
  let wasContesting = false;

  return function animate(player: GamePlayer, tick: number, held: Vec3 | undefined, charge: number, event: GameEvent | undefined) {
    const reset = tick < lastTick || lastTick < 0;
    const dt = reset ? 1 / TICK_RATE : clamp((tick - lastTick) / TICK_RATE, 0, 0.12);
    const fast = reset ? 1 : 1 - Math.exp(-dt * 16);
    const soft = reset ? 1 : 1 - Math.exp(-dt * 10);
    const contesting = player.pose === 'contest';
    const action = player.action;
    if (reset) {
      lastContest = -1;
      wasContesting = false;
      smoothFacing = player.facing;
      pose.facing = player.facing;
      intenseD = 0;
      bodyUp = 0;
      stumble = 0;
      flyBy = 0;
      deadDribble = 0;
      tripleThreat = 0;
      postUp = 0;
    }
    if (contesting && !wasContesting) lastContest = tick;
    wasContesting = contesting;
    lastTick = tick;
    smoothFacing += angleDistance(smoothFacing, player.facing) * fast;
    const dm = action?.dribbleMove;
    const mp = action?.moveProgress ?? 0;
    const mDir = action?.moveDir ?? 1;
    const spinAngle = dm === 'spin' ? mDir * mp * Math.PI * 2 : 0;
    pose.facing = smoothFacing + spinAngle;

    speed = lerp(speed, Math.hypot(player.velocity.x, player.velocity.z), soft);
    const movement = clamp(speed / 6.2, 0, 1);
    const lateral = speed > 0.1 ? clamp((Math.sin(smoothFacing) * player.velocity.x - Math.cos(smoothFacing) * player.velocity.z) / speed, -1, 1) : 0;
    const direction = speed > 0.1 && Math.cos(smoothFacing) * player.velocity.x + Math.sin(smoothFacing) * player.velocity.z < -0.2 ? -1 : 1;
    stride += dt * Math.PI * (1.25 + speed * 0.69);
    screen = lerp(screen, Number(player.pose === 'screen'), fast);
    contest = lerp(contest, Number(contesting), fast);
    gather = lerp(gather, charge > 0 ? 0.48 + clamp(charge / 0.68, 0, 1) * 0.48 : 0, fast);
    dribble = lerp(dribble, Number(Boolean(held)), fast);
    slide = lerp(slide, Number(player.pose === 'slide'), fast);
    pumpFake = lerp(pumpFake, Number(player.pose === 'pumpFake'), fast);
    const age = event ? (tick - event.tick) / TICK_RATE : Infinity;
    stealSwipe = lerp(stealSwipe, Number(player.pose === 'steal' || (event?.type === 'steal' && age < 0.32)), fast);
    intenseD = lerp(intenseD, Number(Boolean(action?.intenseD)), fast);
    bodyUp = lerp(bodyUp, Number(player.pose === 'bodyUp' || action?.bodyUp === 'clamp' || action?.bodyUp === 'ride'), fast);
    stumble = lerp(stumble, action?.stumble ?? Number(player.pose === 'stumble'), fast);
    flyBy = lerp(flyBy, action?.flyBy ?? Number(player.pose === 'flyBy'), fast);
    deadDribble = lerp(deadDribble, Number(Boolean(held && (action?.deadDribble || action?.ballState === 'dead'))), fast);
    tripleThreat = lerp(tripleThreat, Number(Boolean(held && action?.ballState === 'tripleThreat' && !dm)), fast);
    postUp = lerp(postUp, Number(player.pose === 'postUp' || action?.postUp), fast);

    const shot = event?.type === 'shot' && age < 0.53 ? clamp(1 - Math.max(0, age - 0.2) / 0.33, 0, 1) : 0;
    const activeShotStyle = action?.shotStyle ?? (
      event?.detail?.startsWith('Dunk') || event?.detail?.startsWith('Alley-oop') ? 'dunk'
        : event?.detail?.startsWith('Hook') ? 'hook'
        : event?.detail?.startsWith('Fadeaway') ? 'fadeaway'
        : event?.detail?.startsWith('Step-back') ? 'stepBack'
        : event?.detail?.startsWith('Euro') ? 'euro'
        : event?.detail?.startsWith('Floater') ? 'floater'
        : event?.detail?.startsWith('Layup') ? 'layup'
        : undefined
    );
    const activeShot = Math.max(shot, charge > 0 ? clamp(charge / 0.5, 0, 0.85) : 0);
    const dunk = (shot > 0 || charge > 0) && activeShotStyle === 'dunk';
    const hookShot = (shot > 0 || charge > 0) && activeShotStyle === 'hook';
    const euroShot = (shot > 0 || charge > 0) && activeShotStyle === 'euro';
    const floaterShot = (shot > 0 || charge > 0) && activeShotStyle === 'floater';
    const fadeOrStepBack = (shot > 0 || charge > 0) && (activeShotStyle === 'fadeaway' || activeShotStyle === 'stepBack');
    const highFinish = dunk || activeShotStyle === 'layup' || hookShot || floaterShot || euroShot;
    const passing = event?.type === 'pass' && age < 0.36 ? Math.sin((age + 0.07) / 0.43 * Math.PI) : 0;
    const contestAge = lastContest < 0 ? Infinity : (tick - lastContest) / TICK_RATE;
    const jumpArc = (t: number, duration: number) => t < duration ? Math.sin(Math.PI * (t + 0.035) / (duration + 0.035)) : 0;
    const gatherJump = charge > 0 ? clamp((charge - 0.20) / 0.42, 0, 1) * 0.30 : 0;
    const lateGather = charge > 0 ? clamp((charge - 0.34) / 0.28, 0, 1) : 0;
    const jump = action?.jumpHeight !== undefined
      ? action.jumpHeight
      : Math.max(gatherJump, shot ? jumpArc(age, 0.53) * (dunk ? 0.62 : 0.31) : 0, jumpArc(contestAge, 0.48) * 0.34,
          event?.type === 'rebound' || event?.type === 'block' ? jumpArc(age, 0.42) * 0.26 : 0);
    const defense = Math.max(contest, event?.type === 'rebound' || event?.type === 'block' ? jumpArc(age, 0.45) : 0);
    const run = movement * (1 - clamp(jump, 0, 1) * 0.92) * (1 - screen * 0.84) * (1 - stumble * 0.55);

    const moveArc = dm ? Math.sin(mp * Math.PI) : 0;
    const moveRoll = dm === 'crossover' ? mDir * moveArc * 0.24
      : dm === 'inAndOut' ? mDir * moveArc * 0.28
      : dm === 'jab' ? mDir * moveArc * 0.18
      : dm === 'behindBack' ? -mDir * moveArc * 0.14
      : 0;
    const moveTilt = dm === 'stepBack' ? -moveArc * 0.22
      : dm === 'jab' ? moveArc * 0.18
      : dm === 'spin' ? moveArc * 0.16
      : 0;
    const moveTwist = dm === 'behindBack' ? mDir * moveArc * 0.46
      : dm === 'betweenLegs' ? -mDir * moveArc * 0.24
      : dm === 'inAndOut' ? mDir * moveArc * 0.22
      : 0;
    const moveCrouch = dm === 'betweenLegs' ? moveArc * 0.22
      : dm === 'stepBack' ? moveArc * 0.18
      : dm === 'jab' ? moveArc * 0.16
      : dm === 'crossover' ? moveArc * 0.14
      : dm === 'spin' ? moveArc * 0.12
      : dm === 'behindBack' ? moveArc * 0.12
      : 0;
    const moveRise = dm === 'hesitation' ? moveArc * 0.055 : dm === 'inAndOut' ? moveArc * 0.035 : 0;

    const gPhase = action?.gatherPhase ?? (charge > 0 ? clamp(charge / 0.62, 0, 1) : 0);
    const euroWeave = euroShot ? Math.sin(gPhase * Math.PI * 2) * 0.24 : 0;
    const gatherDip = charge > 0 ? clamp(1 - Math.max(0, charge - 0.22) / 0.16, 0, 1) : 0;
    const crouch = movement * 0.09 + screen * 0.12 + gather * (1 - shot) * gatherDip * 0.14 +
      slide * 0.10 + intenseD * 0.15 + bodyUp * 0.12 + postUp * 0.16 + pumpFake * 0.14 +
      tripleThreat * 0.13 + deadDribble * 0.07 + stumble * 0.18 + moveCrouch;
    pose.rise = jump + moveRise + (0.008 + (1 - Math.cos(stride * 2)) * 0.023) * run;
    pose.crouch = crouch;
    pose.tilt = run * 0.15 + screen * 0.12 + gather * 0.08 + stealSwipe * 0.28 +
      bodyUp * 0.18 + intenseD * 0.10 + postUp * 0.22 + flyBy * 0.42 + (dunk ? activeShot * 0.24 : 0) -
      (fadeOrStepBack ? activeShot * 0.36 : 0) + moveTilt + stumble * Math.cos(tick * 0.42) * 0.18;
    pose.roll = -lateral * run * 0.11 + Math.sin(stride) * run * 0.035 + moveRoll + euroWeave + stumble * Math.sin(tick * 0.55) * 0.34;
    pose.twist = Math.sin(stride) * 0.1 * run + stealSwipe * 0.35 +
      (hookShot ? activeShot * 0.52 : highFinish ? shot * 0.19 : 0) + moveTwist + bodyUp * 0.14 + postUp * 0.26;

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? -1 : 1;
      const step = stride + i * Math.PI;
      const swing = Math.sin(step) * run * 0.46;
      const lift = Math.max(0, Math.cos(step)) ** 1.5 * run * 0.26;
      const spacing = thickness * 0.143 + screen * 0.16 + slide * 0.14 + intenseD * 0.16 +
        bodyUp * 0.12 + postUp * 0.17 + deadDribble * 0.08 + stumble * 0.18 + (dm === 'betweenLegs' ? moveArc * 0.15 : 0);
      const scissor = dm === 'betweenLegs' ? (sign === mDir ? 1 : -1) * moveArc * 0.36
        : dm === 'jab' && sign === mDir ? moveArc * 0.34
        : 0;
      const euroKnee = euroShot ? (i === 0 ? Math.sin(gPhase * Math.PI * 2) : -Math.sin(gPhase * Math.PI * 2)) * 0.22 : 0;
      const fadeLeg = fadeOrStepBack && i === 1 ? activeShot * 0.26 : 0;
      const dunkTuck = dunk ? jump * 0.22 : 0;
      const flyLegZ = -flyBy * 0.40;
      const leg = legs[i];
      change(leg.start, sign * 0.121 * thickness, 1.085 - crouch * 0.88, 0);
      change(leg.joint, sign * (spacing + 0.007) + swing * lateral * 0.25,
        0.545 + lift * 0.43 - crouch * 0.52 + euroKnee * 0.45 + dunkTuck * 0.5,
        0.077 + swing * direction * 0.62 + crouch * 0.72 + scissor * 0.6 + fadeLeg * 0.5);
      change(leg.end, sign * spacing + swing * lateral * 0.48 + stumble * sign * 0.14,
        0.105 + lift + jump * (sign === 1 ? 0.14 : 0.34) + Math.max(0, euroKnee) * 0.5 + dunkTuck,
        swing * direction * (1 - Math.abs(lateral) * 0.54) - jump * (sign === 1 ? -0.2 : 0.46) + scissor + fadeLeg + flyLegZ);
      leg.pitch = -Math.cos(step) * run * 0.34 + jump * 0.27;

      const arm = arms[i];
      const shoulder = sign * 0.231 * thickness;
      change(arm.start, shoulder, 1.612 - crouch, (1.612 - 1.29) * pose.tilt - shoulder * pose.twist);
      change(arm.joint, sign * (0.268 * thickness + run * 0.024), 1.345 - crouch + run * 0.091,
        -swing * 0.58 + run * 0.048);
      change(arm.end, sign * (0.285 * thickness + run * 0.021), 1.086 - crouch + run * 0.28,
        -swing * 0.73 + run * 0.25 + 0.036);
      blend(arm.joint, sign * 0.332, 1.304 - crouch, 0.087, screen);
      blend(arm.end, sign * 0.075, 1.22 - crouch, 0.237, screen);
      blend(arm.joint, sign * 0.42, 1.34 - crouch, 0.08, slide);
      blend(arm.end, sign * 0.52, 1.28 - crouch, 0.22, slide);
      if (intenseD > 0.02) {
        if (i === 1) {
          blend(arm.joint, 0.34, 1.66 - crouch, 0.18, intenseD);
          blend(arm.end, 0.24, 1.92 - crouch, 0.30, intenseD);
        } else {
          blend(arm.joint, -0.44, 1.30 - crouch, 0.16, intenseD);
          blend(arm.end, -0.52, 1.15 - crouch, 0.34, intenseD);
        }
      }
      if (bodyUp > 0.02) {
        blend(arm.joint, sign * 0.29, 1.42 - crouch, 0.20, bodyUp);
        blend(arm.end, sign * 0.14, 1.54 - crouch, 0.30, bodyUp);
      }
      if (held) {
        const dx = held.x - player.position.x;
        const dz = held.z - player.position.z;
        const side = (Math.sin(pose.facing) * dx - Math.cos(pose.facing) * dz) / scale;
        const front = (Math.cos(pose.facing) * dx + Math.sin(pose.facing) * dz) / scale;
        const reach = clamp((held.y - pose.rise) / scale + 0.15, 0.87, 1.49);
        const reachZ = dm === 'behindBack' ? -0.26 * moveArc : clamp(front, -0.31, 0.58);
        if (sign * side > 0 || (Math.abs(side) < 0.025 && sign === 1)) {
          blend(arm.joint, sign * 0.286, 1.32 - crouch, dm === 'behindBack' ? -0.14 * moveArc : Math.max(0.035, front * 0.61), dribble);
          blend(arm.end, clamp(side, -0.54, 0.54), reach, reachZ, dribble);
        } else {
          blend(arm.joint, sign * 0.348, 1.379 - crouch, 0.09, dribble * 0.81);
          blend(arm.end, sign * 0.404, 1.33 - crouch, 0.293, dribble * 0.81);
        }
        if (deadDribble > 0.02) {
          blend(arm.joint, sign * 0.24, 1.44 - crouch, 0.18, deadDribble);
          blend(arm.end, sign * 0.08, 1.54 - crouch, 0.29, deadDribble);
        }
        if (tripleThreat > 0.02) {
          blend(arm.joint, sign * 0.25, 1.34 - crouch, 0.20, tripleThreat);
          blend(arm.end, clamp(side + sign * 0.05, -0.36, 0.36), reach, clamp(front, 0.12, 0.42), tripleThreat * 0.72);
        }
        if (dm === 'hesitation') {
          if (i === 0) {
            blend(arm.joint, -0.32, 1.48 - crouch, 0.22, moveArc);
            blend(arm.end, -0.22, 1.56 - crouch, 0.36, moveArc);
          }
        }
      }
      blend(arm.joint, sign * 0.236, 1.43 - crouch + gather * 0.25, 0.177, gather);
      blend(arm.end, sign * 0.112, 1.51 - crouch + gather * 0.3, 0.31, gather);
      blend(arm.joint, sign * 0.21, 1.78, 0.20, lateGather);
      blend(arm.end, sign * 0.12, 2.04, 0.25, lateGather);
      blend(arm.joint, sign * 0.22, 1.62 - crouch, 0.24, pumpFake);
      blend(arm.end, sign * 0.11, 1.88 - crouch, 0.32, pumpFake);
      blend(arm.joint, sign * 0.369, 1.825 - crouch, 0.11, defense);
      blend(arm.end, sign * (i === 1 ? 0.36 : 0.50), 2.118 - crouch - (i === 1 ? 0 : 0.16), 0.16, defense);
      if (flyBy > 0.02) {
        blend(arm.joint, sign * 0.26, 1.88 - crouch, 0.28, flyBy);
        blend(arm.end, sign * 0.22, 2.24 - crouch, 0.48, flyBy);
      }
      if (stumble > 0.02) {
        const flail = Math.sin(tick * 0.5 + i * Math.PI) * 0.16;
        blend(arm.joint, sign * 0.46, 1.46 - crouch + flail, 0.05, stumble);
        blend(arm.end, sign * 0.62, 1.55 - crouch + flail * 1.4, -0.06 + flail, stumble);
      }
      if (i === 1) {
        blend(arm.joint, 0.24, 1.46 - crouch, 0.34, stealSwipe);
        blend(arm.end, 0.12, 1.32 - crouch, 0.68, stealSwipe);
      } else {
        blend(arm.joint, -0.34, 1.35 - crouch, -0.14, stealSwipe);
        blend(arm.end, -0.40, 1.24 - crouch, -0.22, stealSwipe);
      }
      blend(arm.joint, sign * 0.196, 1.40 - crouch, 0.34, passing);
      blend(arm.end, sign * 0.135, 1.47 - crouch, 0.65, passing);
      const hookOffset = hookShot && i === 1 ? 0.28 : 0;
      const offArmShield = hookShot && i === 0 ? -0.18 : 0;
      const endY = highFinish
        ? (i === 1 ? (dunk ? 2.38 : floaterShot ? 2.28 : 2.26) : 1.56)
        : (i === 1 ? 2.15 : 1.99);
      const endZ = dunk ? 0.34 : 0.22 + Math.min(age, 0.4) * 0.43;
      blend(arm.joint, sign * (highFinish ? 0.32 : 0.217) + hookOffset + offArmShield, i === 0 && highFinish ? 1.5 : 1.875, 0.2, shot);
      blend(arm.end, sign * (highFinish ? 0.31 : 0.131) + hookOffset + offArmShield, endY, endZ, shot);
      if (postUp > 0.02) {
        if (i === 0) {
          blend(arm.joint, -0.38, 1.48 - crouch, -0.14, postUp);
          blend(arm.end, -0.48, 1.44 - crouch, -0.24, postUp);
        } else {
          blend(arm.joint, 0.26, 1.40 - crouch, 0.18, postUp);
          blend(arm.end, 0.16, 1.32 - crouch, 0.34, postUp);
        }
      }
      if (armScale !== 1) {
        arm.joint.x = shoulder + (arm.joint.x - shoulder) * armScale;
        arm.joint.y = arm.start.y + (arm.joint.y - arm.start.y) * armScale;
        arm.joint.z = arm.start.z + (arm.joint.z - arm.start.z) * armScale;
        arm.end.x = shoulder + (arm.end.x - shoulder) * armScale;
        arm.end.y = arm.start.y + (arm.end.y - arm.start.y) * armScale;
        arm.end.z = arm.start.z + (arm.end.z - arm.start.z) * armScale;
      }
      arm.pitch = -shot * 0.84 - passing * 0.86;
    }
    return pose;
  };
}
