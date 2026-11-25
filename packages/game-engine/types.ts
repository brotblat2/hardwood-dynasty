import { COURT, TICK_RATE } from '../contracts/index.ts';
import type {
  Ball, BallState, BodyUpKind, Control, DribbleMove, GameState,
  PassType, ShotType, Side, Vec2, Vec3,
} from '../contracts/index.ts';

export const DT = 1 / TICK_RATE;
export const IDEAL_RELEASE = 0.62;
export const MAX_CHARGE = 1.2;
export const LIMIT_X = COURT.length / 2 - 0.32;
export const LIMIT_Z = COURT.width / 2 - 0.32;
export const INPUT_BUFFER_TICKS = 9; // 150 ms at 60 Hz

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const opposite = (s: Side): Side => (s === 0 ? 1 : 0);

/** Wrap angle into [-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Signed shortest angular distance from `from` to `to` in radians. */
export function angleDiff(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export type PhysicalBall = Ball & { spin?: Vec3; dribbleHand?: -1 | 1 };

export type PlayerBody = {
  height: number;
  mass: number;
  wingspan: number;
  reach: number;
  leverage: number;
  acceleration: number;
  turnRate: number;
  brakeRate: number;
};

export type ActiveMove = {
  type: DribbleMove;
  started: number;
  duration: number;
  fromHand: -1 | 1;
  toHand: -1 | 1;
  dir: -1 | 1;
  cancelAfter: number;
  launchAt: number;
  peakSpeed: number;
};

export type DribbleRuntime = {
  ownerId: string;
  hand: -1 | 1;
  phase: number;
  lastTick: number;
  held: boolean;
  ballState: BallState;
  adrenaline: number;
  comboCount: number;
  lastMoveTick: number;
  lastMoveType?: DribbleMove;
  clampHits: number;
  clampWindowUntil: number;
  protectBall?: boolean;
  lastBallPos?: Vec3;
  bobbleTicks?: number;
  move?: ActiveMove;
  crossover?: { traveled: number; floorAt: number };
};

export type MoveSpec = {
  type: DribbleMove;
  dir: -1 | 1;
  toHand: -1 | 1;
  duration: number;
  cancelAfter: number;
  launchAt: number;
  staminaCost: number;
  impulse: Vec2;
};

export type GatherState = {
  ownerId: string;
  height: number;
  handOffset: number;
  approach: number;
  sprint: boolean;
  backward: boolean;
  driving?: boolean;
  idealRelease?: number;
  style?: ShotType;
  rhythm?: boolean;
};

export type BaseFlight = { from: string; age: number };
export type ShotFlight = BaseFlight & {
  kind: 'shot';
  points: number;
  throughRim?: boolean;
  andOne?: boolean;
  fouled?: boolean;
};
export type PassFlight = BaseFlight & {
  kind: 'pass';
  target: string;
  duration: number;
  bounce: boolean;
  lob: boolean;
  flashy?: boolean;
  alleyOop?: boolean;
  floorTime?: number;
  disguise?: number;
  telegraphed?: number;
};
export type Flight = ShotFlight | PassFlight;
export type LegacyFlight = BaseFlight & {
  kind?: undefined;
  points: number;
  target?: string;
  duration: number;
  bounce: boolean;
};

export type BufferedActionKind = 'dribble' | 'pass' | 'pumpFake' | 'shoot';

export type BufferedActionEntry = {
  kind: BufferedActionKind;
  tick: number;
  expires: number;
  dir?: Vec2;
  targetId?: string;
  passType?: Control['passType'];
};

export type InputBufferState = {
  prevDribble?: boolean;
  prevPass?: boolean;
  prevPumpFake?: boolean;
  prevShoot?: boolean;
  queue: BufferedActionEntry[];
};

export type Runtime = {
  free?: { shooter: string; remaining: number; total?: number; startTick: number; waiting: boolean; andOne?: boolean };
  resumeClock?: number;
  timeouts?: [number, number];
  crossed?: boolean;
  backcourtTicks?: number;
  seed: number;
  flight: Flight | null;
  lastPass: { from: string; to: string; tick: number } | null;
  locks: Record<string, number>;
  deadUntil: number;
  inbound: Side;
  rimTouched: boolean;
  pendingRebound?: boolean;
  deadBallMotion?: boolean;
  dribble?: DribbleRuntime;
  gather?: GatherState;
  release?: { playerId: string; until: number };
  releaseStyle?: { playerId: string; style: ShotType; until: number; peakJump: number };
  passStyle?: { playerId: string; style: PassType; until: number };
  teamFouls?: [number, number];
  burst?: Record<string, number>;
  stun?: Record<string, number>;
  stumble?: Record<string, number>;
  flyBy?: Record<string, number>;
  jumpContest?: Record<string, number>;
  jumpContestStart?: Record<string, number>;
  handsUp?: Record<string, boolean>;
  pumpFake?: Record<string, number>;
  stealPose?: Record<string, number>;
  stealLunge?: Record<string, number>;
  stealHistory?: Record<string, { count: number; lastTick: number }>;
  lastDribble?: Record<string, number>;
  lastSprintTick?: Record<string, number>;
  contestHeld?: Record<string, boolean>;
  intenseD?: Record<string, boolean>;
  postUp?: Record<string, boolean>;
  bodyUp?: Record<string, BodyUpKind>;
  boxOut?: Record<string, string>;
  lastLooseTouch?: Side;
  prevMoveDir?: Record<string, Vec2>;
  prevVel?: Record<string, Vec2>;
  plantCut?: Record<string, number>;
  turnCarry?: Record<string, number>;
  streaks?: Record<string, number>;
  pendingAndOne?: { shooter: string; points: number };
  inputBuffer?: Record<string, InputBufferState>;
};

export type Snapshot = GameState & { ball: PhysicalBall; simulation: Runtime };
