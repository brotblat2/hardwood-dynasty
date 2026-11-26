import type { Player, Ratings, SaveEnvelope, Team } from '../contracts/index.ts';
import { generateSchedule, hash, seededRandom } from './schedule.ts';
import { generateGameInjuries, getTeamForGame } from './injuries.ts';
import type { Injury } from './injuries.ts';
import type { GameBoxScore, PlayerSeasonStats, SeasonAward } from './statistics.ts';
import { accumulateSeasonStats, getRotation, rotationMinutes, selectAwards, simulateBoxScore } from './statistics.ts';
import { completeDraft, conductFantasyDraft, generateDraftOrder, generateFreeAgents, generateProspects, prepareDraft, progressRosters, startFantasyDraft } from './roster.ts';

export { generateSchedule } from './schedule.ts';
export { getInjuryReport, getTeamForGame } from './injuries.ts';
export type { Injury } from './injuries.ts';
export { createPlayedBoxScore, getRotation, getSeasonLeaders, setTeamRotation } from './statistics.ts';
export type { GameBoxScore, PlayerGameBox, PlayerSeasonStats, SeasonAward, SeasonStatCategory } from './statistics.ts';
export { addExpansionTeam, conductFantasyDraft, draftFantasyPlayer, draftProspect, extendContract, findTradeTargets, getCapSheet, scoutProspect, searchPlayers, signFreeAgent, tradePlayers, waivePlayer } from './roster.ts';

export type ScheduledGame = {
  id: string;
  day: number;
  homeId: string;
  awayId: string;
  homeScore?: number;
  awayScore?: number;
  playoffSeriesId?: string;
  stage?: 'play-in';
  boxScore?: GameBoxScore;
};
export type Standing = {
  teamId: string;
  conference: Team['conference'];
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
};
export type PlayoffSeries = {
  id: string;
  round: number;
  conference: Team['conference'] | 'Finals';
  homeId: string;
  awayId: string;
  homeWins: number;
  awayWins: number;
  gameIds: string[];
  winnerId?: string;
};
export type SeasonSummary = { year: number; championId: string; runnerUpId?: string; standings: Standing[]; playoffs: PlayoffSeries[]; playIn?: ScheduledGame[]; awards?: SeasonAward[]; leaders?: PlayerSeasonStats[]; lottery?: LotteryPick[] };
export type ScoutingReport = {
  potentialLow: number; potentialHigh: number; strengths: (keyof Ratings)[]; developmentAreas: (keyof Ratings)[];
  combine: { wingspan: number; vertical: number; sprint: number };
};
export type Prospect = Player & { scouted: boolean; projectedOverall: number; origin?: string; route?: 'international' | 'college'; report?: ScoutingReport };
export type LotteryPick = { teamId: string; pick: number; firstPickChance: number };
export type DraftPick = { round: number; teamId: string; prospectId?: string };
export type FantasyDraft = { available: Player[]; pickOrder: string[]; picks: { teamId: string; playerId: string; round: number }[]; nextPick: number };
export type FranchiseOptions = {
  userTeamId?: string;
  seed?: number;
  seasonLength?: number;
  startingYear?: number;
  salaryCap?: number;
  financialRules?: Partial<FinancialRules>;
  playoffBestOf?: 1 | 3 | 5 | 7;
  fantasyDraft?: boolean;
  playIn?: boolean;
  injuries?: boolean;
};
export type FinancialRules = { taxLine: number; firstApron: number; secondApron: number; minimumSalary: number };
export type WaivedSalary = { teamId: string; playerId: string; salary: number; years: number; startsIn?: number };
export type ContractExtension = { salary: number; years: number };
export type FranchiseState = {
  teams: Team[];
  userTeamId: string;
  seed: number;
  year: number;
  phase: 'regular' | 'playoffs' | 'offseason';
  day: number;
  seasonLength: number;
  schedule: ScheduledGame[];
  standings: Standing[];
  playoffs: PlayoffSeries[];
  playoffBestOf: 1 | 3 | 5 | 7;
  playoffGroups: Record<Team['conference'], (string | null)[]>;
  playInEnabled?: boolean;
  history: SeasonSummary[];
  prospects: Prospect[];
  draftPicks: DraftPick[];
  lottery?: LotteryPick[];
  freeAgents: Player[];
  news: string[];
  salaryCap: number;
  financialRules?: FinancialRules;
  waivedSalary?: WaivedSalary[];
  contractExtensions?: Record<string, ContractExtension>;
  rotations?: Record<string, string[]>;
  seasonStats?: Record<string, PlayerSeasonStats>;
  injuries?: Record<string, Injury>;
  injuriesEnabled?: boolean;
  fantasyDraft?: FantasyDraft;
};

