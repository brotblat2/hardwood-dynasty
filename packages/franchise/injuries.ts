import type { Team } from '../contracts/index.ts';
import type { FranchiseState, ScheduledGame } from './index.ts';
import { hash, seededRandom } from './schedule.ts';
import { getRotation } from './statistics.ts';
import type { GameBoxScore } from './statistics.ts';

export type Injury = { playerId: string; name: string; description: string; day: number; returnDay: number };

export function getInjuryReport(state: FranchiseState, teamId?: string): Injury[] {
  const currentPlayers = teamId ? new Set(state.teams.find(({ id }) => id === teamId)?.roster.map(({ id }) => id) ?? []) : undefined;
  return Object.values(state.injuries ?? {}).filter((injury) => injury.returnDay > state.day &&
    (!currentPlayers || currentPlayers.has(injury.playerId))).sort((a, b) => a.returnDay - b.returnDay);
}

export function getTeamForGame(state: FranchiseState, teamId: string): Team {
  const team = state.teams.find(({ id }) => id === teamId);
  if (!team) throw new Error('Team is unavailable.');
  const injuries = getInjuryReport(state, teamId);
  const injuredIds = new Set(injuries.map(({ playerId }) => playerId));
  const roster = team.roster.filter(({ id }) => !injuredIds.has(id));
  // An undersized roster can dress the recovering players closest to returning.
  for (const { playerId } of injuries) {
    if (roster.length >= 5) break;
    roster.push(team.roster.find(({ id }) => id === playerId)!);
  }
  const rotation = getRotation({ ...team, roster }, state.rotations?.[teamId]);
  const bench = roster.filter((player) => !rotation.includes(player));
  return { ...team, roster: [...rotation, ...bench] };
}

export function generateGameInjuries(state: FranchiseState, game: ScheduledGame, boxScore: GameBoxScore, teams: Map<string, Team>): Injury[] {
  if (state.injuriesEnabled === false) return [];
  const random = seededRandom(state.seed ^ hash(game.id) ^ 0x4b71);
  const events: Injury[] = [];
  for (const [teamId, box] of [[game.homeId, boxScore.home], [game.awayId, boxScore.away]] as const) {
    const team = teams.get(teamId)!;
    for (const row of box) {
      if (state.injuries?.[row.playerId]?.returnDay && state.injuries[row.playerId].returnDay > game.day) continue;
      const player = team.roster.find(({ id }) => id === row.playerId);
      if (!player) continue;
      const risk = Math.max(0.001, (110 - player.ratings.durability) / 9_000) * Math.min(1.4, row.minutes / 29);
      if (random() >= risk) continue;
      const severity = random();
      const description = severity < 0.60 ? 'ankle sprain' : severity < 0.92 ? 'muscle strain' : 'knee sprain';
      const baseDuration = severity < 0.60 ? 2 : severity < 0.92 ? 5 : 13;
      const returnDay = game.day + 1 + baseDuration + Math.floor(random() * baseDuration);
      events.push({ playerId: player.id, name: player.name, description, day: game.day, returnDay });
    }
  }
  return events;
}
