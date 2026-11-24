export type Side = 0 | 1;
export type Vec2 = { x: number; z: number };
export type Vec3 = Vec2 & { y: number };
export type Position = 'PG' | 'SG' | 'SF' | 'PF' | 'C';
export type Difficulty = 'Rookie' | 'Pro' | 'All-Star' | 'Superstar' | 'Hall of Fame' | 'Legendary';
export type Ratings = {
  shooting: number; finishing: number; passing: number; handling: number;
  rebounding: number; speed: number; perimeter: number; interior: number; iq: number; durability: number; strength?: number;
};
export type Player = {
  id: string; name: string; number: number; position: Position; height: number; weight?: number; wingspan?: number; age: number;
  appearance?: { portraitUrl?: string; skinTone?: string; hairTone?: string; hairstyle?: 'buzz' | 'fade' | 'curls' | 'braids' | 'shaved' };
  overall: number; potential: number; gradeEvidence?: 'established' | 'limited' | 'estimated'; ratings: Ratings; salary?: number; years?: number;
};
export type Team = {
  id: string; city: string; name: string; abbreviation: string; color: string; accent: string;
  conference: 'East' | 'West'; roster: Player[];
};
export type OffensePlay = 'motion' | 'pickAndRoll' | 'iso' | 'fiveOut';
export type DefenseScheme = 'man' | 'zone23' | 'switch' | 'press';
export type ShotTimingGrade = 'Green' | 'Excellent' | 'Slightly Early' | 'Slightly Late' | 'Early' | 'Late';
export type ContestLevel = 'Open' | 'Light' | 'Tight' | 'Smothered';
export type ShotFeedback = {
  playerId: string; tick: number; timing: ShotTimingGrade; contest: ContestLevel;
  style: string; grade: number; green?: boolean; bank?: boolean;
};
export type FreeThrowState = { shooterId: string; remaining: number; total: number; andOne?: boolean };
export type Control = {
  move: Vec2; sprint?: boolean; shoot?: boolean; pass?: boolean; targetId?: string;
  passType?: 'chest' | 'bounce' | 'lob'; contest?: boolean; steal?: boolean;
  screen?: boolean; dribble?: boolean; timeout?: boolean; substituteId?: string;
  shotType?: 'jump' | 'layup' | 'dunk' | 'floater' | 'hook' | 'fadeaway';
  pumpFake?: boolean; callScreen?: boolean; callPass?: boolean;
  offensePlay?: OffensePlay; defenseScheme?: DefenseScheme;
};
export type GamePlayer = {
  id: string; side: Side; profile: Player; position: Vec2; velocity: Vec2; facing: number;
  stamina: number; pose: 'idle' | 'run' | 'dribble' | 'shoot' | 'contest' | 'screen' | 'pumpFake' | 'steal' | 'slide';
};
export type Ball = {
  position: Vec3; velocity: Vec3; ownerId: string | null;
  kind: 'held' | 'loose' | 'pass' | 'shot'; spin?: Vec3; dribbleHand?: -1 | 1;
};
export type GameEvent = {
  tick: number; type: 'shot' | 'score' | 'miss' | 'pass' | 'assist' | 'steal' | 'block' | 'rebound' | 'turnover' | 'foul' | 'period' | 'timeout' | 'substitution';
  side: Side; playerId?: string; points?: number; position?: Vec2; detail?: string;
};
export type GameConfig = {
  mode?: 'regulation' | 'blacktop' | 'practice'; periodSeconds?: number; periods?: number;
  playersPerTeam?: number; targetScore?: number; halfCourt?: boolean; makeItTakeIt?: boolean;
  difficulty?: Difficulty; seed?: number; scoring?: { inside: number; outside: number };
};
export type GameState = {
  tick: number; teams: [Team, Team]; players: GamePlayer[]; ball: Ball; score: [number, number];
  period: number; clock: number; shotClock: number; possession: Side;
  phase: 'live' | 'dead' | 'final'; events: GameEvent[];
  config: GameConfig; charge: Record<string, number>;
  teamFouls?: [number, number]; freeThrow?: FreeThrowState | null; shotFeedback?: ShotFeedback | null;
  offensePlay?: [OffensePlay, OffensePlay]; defenseScheme?: [DefenseScheme, DefenseScheme];
};
export interface Engine {
  readonly state: GameState;
  step(controls?: Readonly<Record<string, Control>>): GameState;
}
export const TICK_RATE = 60;
export const COURT = { length: 28.65, width: 15.24, rimHeight: 3.05, rimX: 12.65, three: 7.24 };
export const attackSign = (side: Side) => side === 0 ? 1 : -1;
export const zeroControl = (): Control => ({ move: { x: 0, z: 0 } });

export type SaveEnvelope<T> = { version: 1; savedAt: string; data: T };
export type RoomInfo = { code: string; slot: Side; token: string; ready: boolean };
export type RoomConfig = { teams: [Team, Team]; game?: GameConfig };
export type ClientMessage =
  | { type: 'create'; config: RoomConfig }
  | { type: 'join'; code: string; config?: RoomConfig }
  | { type: 'resume'; code: string; token: string }
  | { type: 'input'; seq: number; playerId: string; control: Control };
export type ServerMessage =
  | { type: 'room'; room: RoomInfo }
  | { type: 'state'; state: GameState; ack: number; ready: boolean }
  | { type: 'error'; message: string };