function emptyStandings(teams: readonly Team[]): Standing[] {
  return teams.map(({ id, conference }) => ({ teamId: id, conference, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 }));
}

export function createFranchise(teams: readonly Team[], options: FranchiseOptions = {}): FranchiseState {
  if (teams.some(({ roster }) => roster.length < 5)) throw new Error('Each team needs a roster of at least five players.');
  const squad = teams.flatMap(({ roster }) => roster);
  if (new Set(squad.map(({ id }) => id)).size !== squad.length) throw new Error('Franchise players must have distinct IDs.');
  const userTeamId = options.userTeamId ?? teams[0]?.id;
  if (!teams.some(({ id }) => id === userTeamId)) throw new Error('Select a team in the league.');
  const salaryCap = options.salaryCap ?? 155_000_000;
  if (!Number.isFinite(salaryCap) || salaryCap < 1) throw new Error('The salary cap must be positive.');
  const financialRules: FinancialRules = {
    taxLine: Math.round(salaryCap * 1.21), firstApron: Math.round(salaryCap * 1.27),
    secondApron: Math.round(salaryCap * 1.35), minimumSalary: 1_250_000, ...options.financialRules,
  };
  if (Object.values(financialRules).some((value) => !Number.isSafeInteger(value) || value < 1) || financialRules.taxLine < salaryCap ||
    financialRules.firstApron < financialRules.taxLine || financialRules.secondApron < financialRules.firstApron) {
    throw new Error('Financial rules require positive and ascending cap, tax, and apron thresholds.');
  }
  const seed = options.seed ?? 2026;
  const year = options.startingYear ?? 2026;
  const seasonLength = options.seasonLength ?? 82;
  const schedule = generateSchedule(teams.map(({ id }) => id), seasonLength, year, seed);
  const state: FranchiseState = {
    teams: structuredClone([...teams]), userTeamId, seed, year, phase: 'regular', day: 1, seasonLength,
    schedule, standings: emptyStandings(teams), playoffs: [], playoffBestOf: options.playoffBestOf ?? 7,
    playoffGroups: { East: [], West: [] }, playInEnabled: options.playIn ?? true, injuriesEnabled: options.injuries ?? true, history: [], prospects: generateProspects(year + 1, teams.length, seed),
    draftPicks: [], freeAgents: generateFreeAgents(year, teams.length, seed), news: [`The ${year} season begins.`], salaryCap, financialRules,
  };
  return options.fantasyDraft ? startFantasyDraft(state) : state;
}

