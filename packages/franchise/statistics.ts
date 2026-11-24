import type { GameState, Player, Side, Team } from '../contracts/index.ts';
import type { FranchiseState, ScheduledGame } from './index.ts';
import { hash, seededRandom } from './schedule.ts';

export type PlayerGameBox = {
  playerId: string;
  name: string;
  minutes: number;
  points: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  threesMade: number;
  threesAttempted: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
};
export type GameBoxScore = { source: 'simulated' | 'played'; home: PlayerGameBox[]; away: PlayerGameBox[] };
export type PlayerSeasonStats = PlayerGameBox & { teamId: string; games: number; rookie: boolean };
export type SeasonStatCategory = 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks';
type PlayedPlayerStats = {
  id: string; name: string; side: Side; points: number; makes: number; attempts: number; threeMakes: number;
  threeAttempts: number; freeThrows: number; freeThrowAttempts: number; assists: number; rebounds: number;
  steals: number; blocks: number; turnovers: number;
};
export type SeasonAward = { title: string; playerId: string; playerName: string; teamId: string };

const statKeys = ['minutes', 'points', 'fieldGoalsMade', 'fieldGoalsAttempted', 'threesMade', 'threesAttempted',
  'freeThrowsMade', 'freeThrowsAttempted', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers'] as const;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

export function getRotation(team: Team, depthChart?: readonly string[]) {
  const sorted = [...team.roster].sort((a, b) => b.overall - a.overall);
  if (!depthChart) return sorted.slice(0, 10);
  const assigned = depthChart.flatMap((id) => {
    const player = sorted.find((candidate) => candidate.id === id);
    return player ? [player] : [];
  });
  const remaining = sorted.filter(({ id }) => !depthChart.includes(id));
  return [...assigned, ...remaining].slice(0, Math.max(5, depthChart.length));
}

export function setTeamRotation(state: FranchiseState, teamId: string, playerIds: readonly string[]): FranchiseState {
  const team = state.teams.find(({ id }) => id === teamId);
  if (!team || playerIds.length < 5 || playerIds.length > 10 || new Set(playerIds).size !== playerIds.length ||
    playerIds.some((id) => !team.roster.some((player) => player.id === id))) {
    throw new Error('Choose five to ten distinct players from the team roster.');
  }
  return { ...state, rotations: { ...state.rotations, [teamId]: [...playerIds] } };
}

const minuteDistributions = [
  [48, 48, 48, 48, 48],
  [43, 42, 41, 38, 36, 40],
  [39, 38, 37, 36, 31, 32, 27],
  [37, 36, 35, 33, 30, 28, 23, 18],
  [35, 34, 34, 32, 28, 25, 21, 17, 14],
  [34, 33, 32, 31, 28, 22, 19, 16, 14, 11],
];

export function rotationMinutes(players: Player[]): number[] {
  return minuteDistributions[players.length - 5];
}

function countFromWeights(total: number, weights: number[], random: () => number): number[] {
  const sum = weights.reduce((accumulated, weight) => accumulated + weight, 0);
  const counts = Array<number>(weights.length).fill(0);
  for (let remaining = total; remaining > 0; remaining--) {
    let target = random() * sum;
    for (const [index, weight] of weights.entries()) {
      target -= weight;
      if (target >= 0 && index < weights.length - 1) continue;
      counts[index]++;
      break;
    }
  }
  return counts;
}

function simulateTeamBox(players: Player[], score: number, random: () => number) {
  const minutes = rotationMinutes(players);
  const allocate = (total: number, skill: (player: Player) => number) => countFromWeights(total,
    players.map((player, index) => minutes[index] * Math.pow(Math.max(15, skill(player)) / 74, 2.8)), random);
  const threes = Math.max(0, Math.min(Math.floor(score / 3), Math.round(score * (0.105 + random() * 0.045))));
  let freeThrows = Math.max(0, Math.min(score - threes * 3, Math.round(score * (0.135 + random() * 0.07))));
  freeThrows += (score - threes * 3 - freeThrows) % 2;
  const twos = (score - threes * 3 - freeThrows) / 2;
  const fieldGoals = twos + threes;
  const twoMakes = allocate(twos, ({ ratings, overall }) => ratings.finishing * 0.6 + ratings.handling * 0.2 + overall * 0.2);
  const threeMakes = allocate(threes, ({ ratings }) => ratings.shooting);
  const freeThrowMakes = allocate(freeThrows, ({ ratings }) => ratings.finishing * 0.55 + ratings.handling * 0.45);
  const twoMisses = allocate(Math.round(twos * (0.68 + random() * 0.34)), ({ ratings }) => ratings.finishing * 0.6 + ratings.handling * 0.4);
  const threeMisses = allocate(Math.round(threes * (1.45 + random() * 0.55)), ({ ratings }) => ratings.shooting);
  const freeThrowMisses = allocate(Math.round(freeThrows * (0.23 + random() * 0.15)), ({ ratings }) => ratings.finishing);
  const assists = allocate(Math.round(fieldGoals * (0.54 + random() * 0.14)), ({ ratings }) => ratings.passing);
  const rebounds = allocate(Math.round(38 + random() * 12), ({ ratings }) => ratings.rebounding);
  const steals = allocate(Math.round(5 + random() * 5), ({ ratings }) => ratings.perimeter);
  const blocks = allocate(Math.round(3 + random() * 5), ({ ratings }) => ratings.interior);
  const turnovers = allocate(Math.round(10 + random() * 8), ({ ratings }) => ratings.handling);
  return players.map((player, index): PlayerGameBox => ({
    playerId: player.id, name: player.name, minutes: minutes[index], points: twoMakes[index] * 2 + threeMakes[index] * 3 + freeThrowMakes[index],
    fieldGoalsMade: twoMakes[index] + threeMakes[index], fieldGoalsAttempted: twoMakes[index] + threeMakes[index] + twoMisses[index] + threeMisses[index],
    threesMade: threeMakes[index], threesAttempted: threeMakes[index] + threeMisses[index],
    freeThrowsMade: freeThrowMakes[index], freeThrowsAttempted: freeThrowMakes[index] + freeThrowMisses[index],
    rebounds: rebounds[index], assists: assists[index], steals: steals[index], blocks: blocks[index], turnovers: turnovers[index],
  }));
}

export function simulateBoxScore(state: FranchiseState, game: ScheduledGame, teams: Map<string, Team>, homeScore: number, awayScore: number): GameBoxScore {
  const random = seededRandom(state.seed ^ hash(game.id) ^ 0x4b7d);
  return {
    source: 'simulated',
    home: simulateTeamBox(getRotation(teams.get(game.homeId)!, state.rotations?.[game.homeId]), homeScore, random),
    away: simulateTeamBox(getRotation(teams.get(game.awayId)!, state.rotations?.[game.awayId]), awayScore, random),
  };
}

export function accumulateSeasonStats(stats: Record<string, PlayerSeasonStats>, game: ScheduledGame, box: GameBoxScore, year: number) {
  for (const [teamId, players] of [[game.homeId, box.home], [game.awayId, box.away]] as const) {
    for (const player of players) {
      const previous = stats[player.playerId];
      if (!previous) {
        stats[player.playerId] = { ...player, teamId, games: 1, rookie: player.playerId.startsWith(`rookie-${year}-`) };
        continue;
      }
      const accumulated = { ...previous, teamId, games: previous.games + 1 };
      for (const key of statKeys) accumulated[key] += player[key];
      stats[player.playerId] = accumulated;
    }
  }
}

export function getSeasonLeaders(state: FranchiseState, category: SeasonStatCategory, limit = 10): PlayerSeasonStats[] {
  const stats = Object.values(state.seasonStats ?? {});
  const minimumGames = Math.min(Math.max(1, Math.floor(state.day * 0.4)), Math.floor(state.seasonLength * 0.6));
  return stats.filter(({ games }) => games >= minimumGames)
    .sort((a, b) => b[category] / b.games - a[category] / a.games || b.games - a.games).slice(0, limit);
}

export function selectAwards(state: FranchiseState): SeasonAward[] {
  const stats = Object.values(state.seasonStats ?? {});
  const minimumGames = Math.ceil(state.seasonLength * 0.6);
  const standings = new Map(state.standings.map(({ teamId, wins, losses }) => [teamId, wins / Math.max(1, wins + losses)]));
  const award = (title: string, eligible: PlayerSeasonStats[], value: (player: PlayerSeasonStats) => number): SeasonAward[] => {
    const winner = eligible.reduce<PlayerSeasonStats | undefined>((best, player) => !best || value(player) > value(best) ? player : best, undefined);
    return winner ? [{ title, playerId: winner.playerId, playerName: winner.name, teamId: winner.teamId }] : [];
  };
  const experienced = stats.filter(({ games }) => games >= minimumGames);
  const impact = (player: PlayerSeasonStats) => (player.points + player.rebounds * 0.65 + player.assists * 1.4 + player.steals * 2 +
    player.blocks * 1.8 - player.turnovers * 0.8) / player.games;
  return [
    ...award('Most Valuable Player', experienced, (player) => impact(player) + clamp((standings.get(player.teamId) ?? 0) * 10, 0, 8)),
    ...award('Defensive Player of the Year', experienced, (player) => (player.rebounds * 0.4 + player.steals * 2 + player.blocks * 2.5) / player.games),
    ...award('Rookie of the Year', experienced.filter(({ rookie }) => rookie), impact),
  ];
}


export function createPlayedBoxScore(gameplay: GameState, stats: readonly PlayedPlayerStats[]): GameBoxScore {
  const minutes = new Map<string, number>();
  const active = new Map(gameplay.players.map(({ id }) => [id, gameplay.tick]));
  const periodSeconds = gameplay.config.periodSeconds ?? 300;
  const periods = gameplay.config.periods ?? 4;
  const clockMinutes = (Math.min(gameplay.period, periods) * periodSeconds + Math.max(0, gameplay.period - periods) *
    Math.min(300, periodSeconds) - gameplay.clock) / 60;
  const addInterval = (id: string, start: number, end: number) => {
    const share = (end - start) / Math.max(gameplay.tick, 1);
    minutes.set(id, (minutes.get(id) ?? 0) + Math.max(0, share * clockMinutes));
  };
  for (const event of [...gameplay.events].reverse()) {
    if ((event.type as string) !== 'substitution' || !event.playerId || !event.detail?.endsWith(' out')) continue;
    const end = active.get(event.playerId);
    if (end === undefined) continue;
    addInterval(event.playerId, event.tick, end);
    active.delete(event.playerId);
    active.set(event.detail.slice(0, -4), event.tick);
  }
  for (const [id, end] of active) addInterval(id, 0, end);
  const translate = (side: Side) => stats.filter((player) => player.side === side &&
    ((minutes.get(player.id) ?? 0) > 0 || player.points || player.attempts || player.freeThrowAttempts || player.rebounds ||
      player.assists || player.steals || player.blocks || player.turnovers)).map((player): PlayerGameBox => ({
    playerId: player.id, name: player.name, minutes: Math.round((minutes.get(player.id) ?? 0) * 100) / 100, points: player.points,
    fieldGoalsMade: player.makes, fieldGoalsAttempted: player.attempts, threesMade: player.threeMakes, threesAttempted: player.threeAttempts,
    freeThrowsMade: player.freeThrows, freeThrowsAttempted: player.freeThrowAttempts, rebounds: player.rebounds,
    assists: player.assists, steals: player.steals, blocks: player.blocks, turnovers: player.turnovers,
  }));
  return { source: 'played', home: translate(0), away: translate(1) };
}
