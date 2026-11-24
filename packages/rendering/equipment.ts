import { COURT, TICK_RATE, attackSign } from '../contracts/index.ts';
import type { GameState } from '../contracts/index.ts';

export function netResponse(state: GameState, side: number) {
  const { ball } = state;
  const sideRim = side * COURT.rimX;
  const near = ball.ownerId === null && Math.abs(ball.position.x - sideRim) < 0.31 && Math.abs(ball.position.z) < 0.3 && Math.abs(ball.position.y - COURT.rimHeight + 0.22) < 0.44;
  const result = { x: 0, z: 0, drop: near && ball.velocity.y < 0 ? 0.045 : 0, flare: near ? 0.023 : 0 };
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i];
    const age = (state.tick - event.tick) / TICK_RATE;
    if (age > 0.73) break;
    if ((event.type !== 'score' && event.type !== 'miss') || (state.config.halfCourt ? 1 : attackSign(event.side)) !== side) continue;
    const made = event.type === 'score';
    const decay = Math.exp(-age * (made ? 5.7 : 8.5));
    result.x = Math.sin(age * 21 + 0.57) * decay * (made ? 0.122 : 0.039) * side;
    result.z = Math.sin(age * 25 + 1.2) * decay * (made ? 0.079 : 0.028);
    result.drop += Math.cos(age * 17) * decay * (made ? 0.15 : 0.014);
    result.flare += Math.sin(age * 17 + 1.05) * decay * (made ? 0.071 : 0.022);
    break;
  }
  return result;
}
