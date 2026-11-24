export type Side = 0 | 1;
export type Vec2 = { x: number; z: number };
export type Vec3 = Vec2 & { y: number };
export type Position = 'PG' | 'SG' | 'SF' | 'PF' | 'C';
export type Difficulty = 'Rookie' | 'Pro' | 'All-Star' | 'Superstar' | 'Hall of Fame' | 'Legendary';
export type Ratings = {
  shooting: number; finishing: number; passing: number; handling: number;
  rebounding: number; speed: number; perimeter: number; interior: number; iq: number; durability: number; strength?: number;
};
export type Hairstyle = 'shaved' | 'buzz' | 'fade' | 'taper' | 'curls' | 'afro' | 'braids' | 'locs' | 'medium' | 'long';
export type FacialHair = 'none' | 'stubble' | 'goatee' | 'beard' | 'fullBeard';
export type SleeveSide = 'none' | 'left' | 'right' | 'both';
export type JerseyKit = 'home' | 'away' | 'statement' | 'city';
export type JerseyPattern = 'classic' | 'sidePanel' | 'pinstripe' | 'sash' | 'chevron' | 'hoopBand' | 'sunburst' | 'herringbone';
export type PlayerAppearance = {
  portraitUrl?: string; skinTone?: string; hairTone?: string; hairstyle?: Hairstyle;
  facialHair?: FacialHair; headband?: boolean; armSleeve?: SleeveSide; legSleeve?: SleeveSide; shoeColor?: string;
};
export type Player = {
  id: string; name: string; number: number; position: Position; height: number; weight?: number; wingspan?: number; age: number;
  appearance?: PlayerAppearance;
  overall: number; potential: number; gradeEvidence?: 'established' | 'limited' | 'estimated'; ratings: Ratings; salary?: number; years?: number;
};
export type Team = {
  id: string; city: string; name: string; abbreviation: string; color: string; accent: string;
  tertiaryColor?: string; jerseyPattern?: JerseyPattern;
  conference: 'East' | 'West'; roster: Player[];
};
export type OffensePlay = 'motion' | 'pickAndRoll' | 'iso' | 'fiveOut';
export type DefenseScheme = 'man' | 'zone23' | 'switch' | 'press';
export type ShotType = 'jump' | 'layup' | 'dunk' | 'floater' | 'hook' | 'fadeaway' | 'stepBack' | 'euro';
export type DribbleMove = 'crossover' | 'betweenLegs' | 'behindBack' | 'hesitation' | 'spin' | 'stepBack' | 'inAndOut' | 'jab';
export type BallState = 'tripleThreat' | 'live' | 'dead';
export type BodyUpKind = 'clamp' | 'ride' | 'blowby';
export type PlayerAction = {
  dribbleMove?: DribbleMove;
  moveProgress?: number;
  moveDir?: -1 | 1;
  ballState?: BallState;
  adrenaline?: number;
  bodyUp?: BodyUpKind;
  intenseD?: boolean;
  stumble?: number;
  flyBy?: number;
  shotStyle?: ShotType;
  jumpHeight?: number;
  gatherPhase?: number;
  deadDribble?: boolean;
  postUp?: boolean;
  hotStreak?: number;
};
export type ShotTimingGrade = 'Green' | 'Excellent' | 'Slightly Early' | 'Slightly Late' | 'Early' | 'Late';
export type ContestLevel = 'Open' | 'Light' | 'Tight' | 'Smothered';
export type ShotFeedback = {
  playerId: string; tick: number; timing: ShotTimingGrade; contest: ContestLevel;
  style: string; grade: number; green?: boolean; bank?: boolean;
  contestPct?: number; rhythm?: boolean; greenWindow?: number;
};
export type GameCallout = {
  tick: number; text: string; tone: 'gold' | 'green' | 'blue' | 'red'; playerId?: string;
};
export type FreeThrowState = { shooterId: string; remaining: number; total: number; andOne?: boolean };
export type Control = {
  move: Vec2; sprint?: boolean; shoot?: boolean; pass?: boolean; targetId?: string;
  passType?: 'chest' | 'bounce' | 'lob'; contest?: boolean; steal?: boolean;
  screen?: boolean; dribble?: boolean; timeout?: boolean; substituteId?: string;
  shotType?: ShotType;
  pumpFake?: boolean; callScreen?: boolean; callPass?: boolean;
  intenseD?: boolean; postUp?: boolean; dribbleDir?: Vec2;
  offensePlay?: OffensePlay; defenseScheme?: DefenseScheme;
};
export type GamePlayer = {
  id: string; side: Side; profile: Player; position: Vec2; velocity: Vec2; facing: number;
  stamina: number; pose: 'idle' | 'run' | 'dribble' | 'shoot' | 'contest' | 'screen' | 'pumpFake' | 'steal' | 'slide' | 'stumble' | 'bodyUp' | 'flyBy' | 'postUp';
  action?: PlayerAction;
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
  kits?: [JerseyKit, JerseyKit];
};
export type GameState = {
  tick: number; teams: [Team, Team]; players: GamePlayer[]; ball: Ball; score: [number, number];
  period: number; clock: number; shotClock: number; possession: Side;
  phase: 'live' | 'dead' | 'final'; events: GameEvent[];
  config: GameConfig; charge: Record<string, number>;
  teamFouls?: [number, number]; freeThrow?: FreeThrowState | null; shotFeedback?: ShotFeedback | null;
  callout?: GameCallout | null;
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
