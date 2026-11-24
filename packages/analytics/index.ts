import type { GameEvent, GameState } from '../contracts/index.ts';

export type PlayerBox = {
  id: string; name: string; side: 0 | 1; points: number; makes: number; attempts: number; threeMakes: number;
  threeAttempts: number; freeThrows: number; freeThrowAttempts: number; assists: number; rebounds: number;
  steals: number; blocks: number; turnovers: number; effectiveFieldGoal: number | null; trueShooting: number | null;
};
export function summarizeGame(state: GameState) {
  const ledger = new Map<string, PlayerBox>(state.teams.flatMap((team, index) => team.roster.map(player => [player.id, {
    id: player.id, name: player.name, side: index as 0 | 1, points: 0, makes: 0, attempts: 0, threeMakes: 0, threeAttempts: 0,
    freeThrows: 0, freeThrowAttempts: 0, assists: 0, rebounds: 0, steals: 0, blocks: 0, turnovers: 0, effectiveFieldGoal: null, trueShooting: null,
  }])));
  const blacktop = state.config.mode === 'blacktop';
  const inside = blacktop ? (state.config.scoring?.inside ?? 1) : 2;
  const longRange = blacktop ? (state.config.scoring?.outside ?? 2) : 3;
  const shots: { event: GameEvent; made: boolean }[] = [];
  const pending = new Map<string, number>();
  for (const event of state.events) {
    if (!event.playerId) continue;
    const player = ledger.get(event.playerId);
    if (!player) continue;
    if (event.type === 'shot') {
      if (event.detail === 'Free throw' || (!blacktop && event.points === 1)) player.freeThrowAttempts++;
      else player.attempts++;
      if (event.points === longRange) player.threeAttempts++;
      if (event.position) {
        shots.push({ event, made: false });
        pending.set(player.id, shots.length - 1);
      }
    }
    if (event.type === 'score') {
      const points = event.points ?? 2;
      player.points += points;
      if (event.detail === 'Free throw' || (!blacktop && points === 1)) player.freeThrows++;
      else player.makes++;
      if (points === longRange) player.threeMakes++;
      const index = pending.get(player.id);
      if (index !== undefined) shots[index].made = true;
      pending.delete(player.id);
    }
    if (event.type === 'miss' || event.type === 'block') pending.delete(player.id);
    if (event.type === 'assist') player.assists++;
    if (event.type === 'rebound') player.rebounds++;
    if (event.type === 'steal') player.steals++;
    if (event.type === 'block') player.blocks++;
    if (event.type === 'turnover') player.turnovers++;
  }
  for (const player of ledger.values()) {
    player.effectiveFieldGoal = player.attempts ? (player.points - player.freeThrows) / (inside * player.attempts) : null;
    const attempts = player.attempts + 0.44 * player.freeThrowAttempts;
    player.trueShooting = attempts ? player.points / (inside * attempts) : null;
  }
  return { players: [...ledger.values()].sort((a, b) => b.points - a.points), shots };
}
