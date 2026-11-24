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

export function makeMotion(stature: number, thickness: number, hash: number) {
  const scale = stature / 2.02;
  const arms = [jointChain(), jointChain()];
  const legs = [jointChain(), jointChain()];
  const pose = { arms, legs, facing: 0, rise: 0, crouch: 0, tilt: 0, roll: 0, twist: 0 };
  let stride = (hash % 79) * 0.08;
  let lastTick = -1;
  let lastContest = -1;
  let contest = 0;
  let screen = 0;
  let gather = 0;
  let dribble = 0;
  let slide = 0;
  let pumpFake = 0;
  let stealSwipe = 0;
  let speed = 0;
  let wasContesting = false;

  return function animate(player: GamePlayer, tick: number, held: Vec3 | undefined, charge: number, event: GameEvent | undefined) {
    const reset = tick < lastTick || lastTick < 0;
    const dt = reset ? 1 / TICK_RATE : clamp((tick - lastTick) / TICK_RATE, 0, 0.12);
    const fast = reset ? 1 : 1 - Math.exp(-dt * 16);
    const soft = reset ? 1 : 1 - Math.exp(-dt * 10);
    const contesting = player.pose === 'contest';
    if (reset) {
      lastContest = -1;
      wasContesting = false;
      pose.facing = player.facing;
    }
    if (contesting && !wasContesting) lastContest = tick;
    wasContesting = contesting;
    lastTick = tick;
    pose.facing += angleDistance(pose.facing, player.facing) * fast;
    speed = lerp(speed, Math.hypot(player.velocity.x, player.velocity.z), soft);
    const movement = clamp(speed / 6.2, 0, 1);
    const lateral = speed > 0.1 ? clamp((Math.sin(pose.facing) * player.velocity.x - Math.cos(pose.facing) * player.velocity.z) / speed, -1, 1) : 0;
    const direction = speed > 0.1 && Math.cos(pose.facing) * player.velocity.x + Math.sin(pose.facing) * player.velocity.z < -0.2 ? -1 : 1;
    stride += dt * Math.PI * (1.25 + speed * 0.69);
    screen = lerp(screen, Number(player.pose === 'screen'), fast);
    contest = lerp(contest, Number(contesting), fast);
    gather = lerp(gather, charge > 0 ? 0.48 + clamp(charge / 0.68, 0, 1) * 0.48 : 0, fast);
    dribble = lerp(dribble, Number(Boolean(held)), fast);
    slide = lerp(slide, Number(player.pose === 'slide'), fast);
    pumpFake = lerp(pumpFake, Number(player.pose === 'pumpFake'), fast);
    const age = event ? (tick - event.tick) / TICK_RATE : Infinity;
    stealSwipe = lerp(stealSwipe, Number(player.pose === 'steal' || (event?.type === 'steal' && age < 0.32)), fast);

    const shot = event?.type === 'shot' && age < 0.53 ? clamp(1 - Math.max(0, age - 0.2) / 0.33, 0, 1) : 0;
    const dunk = shot > 0 && event?.detail?.startsWith('Dunk');
    const hookShot = shot > 0 && event?.detail?.startsWith('Hook');
    const highFinish = dunk || (shot > 0 && /^(Layup|Hook|Floater|Alley-oop)/.test(event?.detail ?? ''));
    const fade = shot > 0 && event?.detail?.startsWith('Fadeaway');
    const passing = event?.type === 'pass' && age < 0.36 ? Math.sin((age + 0.07) / 0.43 * Math.PI) : 0;
    const contestAge = lastContest < 0 ? Infinity : (tick - lastContest) / TICK_RATE;
    const jumpArc = (t: number, duration: number) => t < duration ? Math.sin(Math.PI * (t + 0.035) / (duration + 0.035)) : 0;
    const gatherJump = charge > 0 ? clamp((charge - 0.20) / 0.42, 0, 1) * 0.30 : 0;
    const lateGather = charge > 0 ? clamp((charge - 0.34) / 0.28, 0, 1) : 0;
    const jump = Math.max(gatherJump, shot ? jumpArc(age, 0.53) * (dunk ? 0.62 : 0.31) : 0, jumpArc(contestAge, 0.48) * 0.34,
      event?.type === 'rebound' || event?.type === 'block' ? jumpArc(age, 0.42) * 0.26 : 0);
    const defense = Math.max(contest, event?.type === 'rebound' || event?.type === 'block' ? jumpArc(age, 0.45) : 0);
    const run = movement * (1 - jump * 0.92) * (1 - screen * 0.84);
    const gatherDip = charge > 0 ? clamp(1 - Math.max(0, charge - 0.22) / 0.16, 0, 1) : 0;
    const crouch = movement * 0.09 + screen * 0.12 + gather * (1 - shot) * gatherDip * 0.14 + slide * 0.10 + pumpFake * 0.14;
    pose.rise = jump + (0.008 + (1 - Math.cos(stride * 2)) * 0.023) * run;
    pose.crouch = crouch;
    pose.tilt = run * 0.15 + screen * 0.12 + gather * 0.08 + stealSwipe * 0.28 - (fade ? shot * 0.36 : 0);
    pose.roll = -lateral * run * 0.11 + Math.sin(stride) * run * 0.035;
    pose.twist = Math.sin(stride) * 0.1 * run + stealSwipe * 0.35 + (highFinish ? shot * 0.19 : 0);

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? -1 : 1;
      const step = stride + i * Math.PI;
      const swing = Math.sin(step) * run * 0.46;
      const lift = Math.max(0, Math.cos(step)) ** 1.5 * run * 0.26;
      const spacing = thickness * 0.143 + screen * 0.16 + slide * 0.15;
      const leg = legs[i];
      change(leg.start, sign * 0.121 * thickness, 1.085 - crouch * 0.88, 0);
      change(leg.joint, sign * (spacing + 0.007) + swing * lateral * 0.25, 0.545 + lift * 0.43 - crouch * 0.52,
        0.077 + swing * direction * 0.62 + crouch * 0.72);
      change(leg.end, sign * spacing + swing * lateral * 0.48, 0.105 + lift + jump * (sign === 1 ? 0.14 : 0.34),
        swing * direction * (1 - Math.abs(lateral) * 0.54) - jump * (sign === 1 ? -0.2 : 0.46));
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
      if (held) {
        const dx = held.x - player.position.x;
        const dz = held.z - player.position.z;
        const side = (Math.sin(pose.facing) * dx - Math.cos(pose.facing) * dz) / scale;
        const front = (Math.cos(pose.facing) * dx + Math.sin(pose.facing) * dz) / scale;
        if (sign * side > 0 || (Math.abs(side) < 0.025 && sign === 1)) {
          const reach = clamp((held.y - pose.rise) / scale + 0.15, 0.87, 1.49);
          blend(arm.joint, sign * 0.286, 1.32 - crouch, Math.max(0.035, front * 0.61), dribble);
          blend(arm.end, clamp(side, -0.54, 0.54), reach, clamp(front, -0.31, 0.58), dribble);
        } else {
          blend(arm.joint, sign * 0.348, 1.379 - crouch, 0.09, dribble * 0.81);
          blend(arm.end, sign * 0.404, 1.33 - crouch, 0.293, dribble * 0.81);
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
      if (i === 1) {
        blend(arm.joint, 0.24, 1.46 - crouch, 0.34, stealSwipe);
        blend(arm.end, 0.12, 1.32 - crouch, 0.68, stealSwipe);
      } else {
        blend(arm.joint, -0.34, 1.35 - crouch, -0.14, stealSwipe);
        blend(arm.end, -0.40, 1.24 - crouch, -0.22, stealSwipe);
      }
      blend(arm.joint, sign * 0.196, 1.40 - crouch, 0.34, passing);
      blend(arm.end, sign * 0.135, 1.47 - crouch, 0.65, passing);
      const hookOffset = hookShot && i === 1 ? 0.24 : 0;
      blend(arm.joint, sign * (highFinish ? 0.32 : 0.217) + hookOffset, i === 0 && highFinish ? 1.5 : 1.875, 0.2, shot);
      blend(arm.end, sign * (highFinish ? 0.31 : 0.131) + hookOffset, highFinish ? (i === 1 ? (dunk ? 2.34 : 2.26) : 1.53) : (i === 1 ? 2.15 : 1.99),
        0.22 + Math.min(age, 0.4) * 0.43, shot);
      arm.pitch = -shot * 0.84 - passing * 0.86;
    }
    return pose;
  };
}