export function getStandings(state: FranchiseState, conference?: Team['conference']): Standing[] {
  const winRate = ({ wins, losses }: Standing) => wins / Math.max(1, wins + losses);
  const standings = state.standings.filter((standing) => !conference || standing.conference === conference);
  const records = new Map(standings.map((standing) => [standing.teamId, `${standing.wins}-${standing.losses}`]));
  const headToHead = new Map<string, { wins: number; losses: number }>();
  for (const game of state.schedule) {
    if (game.playoffSeriesId || game.stage === 'play-in' || game.homeScore === undefined || game.awayScore === undefined) continue;
    const homeRecord = records.get(game.homeId);
    if (!homeRecord || homeRecord !== records.get(game.awayId)) continue;
    const home = headToHead.get(game.homeId) ?? { wins: 0, losses: 0 };
    const away = headToHead.get(game.awayId) ?? { wins: 0, losses: 0 };
    home.wins += Number(game.homeScore > game.awayScore);
    home.losses += Number(game.homeScore < game.awayScore);
    away.wins += Number(game.awayScore > game.homeScore);
    away.losses += Number(game.awayScore < game.homeScore);
    headToHead.set(game.homeId, home);
    headToHead.set(game.awayId, away);
  }
  const miniTableRate = (id: string) => {
    const record = headToHead.get(id);
    return record ? record.wins / (record.wins + record.losses) : 0.5;
  };
  return standings.sort((a, b) => winRate(b) - winRate(a) || b.wins - a.wins || a.losses - b.losses ||
    miniTableRate(b.teamId) - miniTableRate(a.teamId) || (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst)
    || a.teamId.localeCompare(b.teamId));
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function teamStrength(team: Team, depthChart?: readonly string[]) {
  const rotation = getRotation(team, depthChart);
  const minutes = rotationMinutes(rotation);
  let offense = 0;
  let defense = 0;
  let pace = 0;
  let totalWeight = 0;
  for (const [index, player] of rotation.entries()) {
    const { shooting, finishing, passing, handling, rebounding, speed, perimeter, interior, iq } = player.ratings;
    const weight = minutes[index];
    offense += weight * (player.overall * 0.30 + shooting * 0.25 + finishing * 0.18 + passing * 0.12 + handling * 0.08 + iq * 0.07);
    defense += weight * (player.overall * 0.27 + perimeter * 0.25 + interior * 0.24 + rebounding * 0.14 + iq * 0.10);
    pace += weight * speed;
    totalWeight += weight;
  }
  return { offense: offense / totalWeight, defense: defense / totalWeight, pace: pace / totalWeight };
}

function simulateGame(state: FranchiseState, game: ScheduledGame, teams: Map<string, Team>): GameOutcome {
  const random = seededRandom(state.seed ^ hash(game.id));
  const noise = () => (random() + random() + random() + random() - 2) * 20;
  const home = teamStrength(teams.get(game.homeId)!, state.rotations?.[game.homeId]);
  const away = teamStrength(teams.get(game.awayId)!, state.rotations?.[game.awayId]);
  const pace = (home.pace + away.pace - 150) * 0.14;
  const homeScore = Math.round(clamp(107 + pace + (home.offense - 75) * 0.9 - (away.defense - 75) * 0.75 + 2.8 + noise(), 72, 170));
  const awayScore = Math.round(clamp(107 + pace + (away.offense - 75) * 0.9 - (home.defense - 75) * 0.75 + noise(), 72, 170));
  let homeFinal = homeScore;
  let awayFinal = awayScore;
  if (homeScore === awayScore) {
    const homeOvertime = 5 + Math.floor(random() * 10);
    const awayOvertime = 5 + Math.floor(random() * 10);
    homeFinal += homeOvertime + Number(homeOvertime === awayOvertime);
    awayFinal += awayOvertime;
  }
  const boxScore = simulateBoxScore(state, game, teams, homeFinal, awayFinal);
  return { homeScore: homeFinal, awayScore: awayFinal, boxScore, injuries: generateGameInjuries(state, game, boxScore, teams) };
}

type GameOutcome = { homeScore: number; awayScore: number; boxScore?: GameBoxScore; injuries?: Injury[] };

function scoreGames(state: FranchiseState, outcomes: Map<string, GameOutcome>): FranchiseState {
  const seasonStats = { ...state.seasonStats };
  const injuries = { ...state.injuries };
  const injuryNews: string[] = [];
  const standings = new Map(state.standings.map((standing) => [standing.teamId, { ...standing }]));
  const playoffs = new Map(state.playoffs.map((series) => [series.id, { ...series }]));
  const seasonWinsNeeded = (state.playoffBestOf + 1) / 2;
  const schedule = state.schedule.map((game) => {
    const outcome = outcomes.get(game.id);
    if (!outcome) {
      if (game.boxScore && game.day < state.day - 7) {
        const { boxScore, ...older } = game;
        return older;
      }
      return game;
    }
    const { homeScore, awayScore, boxScore } = outcome;
    for (const injury of outcome.injuries ?? []) {
      injuries[injury.playerId] = injury;
      injuryNews.push(`${injury.name} will miss ${injury.returnDay - injury.day - 1} days with a ${injury.description}.`);
    }
    const winnerId = homeScore > awayScore ? game.homeId : game.awayId;
    if (game.playoffSeriesId) {
      const series = playoffs.get(game.playoffSeriesId)!;
      if (winnerId === series.homeId) series.homeWins++;
      else series.awayWins++;
      if (Math.max(series.homeWins, series.awayWins) === seasonWinsNeeded) series.winnerId = winnerId;
    } else if (game.stage !== 'play-in') {
      const home = standings.get(game.homeId)!;
      const away = standings.get(game.awayId)!;
      home.wins += Number(homeScore > awayScore);
      home.losses += Number(homeScore < awayScore);
      away.wins += Number(awayScore > homeScore);
      away.losses += Number(awayScore < homeScore);
      home.pointsFor += homeScore;
      home.pointsAgainst += awayScore;
      away.pointsFor += awayScore;
      away.pointsAgainst += homeScore;
      if (boxScore) accumulateSeasonStats(seasonStats, game, boxScore, state.year);
    }
    return boxScore ? { ...game, homeScore, awayScore, boxScore } : { ...game, homeScore, awayScore };
  });
  return { ...state, standings: [...standings.values()], playoffs: [...playoffs.values()], schedule, seasonStats, injuries, news: [...injuryNews, ...state.news].slice(0, 24) };
}

const conferences = ['East', 'West'] as const;

function bracketSeeds(qualified: string[]): (string | null)[] {
  if (qualified.length < 2) return qualified;
  let seedOrder = [1, 2];
  while (seedOrder.length < qualified.length) {
    const sum = seedOrder.length * 2 + 1;
    seedOrder = seedOrder.flatMap((seed) => [seed, sum - seed]);
  }
  return seedOrder.map((seed) => qualified[seed - 1] ?? null);
}

function closeSeason(state: FranchiseState, championId: string, runnerUpId?: string): FranchiseState {
  const name = state.teams.find(({ id }) => id === championId)!.name;
  const { draftPicks, lottery } = generateDraftOrder(state, getStandings(state));
  return prepareDraft(progressRosters({
    ...state, phase: 'offseason',
    history: [...state.history, { year: state.year, championId, runnerUpId, standings: state.standings, playoffs: state.playoffs,
      playIn: state.schedule.filter(({ stage }) => stage === 'play-in').map(({ boxScore, ...game }) => game),
      awards: selectAwards(state), leaders: Object.values(state.seasonStats ?? {}).sort((a, b) => b.points - a.points).slice(0, 10), lottery }],
    draftPicks, lottery,
    news: [`The ${name} won the ${state.year} championship.`, ...state.news].slice(0, 24),
  }));
}

function queuePlayoffDay(state: FranchiseState, series: PlayoffSeries[]): FranchiseState {
  const games = new Map<string, ScheduledGame>();
  const playoffs = series.map((matchup) => {
    if (matchup.winnerId) return matchup;
    const number = matchup.gameIds.length + 1;
    const homeDates = state.playoffBestOf <= 3 ? [1, 3] : [1, 2, 5, 7];
    const homeCourt = homeDates.includes(number);
    const homeId = homeCourt ? matchup.homeId : matchup.awayId;
    const awayId = homeCourt ? matchup.awayId : matchup.homeId;
    const id = `${matchup.id}-g${number}`;
    games.set(id, { id, day: state.day, homeId, awayId, playoffSeriesId: matchup.id });
    return { ...matchup, gameIds: [...matchup.gameIds, id] };
  });
  return { ...state, playoffs, schedule: [...state.schedule, ...games.values()] };
}

function newPlayoffRound(state: FranchiseState, round: number): FranchiseState {
  const groups = state.playoffGroups;
  const standings = getStandings(state);
  const makeSeries = (a: string, b: string, conference: PlayoffSeries['conference'], index: number): PlayoffSeries => {
    const aHasHomeCourt = standings.findIndex(({ teamId }) => teamId === a) < standings.findIndex(({ teamId }) => teamId === b);
    return { id: `${state.year}-p${round}-${conference}-${index}`, round, conference,
      homeId: aHasHomeCourt ? a : b, awayId: aHasHomeCourt ? b : a, homeWins: 0, awayWins: 0, gameIds: [] };
  };
  const rounds: PlayoffSeries[] = [];
  if (groups.East.length <= 1 && groups.West.length <= 1) {
    const [east, west] = [groups.East[0], groups.West[0]];
    if (east && west) rounds.push(makeSeries(east, west, 'Finals', 1));
    else return closeSeason(state, (east ?? west)!);
  } else {
    for (const conference of conferences) {
      const seeds = groups[conference];
      for (let index = 0; index < seeds.length - 1; index += 2) {
        const a = seeds[index];
        const b = seeds[index + 1];
        if (a && b) rounds.push(makeSeries(a, b, conference, index / 2 + 1));
      }
    }
  }
  return queuePlayoffDay(state, [...state.playoffs, ...rounds]);
}

function playInGame(state: FranchiseState, conference: Team['conference'], match: string, homeId: string, awayId: string): ScheduledGame {
  return { id: `${state.year}-play-in-${conference}-${match}`, day: state.day, homeId, awayId, stage: 'play-in' };
}

function startPlayoffs(state: FranchiseState): FranchiseState {
  const determineWinner = ({ homeId, awayId, homeScore, awayScore }: ScheduledGame) => homeScore! > awayScore! ? homeId : awayId;
  const playoffGroups = { East: [] as (string | null)[], West: [] as (string | null)[] };
  const pending: ScheduledGame[] = [];
  for (const conference of conferences) {
    const seeds = getStandings(state, conference).slice(0, 10).map(({ teamId }) => teamId);
    if (state.playInEnabled === false || seeds.length < 10) {
      playoffGroups[conference] = bracketSeeds(seeds.slice(0, 8));
      continue;
    }
    const lookup = (match: string) => state.schedule.find(({ id }) => id === `${state.year}-play-in-${conference}-${match}`);
    const upper = lookup('upper');
    const lower = lookup('lower');
    const final = lookup('final');
    if (!upper || !lower) {
      pending.push(playInGame(state, conference, 'upper', seeds[6], seeds[7]), playInGame(state, conference, 'lower', seeds[8], seeds[9]));
      continue;
    }
    const seventhSeed = determineWinner(upper);
    if (!final) {
      const upperLoser = seventhSeed === upper.homeId ? upper.awayId : upper.homeId;
      pending.push(playInGame(state, conference, 'final', upperLoser, determineWinner(lower)));
      continue;
    }
    playoffGroups[conference] = bracketSeeds([...seeds.slice(0, 6), seventhSeed, determineWinner(final)]);
  }
  return pending.length ? { ...state, schedule: [...state.schedule, ...pending] } : newPlayoffRound({ ...state, playoffGroups }, 1);
}

function completeDay(state: FranchiseState): FranchiseState {
  if (state.schedule.some((game) => game.day === state.day && game.homeScore === undefined)) return state;
  const next = { ...state, day: state.day + 1 };
  if (state.phase === 'regular') {
    if (state.schedule.some((game) => game.day > state.day)) return next;
    return startPlayoffs({ ...next, phase: 'playoffs' });
  }
  if (!state.playoffs.length) return startPlayoffs(next);
  const round = state.playoffs.at(-1)!.round;
  const latest = state.playoffs.filter((series) => series.round === round);
  if (latest.some((series) => !series.winnerId)) return queuePlayoffDay(next, state.playoffs);
  const finals = latest.find((series) => series.conference === 'Finals');
  if (finals) return closeSeason(next, finals.winnerId!, finals.winnerId === finals.homeId ? finals.awayId : finals.homeId);
  const playoffGroups = { ...state.playoffGroups };
  for (const conference of conferences) {
    const seeds = playoffGroups[conference];
    if (seeds.length < 2) continue;
    playoffGroups[conference] = Array.from({ length: seeds.length / 2 }, (_, index) => {
      const a = seeds[index * 2];
      const b = seeds[index * 2 + 1];
      if (a === null || b === null) return a ?? b;
      return latest.find((matchup) => matchup.conference === conference &&
        ((matchup.homeId === a && matchup.awayId === b) || (matchup.homeId === b && matchup.awayId === a)))!.winnerId!;
    });
  }
  if (!playoffGroups.East.length || !playoffGroups.West.length) {
    const last = latest.find(({ conference }) => playoffGroups[conference as Team['conference']].length === 1);
    if (last) return closeSeason(next, last.winnerId!, last.winnerId === last.homeId ? last.awayId : last.homeId);
  }
  return newPlayoffRound({ ...next, playoffGroups }, round + 1);
}

export function simulateNextDay(state: FranchiseState): FranchiseState {
  if (state.phase === 'offseason') return state;
  const outcomes = new Map<string, GameOutcome>();
  const teams = new Map(state.teams.map((team) => [team.id, getTeamForGame(state, team.id)]));
  for (const game of state.schedule) {
    if (game.day === state.day && game.homeScore === undefined) outcomes.set(game.id, simulateGame(state, game, teams));
  }
  return completeDay(scoreGames(state, outcomes));
}

export function simulateDays(state: FranchiseState, days: number): FranchiseState {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error('Choose a nonnegative number of days.');
  let current = state;
  for (let index = 0; index < days && current.phase !== 'offseason'; index++) current = simulateNextDay(current);
  return current;
}

export function simulateToEnd(state: FranchiseState): FranchiseState {
  let current = state;
  while (current.phase !== 'offseason') current = simulateNextDay(current);
  return current;
}

export function getNextUserGame(state: FranchiseState): ScheduledGame | undefined {
  return state.schedule.find((game) => game.homeScore === undefined && (game.homeId === state.userTeamId || game.awayId === state.userTeamId));
}

export function recordGameResult(state: FranchiseState, gameId: string, homeScore: number, awayScore: number, boxScore?: GameBoxScore): FranchiseState {
  const game = state.schedule.find(({ id }) => id === gameId);
  if (!game || game.homeScore !== undefined || state.phase === 'offseason' || game.day < state.day) throw new Error('This game is no longer available.');
  if (![homeScore, awayScore].every((score) => Number.isSafeInteger(score) && score >= 0) || homeScore === awayScore) {
    throw new Error('A final score must contain two different nonnegative whole numbers.');
  }
  if (boxScore && (boxScore.home.reduce((total, player) => total + player.points, 0) !== homeScore ||
    boxScore.away.reduce((total, player) => total + player.points, 0) !== awayScore)) throw new Error('The box score must agree with the final score.');
  let current = state;
  while (current.day < game.day) current = simulateNextDay(current);
  return completeDay(scoreGames(current, new Map([[gameId, { homeScore, awayScore, boxScore }]])));
}

export function advanceOffseason(state: FranchiseState): FranchiseState {
  if (state.phase !== 'offseason') throw new Error('Finish the season before advancing to the next year.');
  const developed = completeDraft(state);
  const year = state.year + 1;
  const seasonLength = developed.teams.length % 2 && state.seasonLength % 2 ? state.seasonLength + 1 : state.seasonLength;
  return {
    ...developed, year, phase: 'regular', day: 1, seasonLength, standings: emptyStandings(developed.teams),
    schedule: generateSchedule(developed.teams.map(({ id }) => id), seasonLength, year, state.seed), playoffs: [],
    playoffGroups: { East: [], West: [] }, prospects: generateProspects(year + 1, developed.teams.length, state.seed),
    draftPicks: [], lottery: [], seasonStats: {}, injuries: {}, news: [`The ${year} season begins.`, ...developed.news].slice(0, 24),
  };
}

export const FRANCHISE_SAVE_KEY = 'hardwood-dynasty-franchise';
export type SaveStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function saveFranchise(storage: SaveStorage, key: string, state: FranchiseState): void {
  const envelope: SaveEnvelope<FranchiseState> = { version: 1, savedAt: new Date().toISOString(), data: state };
  storage.setItem(key, JSON.stringify(envelope));
}

export function loadFranchise(storage: SaveStorage, key: string): FranchiseState | null {
  try {
    const saved = storage.getItem(key);
    if (!saved) return null;
    const { version, data } = JSON.parse(saved) as SaveEnvelope<FranchiseState>;
    if (version !== 1 || !data || !Number.isInteger(data.year) || !Array.isArray(data.teams) || !Array.isArray(data.schedule)
      || !Array.isArray(data.standings) || !Array.isArray(data.history) || !Array.isArray(data.playoffs)
      || !Array.isArray(data.prospects) || !Array.isArray(data.draftPicks) || !Array.isArray(data.freeAgents)
      || !Array.isArray(data.news) || !data.playoffGroups || !data.teams.some(({ id }) => id === data.userTeamId)
      || !['regular', 'playoffs', 'offseason'].includes(data.phase)) return null;
    return data;
  } catch {
    return null;
  }
}
