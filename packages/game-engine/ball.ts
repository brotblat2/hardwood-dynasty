import { COURT } from '../contracts/index.ts';
import type { Ball, Vec3 } from '../contracts/index.ts';

export type PhysicalBall = Ball & { spin?: Vec3; dribbleHand?: -1 | 1 };
export const GRAVITY = 9.81;
export const BALL_RADIUS = 0.122;
const RING_RADIUS = 0.235;
const RING_TUBE = 0.021;
export const RIM_CLEARANCE = RING_RADIUS - RING_TUBE - BALL_RADIUS;
export const BOARD_OFFSET = 0.39;
export const BOARD_HALF_DEPTH = 0.0275;
export const BOARD_HALF_WIDTH = 0.91;
export const BOARD_BOTTOM = COURT.rimHeight - 0.0675;
export const BOARD_TOP = COURT.rimHeight + 0.9875;
export const FLOOR_RESTITUTION = 0.72;
export const BOARD_RESTITUTION = 0.69;
const INERTIA = 2 / 3; // A basketball's mass is concentrated in its shell.
const EPSILON = 0.0001;

type Surface = 'floor' | 'rim' | 'board';
type Contact = { fraction: number; normal: Vec3; surface: Surface; penetration: number };
type Sample = { distance: number; normal: Vec3 };
type Point = (fraction: number) => Vec3;

