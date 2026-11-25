import type { Engine, GameConfig, GameState, Team } from '../contracts/index.ts';
import { createSimulationEngine } from './simulation.ts';

export { IDEAL_RELEASE, MAX_CHARGE } from './types.ts';
export { selectPassTarget } from './passing.ts';
export { computeGreenWindow, idealReleaseFor } from './shooting.ts';
export { captureFrame, interpolateState } from './interpolate.ts';
export type { PrevFrame, PrevPlayerFrame } from './interpolate.ts';

export function createEngine(teams: [Team, Team], config: GameConfig = {}, initialState?: GameState): Engine {
  return createSimulationEngine(teams, config, initialState);
}