export function vector(x: number, y: number, z: number): Vec3 { return { x, y, z }; }
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const magnitude = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const scale = (v: Vec3, a: number) => vector(v.x * a, v.y * a, v.z * a);
const add = (a: Vec3, b: Vec3) => vector(a.x + b.x, a.y + b.y, a.z + b.z);
const cross = (a: Vec3, b: Vec3) => vector(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function velocityFor(start: Vec3, end: Vec3, time: number) {
  return vector((end.x - start.x) / time, (end.y - start.y) / time + GRAVITY * time / 2, (end.z - start.z) / time);
}

export function bankVelocityFor(start: Vec3, end: Vec3, boardFaceX: number, duration: number): { velocity: Vec3; glassPoint: Vec3 } | null {
  const dx1 = boardFaceX - start.x;
  const dx2 = boardFaceX - end.x;
  const d1 = Math.abs(dx1);
  const d2 = Math.abs(dx2);
  if (d1 < 0.25 || dx1 * dx2 <= 0) return null;
  const t1 = duration / (1 + d2 / (BOARD_RESTITUTION * d1));
  const t2 = duration - t1;
  const vx = dx1 / t1;
  const vz = (end.z - start.z) / (t1 + 0.88 * t2);
  const vy = (end.y - start.y + 0.5 * GRAVITY * duration * duration) / duration + 0.16;
  const glassPoint = vector(boardFaceX, start.y + vy * t1 - 0.5 * GRAVITY * t1 * t1, start.z + vz * t1);
  if (glassPoint.y < COURT.rimHeight + 0.24 || glassPoint.y > BOARD_TOP - 0.10 || Math.abs(glassPoint.z) > BOARD_HALF_WIDTH - 0.14) {
    return null;
  }
  return { velocity: vector(vx, vy, vz), glassPoint };
}

export function bouncePassVelocity(start: Vec3, end: Vec3, duration: number): { velocity: Vec3; floorTime: number } {
  const f = 0.58;
  const floorTime = duration * f;
  const horizComp = 1 / (f + (1 - f) * 0.86);
  const vx = (end.x - start.x) / duration * horizComp;
  const vz = (end.z - start.z) / duration * horizComp;
  const vy = (BALL_RADIUS - start.y) / floorTime + 0.5 * GRAVITY * floorTime;
  return { velocity: vector(vx, vy, vz), floorTime };
}

function rimDistance(p: Vec3, rimX: number): Sample {
  const dx = p.x - rimX;
  const radius = Math.hypot(dx, p.z);
  const nearestX = rimX + (radius ? dx * RING_RADIUS / radius : RING_RADIUS);
  const nearestZ = radius ? p.z * RING_RADIUS / radius : 0;
  const offset = vector(p.x - nearestX, p.y - COURT.rimHeight, p.z - nearestZ);
  const length = magnitude(offset);
  return { distance: length - RING_TUBE - BALL_RADIUS, normal: length ? scale(offset, 1 / length) : vector(0, 1, 0) };
}

function boardDistance(p: Vec3, boardX: number): Sample {
  const minX = boardX - BOARD_HALF_DEPTH, maxX = boardX + BOARD_HALF_DEPTH;
  const offset = vector(p.x - clamp(p.x, minX, maxX), p.y - clamp(p.y, BOARD_BOTTOM, BOARD_TOP),
    p.z - clamp(p.z, -BOARD_HALF_WIDTH, BOARD_HALF_WIDTH));
  const length = magnitude(offset);
  if (length > 0) return { distance: length - BALL_RADIUS, normal: scale(offset, 1 / length) };

  // Center already inside the glass, as can happen when restoring an older save.
  const faces = [
    { distance: p.x - minX, normal: vector(-1, 0, 0) },
    { distance: maxX - p.x, normal: vector(1, 0, 0) },
    { distance: p.y - BOARD_BOTTOM, normal: vector(0, -1, 0) },
    { distance: BOARD_TOP - p.y, normal: vector(0, 1, 0) },
    { distance: p.z + BOARD_HALF_WIDTH, normal: vector(0, 0, -1) },
    { distance: BOARD_HALF_WIDTH - p.z, normal: vector(0, 0, 1) },
  ];
  const nearest = faces.reduce((a, b) => a.distance < b.distance ? a : b);
  return { distance: -nearest.distance - BALL_RADIUS, normal: nearest.normal };
}

// A signed distance is a lower bound on the distance that can be traveled safely.
// March it along the swept center so even a fast ball can hit a thin rim or glass edge.
function sweep(point: Point, length: number, sample: (p: Vec3) => Sample, surface: Surface): Contact | undefined {
  let fraction = 0;
  for (let i = 0; i < 32; i++) {
    const { distance, normal } = sample(point(fraction));
    if (distance <= EPSILON) return { fraction, normal, surface, penetration: Math.max(0, -distance) };
    fraction += distance / length;
    if (fraction > 1) return;
  }
}

function firstContact(start: Vec3, end: Vec3, halfCourt: boolean) {
  const delta = vector(end.x - start.x, end.y - start.y, end.z - start.z);
  let nearest: Contact | undefined;
  if (end.y <= BALL_RADIUS && end.y < start.y) {
    nearest = { fraction: clamp((BALL_RADIUS - start.y) / delta.y, 0, 1), normal: vector(0, 1, 0), surface: 'floor', penetration: Math.max(0, BALL_RADIUS - start.y) };
  }
  if (Math.max(start.y, end.y) < BOARD_BOTTOM - BALL_RADIUS || Math.min(start.y, end.y) > BOARD_TOP + BALL_RADIUS ||
    Math.min(start.z, end.z) > BOARD_HALF_WIDTH + BALL_RADIUS || Math.max(start.z, end.z) < -BOARD_HALF_WIDTH - BALL_RADIUS) return nearest;
  const length = magnitude(delta);
  if (length < EPSILON) return nearest;
  const point = (t: number) => add(start, scale(delta, t));
  for (const sign of halfCourt ? [1] : [-1, 1]) {
    const insideX = Math.min(start.x * sign, end.x * sign);
    const outsideX = Math.max(start.x * sign, end.x * sign);
    const rimX = sign * COURT.rimX;
    if (outsideX < COURT.rimX - RING_RADIUS - RING_TUBE - BALL_RADIUS || insideX > COURT.rimX + BOARD_OFFSET + BOARD_HALF_DEPTH + BALL_RADIUS) continue;
    const rim = sweep(point, length, p => rimDistance(p, rimX), 'rim');
    if (rim && (!nearest || rim.fraction < nearest.fraction)) nearest = rim;
    const board = sweep(point, length, p => boardDistance(p, rimX + sign * BOARD_OFFSET), 'board');
    if (board && (!nearest || board.fraction < nearest.fraction)) nearest = board;
  }
  return nearest;
}

function bounce(ball: PhysicalBall, hit: Contact) {
  const normalSpeed = dot(ball.velocity, hit.normal);
  if (normalSpeed >= 0) return;
  const floor = hit.surface === 'floor';
  const restitution = floor ? (normalSpeed > -0.45 ? 0 : FLOOR_RESTITUTION) : hit.surface === 'rim' ? 0.64 : BOARD_RESTITUTION;
  const friction = floor ? 0.42 : hit.surface === 'rim' ? 0.14 : 0.18;
  const normalImpulse = -(1 + restitution) * normalSpeed;
  const contactArm = scale(hit.normal, -BALL_RADIUS);
  const tangentSpeed = add(add(ball.velocity, scale(hit.normal, -normalSpeed)), cross(ball.spin!, contactArm));
  const slip = magnitude(tangentSpeed);
  const tangentImpulse = scale(tangentSpeed, slip ? -Math.min(1 / (1 + 1 / INERTIA), friction * normalImpulse / slip) : 0);
  ball.velocity = add(add(ball.velocity, scale(hit.normal, normalImpulse)), tangentImpulse);
  ball.spin = add(ball.spin!, scale(cross(contactArm, tangentImpulse), 1 / (INERTIA * BALL_RADIUS ** 2)));
}

export function advanceBall(ball: PhysicalBall, time: number, halfCourt: boolean,
  onSegment?: (start: Vec3, end: Vec3) => void, onImpact?: (surface: Surface) => void) {
  ball.spin ??= vector(0, 0, 0);
  let remaining = time;
  for (let i = 0; i < 8 && remaining > 1e-7; i++) {
    const start = ball.position;
    if (start.y <= BALL_RADIUS + 3 * EPSILON && Math.abs(ball.velocity.y) < 0.45) {
      const damping = Math.exp(-1.9 * remaining);
      ball.position = vector(start.x + ball.velocity.x * remaining, BALL_RADIUS, start.z + ball.velocity.z * remaining);
      ball.velocity = vector(ball.velocity.x * damping, 0, ball.velocity.z * damping);
      ball.spin = vector(ball.velocity.z / BALL_RADIUS, ball.spin.y * damping, -ball.velocity.x / BALL_RADIUS);
      return;
    }
    const end = vector(start.x + ball.velocity.x * remaining, start.y + ball.velocity.y * remaining - GRAVITY * remaining ** 2 / 2,
      start.z + ball.velocity.z * remaining);
    const hit = firstContact(start, end, halfCourt);
    const elapsed = remaining * (hit?.fraction ?? 1);
    ball.position = vector(start.x + ball.velocity.x * elapsed, start.y + ball.velocity.y * elapsed - GRAVITY * elapsed ** 2 / 2,
      start.z + ball.velocity.z * elapsed);
    ball.velocity.y -= GRAVITY * elapsed;
    ball.spin = scale(ball.spin, Math.exp(-0.36 * elapsed));
    onSegment?.(start, ball.position);
    if (!hit) return;
    const approaching = dot(ball.velocity, hit.normal) < 0;
    bounce(ball, hit);
    ball.position = add(ball.position, scale(hit.normal, 4 * EPSILON + hit.penetration));
    if (approaching) onImpact?.(hit.surface);
    remaining -= elapsed;
  }
}
