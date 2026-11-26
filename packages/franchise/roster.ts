import type { Player, Position, Ratings, Team } from '../contracts/index.ts';
import type { DraftPick, FantasyDraft, FranchiseState, LotteryPick, Prospect, Standing } from './index.ts';
import { hash, seededRandom, shuffle } from './schedule.ts';

const minimumSalary = 1_250_000;
const rosterLimit = 15;
const rotationMinimum = 10;
const positions: Position[] = ['PG', 'SG', 'SF', 'PF', 'C'];
const givenNames = ['Adrian', 'Amari', 'Brandon', 'Caleb', 'Cameron', 'Carter', 'Dante', 'Darius', 'Evan', 'Isaiah', 'Jalen', 'Jordan', 'Julian', 'Kai', 'Kendrick', 'Landon', 'Leo', 'Malik', 'Mateo', 'Micah', 'Miles', 'Nico', 'Omar', 'Quentin', 'Rafael', 'Rowan', 'Theo', 'Tyrell', 'Victor', 'Zion'];
const surnames = ['Adler', 'Baxter', 'Brooks', 'Caldwell', 'Chambers', 'Cross', 'Delgado', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Holloway', 'Ibarra', 'Jackson', 'Kane', 'Lawson', 'Mason', 'Moreno', 'Nash', 'Pierce', 'Quinn', 'Reed', 'Rivera', 'Shaw', 'Stone', 'Sutton', 'Valdez', 'Walker', 'Wells', 'Wright'];

const clampRating = (rating: number) => Math.max(35, Math.min(99, rating));
const salary = (player: Player) => player.salary ?? minimumSalary;
const schools = ['Great Lakes', 'Atlantic State', 'Pacific College', 'Central Plains', 'Mountain Tech', 'Metro University', 'Western Valley', 'Gulf Coast'];
const internationalLeagues = ['France', 'Spain', 'Canada', 'Australia', 'Serbia', 'Brazil', 'Nigeria', 'Japan', 'Turkey', 'Greece'];
const ratingKeys: Exclude<keyof Ratings, 'strength'>[] = ['shooting', 'finishing', 'passing', 'handling', 'rebounding', 'speed', 'perimeter', 'interior', 'iq', 'durability'];

function withNews(state: FranchiseState, news: string): FranchiseState {
  return { ...state, news: [news, ...state.news].slice(0, 24) };
}

function playerProfile(id: string, seed: number, position: Position, overall: number, age: number): Player {
  const random = seededRandom(seed ^ hash(id));
  const positionIndex = positions.indexOf(position);
  const modifiers = {
    shooting: [5, 8, 3, -1, -8], finishing: [-3, 2, 4, 8, 9], passing: [9, 3, 1, -4, -5],
    handling: [12, 7, 1, -5, -10], rebounding: [-12, -8, -2, 7, 12], speed: [10, 7, 2, -3, -8],
    perimeter: [6, 5, 7, -2, -7], interior: [-11, -8, 0, 6, 12], iq: [2, 1, 0, 0, 0], durability: [3, 3, 3, 3, 3],
  };
  const ratings = Object.fromEntries(ratingKeys.map((key) => [key, clampRating(overall + modifiers[key][positionIndex] + Math.floor(random() * 11) - 5)])) as Ratings;
  const pick = (names: string[]) => names[Math.floor(random() * names.length)];
  return {
    id, name: `${pick(givenNames)} ${pick(surnames)}`, number: Math.floor(random() * 99), position, ratings,
    height: Math.round((1.82 + positionIndex * 0.079 + random() * 0.075) * 100) / 100, age, overall,
    potential: clampRating(overall + 3 + Math.floor(random() * 15)), salary: minimumSalary, years: 2,
  };
}

export function generateProspects(year: number, teams: number, seed: number): Prospect[] {
  const random = seededRandom(seed ^ year ^ 0x6b80);
  const prospects = Array.from({ length: Math.max(30, teams * 2 + 12) }, (_, index): Prospect => {
    const age = 19 + Math.floor(random() * 5);
    const position = positions[index % positions.length];
    const overall = Math.round(57 + Math.pow(random(), 2.5) * 24);
    const player = playerProfile(`rookie-${year}-${index + 1}`, seed, position, overall, age);
    const international = random() < 0.24;
    const originPool = international ? internationalLeagues : schools;
    const origin = originPool[Math.floor(random() * originPool.length)];
    return { ...player, scouted: false, projectedOverall: clampRating(overall + Math.floor(random() * 13) - 6),
      origin, route: international ? 'international' : 'college' };
  });
  return prospects.sort((a, b) => b.projectedOverall - a.projectedOverall);
}

export function generateFreeAgents(year: number, teams: number, seed: number): Player[] {
  const random = seededRandom(seed ^ year ^ 0x282);
  return Array.from({ length: Math.max(15, teams * 2) }, (_, index) => {
    const ability = 58 + Math.floor(random() * 16);
    const player = playerProfile(`free-agent-${year}-${index + 1}`, seed, positions[index % positions.length], ability, 24 + index % 10);
    return { ...player, years: 0 };
  }).sort((a, b) => b.overall - a.overall);
}

export function scoutProspect(state: FranchiseState, prospectId: string): FranchiseState {
  const prospect = state.prospects.find(({ id }) => id === prospectId);
  if (!prospect) throw new Error('This prospect is unavailable.');
  if (prospect.scouted) return state;
  const random = seededRandom(state.seed ^ hash(prospect.id + '-scouting'));
  const range = 3 + Math.floor(random() * 4);
  const projection = clampRating(prospect.potential + Math.round((random() - 0.5) * range));
  const combine = {
    wingspan: Math.round((prospect.height + 0.03 + random() * 0.13) * 100) / 100,
    vertical: Math.round(44 + prospect.ratings.finishing * 0.45 + random() * 12),
    sprint: Math.round((4.4 - prospect.ratings.speed * 0.014 + random() * 0.2) * 100) / 100,
  };
  const skills = [...ratingKeys].sort((a, b) => prospect.ratings[b] - prospect.ratings[a]);
  const report = { potentialLow: clampRating(projection - range), potentialHigh: clampRating(projection + range),
    strengths: skills.slice(0, 3), developmentAreas: skills.slice(-2), combine };
  return withNews({ ...state, prospects: state.prospects.map((candidate) => candidate.id === prospectId
    ? { ...candidate, scouted: true, projectedOverall: candidate.overall, report } : candidate) }, `Scouting report completed for ${prospect.name}.`);
}

export function getCapSheet(state: FranchiseState, teamId: string) {
  const team = state.teams.find(({ id }) => id === teamId);
  if (!team) throw new Error('Team is unavailable.');
  const fallbackCap = state.salaryCap;
  const { taxLine, firstApron, secondApron } = state.financialRules ?? {
    taxLine: Math.round(fallbackCap * 1.21), firstApron: Math.round(fallbackCap * 1.27), secondApron: Math.round(fallbackCap * 1.35),
  };
  const deadMoney = (state.waivedSalary ?? []).filter((waived) => waived.teamId === teamId && !waived.startsIn).reduce((total, waived) => total + waived.salary, 0);
  const payroll = team.roster.reduce((total, player) => total + salary(player), deadMoney);
  const rates = [1.5, 1.75, 2.5, 3.25];
  let amountTaxed = Math.max(0, payroll - taxLine);
  let luxuryTax = 0;
  for (const rate of rates) {
    const taxable = Math.min(5_000_000, amountTaxed);
    luxuryTax += taxable * rate;
    amountTaxed -= taxable;
  }
  const addedBands = Math.floor(amountTaxed / 5_000_000);
  luxuryTax += 5_000_000 * addedBands * (3.75 + (addedBands - 1) * 0.25);
  luxuryTax += (amountTaxed % 5_000_000) * (3.75 + addedBands * 0.5);
  return {
    teamId, salaryCap: state.salaryCap, payroll, capSpace: state.salaryCap - payroll, deadMoney,
    taxLine, firstApron, secondApron, luxuryTax,
    extensions: team.roster.flatMap((player) => state.contractExtensions?.[player.id] ? [{ playerId: player.id, ...state.contractExtensions[player.id] }] : []),
    rosterSize: team.roster.length, rosterLimit,
    players: [...team.roster].sort((a, b) => salary(b) - salary(a)),
  };
}

function selectDraftPick(state: FranchiseState, pick: DraftPick, prospect: Prospect): FranchiseState {
  const team = state.teams.find(({ id }) => id === pick.teamId)!;
  const { scouted, projectedOverall, origin, route, report, ...player } = prospect;
  const signed = { ...player, years: pick.round === 1 ? 3 : 2,
    salary: pick.round === 1 ? Math.round(Math.max(2_000_000, 1_200_000 + (player.overall - 60) * 170_000)) : minimumSalary };
  const released = team.roster.length >= rosterLimit
    ? [...team.roster].sort((a, b) => a.overall - b.overall || a.potential - b.potential)[0] : undefined;
  const eligible = released ? waivePlayer(state, team.id, released.id) : state;
  const next: FranchiseState = {
    ...eligible,
    draftPicks: eligible.draftPicks.map((candidate) => candidate === pick ? { ...candidate, prospectId: player.id } : candidate),
    teams: eligible.teams.map((candidate) => candidate.id === team.id
      ? { ...candidate, roster: [...candidate.roster, signed] } : candidate),
    prospects: eligible.prospects.filter(({ id }) => id !== player.id),
  };
  return withNews(next, `The ${team.name} selected ${player.name} in round ${pick.round}.`);
}

function runDraft(state: FranchiseState, stopAtUser: boolean): FranchiseState {
  let current = state;
  for (const pick of state.draftPicks) {
    if (pick.prospectId) continue;
    if (stopAtUser && pick.teamId === state.userTeamId) break;
    const prospect = current.prospects.reduce<Prospect | undefined>((best, candidate) =>
      !best || candidate.overall * 2 + candidate.potential > best.overall * 2 + best.potential ? candidate : best, undefined);
    if (!prospect) break;
    current = selectDraftPick(current, pick, prospect);
  }
  return current;
}

export function draftProspect(state: FranchiseState, prospectId: string): FranchiseState {
  if (state.phase !== 'offseason') throw new Error('The draft takes place in the offseason.');
  if (!state.draftPicks.some((pick) => pick.teamId === state.userTeamId && !pick.prospectId)) throw new Error('Your team has selected its picks.');
  const chosen = state.prospects.find(({ id }) => id === prospectId);
  if (!chosen) throw new Error('This prospect is unavailable.');
  const pick = state.draftPicks.find((candidate) => !candidate.prospectId);
  if (!pick || pick.teamId !== state.userTeamId) throw new Error('Wait for your team’s draft pick.');
  return runDraft(selectDraftPick(state, pick, chosen), true);
}

export function generateDraftOrder(state: FranchiseState, standings: Standing[]): { draftPicks: DraftPick[]; lottery: LotteryPick[] } {
  const playoffTeams = new Set(state.playoffs.flatMap(({ homeId, awayId }) => [homeId, awayId]));
  const inverse = [...standings].reverse().map(({ teamId }) => teamId);
  const lotteryTeams = inverse.filter((id) => !playoffTeams.has(id));
  const weights = [140, 140, 140, 125, 105, 90, 75, 60, 45, 30, 20, 15, 10, 5];
  const eligible = lotteryTeams.map((teamId, index) => ({ teamId, weight: weights[index] ?? 2 }));
  const allWeights = eligible.reduce((sum, { weight }) => sum + weight, 0);
  const odds = new Map(eligible.map(({ teamId, weight }) => [teamId, weight / allWeights]));
  const random = seededRandom(state.seed ^ state.year ^ 0x5d23);
  const drawn: string[] = [];
  const drawingCount = Math.min(4, eligible.length);
  for (let index = 0; index < drawingCount; index++) {
    let ticket = random() * eligible.reduce((sum, { weight }) => sum + weight, 0);
    const selection = eligible.findIndex(({ weight }) => (ticket -= weight) < 0);
    drawn.push(eligible.splice(selection, 1)[0].teamId);
  }
  const lotteryOrder = [...drawn, ...eligible.map(({ teamId }) => teamId)];
  const firstRound = [...lotteryOrder, ...inverse.filter((id) => playoffTeams.has(id))];
  return {
    draftPicks: [...firstRound.map((teamId) => ({ round: 1, teamId })), ...inverse.map((teamId) => ({ round: 2, teamId }))],
    lottery: lotteryOrder.map((teamId, index) => ({ teamId, pick: index + 1, firstPickChance: odds.get(teamId)! })),
  };
}

export function prepareDraft(state: FranchiseState): FranchiseState {
  return runDraft(state, true);
}

export function completeDraft(state: FranchiseState): FranchiseState {
  return runDraft(state, false);
}

export function signFreeAgent(state: FranchiseState, teamId: string, playerId: string, annualSalary: number, years: number): FranchiseState {
  const team = state.teams.find(({ id }) => id === teamId);
  const player = state.freeAgents.find(({ id }) => id === playerId);
  if (!team || !player) throw new Error('The team or free agent is unavailable.');
  const contractMinimum = state.financialRules?.minimumSalary ?? minimumSalary;
  if (!Number.isSafeInteger(annualSalary) || annualSalary < contractMinimum || !Number.isInteger(years) || years < 1 || years > 5) {
    throw new Error(`Offer at least $${(contractMinimum / 1_000_000).toLocaleString('en-US')}M annually for one to five years.`);
  }
  const sheet = getCapSheet(state, teamId);
  if (sheet.rosterSize >= rosterLimit) throw new Error('The roster is full.');
  if (annualSalary > contractMinimum && annualSalary > sheet.capSpace) throw new Error('The contract exceeds available cap space.');
  return withNews({ ...state, freeAgents: state.freeAgents.filter(({ id }) => id !== playerId),
    teams: state.teams.map((candidate) => candidate.id === teamId
      ? { ...candidate, roster: [...candidate.roster, { ...player, salary: annualSalary, years }] } : candidate),
  }, `The ${team.name} signed ${player.name} for ${years} ${years === 1 ? 'year' : 'years'}.`);
}

export function tradePlayers(state: FranchiseState, teamAId: string, playerAIds: readonly string[], teamBId: string, playerBIds: readonly string[]): FranchiseState {
  const a = state.teams.find(({ id }) => id === teamAId);
  const b = state.teams.find(({ id }) => id === teamBId);
  if (!a || !b || a.id === b.id) throw new Error('Select two different teams.');
  const fromA = a.roster.filter(({ id }) => playerAIds.includes(id));
  const fromB = b.roster.filter(({ id }) => playerBIds.includes(id));
  if (!fromA.length || !fromB.length || fromA.length !== playerAIds.length || fromB.length !== playerBIds.length) {
    throw new Error('Each side must include available players from its roster.');
  }
  const exchange = (team: Team, leaving: Player[], arriving: Player[]) => {
    const roster = [...team.roster.filter((player) => !leaving.includes(player)), ...arriving];
    if (roster.length < 5 || roster.length > rosterLimit) throw new Error('A trade must leave both rosters with five to 15 players.');
    const outgoingSalary = leaving.reduce((total, player) => total + salary(player), 0);
    const incomingSalary = arriving.reduce((total, player) => total + salary(player), 0);
    const { payroll, firstApron, secondApron } = getCapSheet(state, team.id);
    const nextPayroll = payroll - outgoingSalary + incomingSalary;
    if (nextPayroll > secondApron && leaving.length > 1) throw new Error(`The ${team.name} cannot combine outgoing salaries above the second apron.`);
    if (nextPayroll > firstApron && incomingSalary > outgoingSalary) throw new Error(`The ${team.name} cannot take on additional salary above the first apron.`);
    if (nextPayroll > state.salaryCap && incomingSalary > outgoingSalary * 1.25 + 100_000) {
      throw new Error(`The ${team.name} exceed over-cap salary matching.`);
    }
    return { ...team, roster };
  };
  const tradedA = exchange(a, fromA, fromB);
  const tradedB = exchange(b, fromB, fromA);
  return withNews({ ...state, teams: state.teams.map((team) => team.id === a.id ? tradedA : team.id === b.id ? tradedB : team) },
    `The ${a.name} and ${b.name} completed a trade.`);
}

export function extendContract(state: FranchiseState, teamId: string, playerId: string, annualSalary: number, addedYears: number): FranchiseState {
  const team = state.teams.find(({ id }) => id === teamId);
  const player = team?.roster.find(({ id }) => id === playerId);
  if (!team || !player) throw new Error('The player is unavailable.');
  const yearsLeft = player.years ?? 2;
  if (yearsLeft !== 1 || state.contractExtensions?.[playerId]) throw new Error('Extensions are available once in the final contract year.');
  if (!Number.isSafeInteger(annualSalary) || annualSalary < (state.financialRules?.minimumSalary ?? minimumSalary) ||
    annualSalary > Math.max(salary(player) * 1.4, minimumSalary * 2) || !Number.isInteger(addedYears) || addedYears < 1 || addedYears > 4) {
    throw new Error('Offer one to four added years within the eligible salary range.');
  }
  return withNews({ ...state, contractExtensions: { ...state.contractExtensions, [playerId]: { salary: annualSalary, years: addedYears } } },
    `The ${team.name} extended ${player.name} for ${addedYears} ${addedYears === 1 ? 'year' : 'years'}.`);
}

export function waivePlayer(state: FranchiseState, teamId: string, playerId: string): FranchiseState {
  const team = state.teams.find(({ id }) => id === teamId);
  const player = team?.roster.find(({ id }) => id === playerId);
  if (!team || !player) throw new Error('The player is unavailable.');
  if (team.roster.length <= 5) throw new Error('Keep at least five active players.');
  const yearsLeft = player.years ?? 2;
  const contractExtensions = { ...state.contractExtensions };
  const extension = contractExtensions[playerId];
  delete contractExtensions[playerId];
  const waivedSalary = [...(state.waivedSalary ?? []), { teamId, playerId, salary: salary(player), years: yearsLeft }];
  if (extension) waivedSalary.push({ teamId, playerId, ...extension, startsIn: yearsLeft });
  return withNews({ ...state, contractExtensions, waivedSalary, freeAgents: [...state.freeAgents, { ...player, years: 0 }],
    teams: state.teams.map((candidate) => candidate.id === team.id ? { ...candidate, roster: candidate.roster.filter(({ id }) => id !== playerId) } : candidate),
  }, `The ${team.name} waived ${player.name}.`);
}

export type PlayerSearch = { query?: string; position?: Position; minAge?: number; maxAge?: number; minOverall?: number;
  minPotential?: number; maxSalary?: number; maxYears?: number; minPointsPerGame?: number };

export function searchPlayers(state: FranchiseState, filters: PlayerSearch = {}) {
  const query = filters.query?.toLocaleLowerCase().trim() ?? '';
  const players = [...state.teams.flatMap((team) => team.roster.map((player) => ({ player, teamId: team.id }))),
    ...state.freeAgents.map((player) => ({ player, teamId: null }))];
  return players.filter(({ player }) => {
    const stats = state.seasonStats?.[player.id];
    const pointsPerGame = stats ? stats.points / stats.games : 0;
    return player.name.toLocaleLowerCase().includes(query) && (!filters.position || player.position === filters.position) &&
      player.age >= (filters.minAge ?? 0) && player.age <= (filters.maxAge ?? Infinity) && player.overall >= (filters.minOverall ?? 0) &&
      player.potential >= (filters.minPotential ?? 0) && salary(player) <= (filters.maxSalary ?? Infinity) &&
      (player.years ?? 2) <= (filters.maxYears ?? Infinity) && pointsPerGame >= (filters.minPointsPerGame ?? 0);
  }).sort((a, b) => b.player.overall - a.player.overall);
}

export function findTradeTargets(state: FranchiseState, teamId: string, offeringId: string, filters: PlayerSearch = {}) {
  const team = state.teams.find(({ id }) => id === teamId);
  const offering = team?.roster.find(({ id }) => id === offeringId);
  if (!offering) return [];
  const value = (player: Player) => player.overall + (player.potential - player.overall) * 0.42 - Math.max(0, player.age - 30) * 0.8;
  return searchPlayers(state, filters).filter(({ teamId: ownerId }) => ownerId && ownerId !== teamId).flatMap(({ player, teamId: ownerId }) => {
    const difference = Math.abs(value(player) - value(offering));
    if (difference > 8) return [];
    try {
      tradePlayers(state, teamId, [offeringId], ownerId!, [player.id]);
      return [{ player, teamId: ownerId!, difference }];
    } catch {
      return [];
    }
  }).sort((a, b) => a.difference - b.difference);
}

export function conductFantasyDraft(state: FranchiseState): FranchiseState {
  let next = startFantasyDraft(state);
  while (next.fantasyDraft) next = makeFantasyPick(next, next.fantasyDraft.available[0]?.id);
  return next;
}

export function startFantasyDraft(state: FranchiseState): FranchiseState {
  if (state.phase !== 'regular' || state.schedule.some(({ homeScore }) => homeScore !== undefined)) throw new Error('Start a fantasy draft before the first game of a season.');
  if (state.fantasyDraft) return state;
  const random = seededRandom(state.seed ^ state.year ^ 0xf747);
  const order = shuffle(state.teams.map(({ id }) => id), random);
  const available = state.teams.flatMap(({ roster }) => roster).sort((a, b) => b.overall - a.overall || b.potential - a.potential);
  const sizes = new Map(state.teams.map(({ id, roster }) => [id, roster.length]));
  const pickOrder: string[] = [];
  for (let round = 0; pickOrder.length < available.length; round++) {
    const roundOrder = round % 2 ? [...order].reverse() : order;
    for (const id of roundOrder) if (pickOrder.filter(teamId => teamId === id).length < (sizes.get(id) ?? 0)) pickOrder.push(id);
  }
  const draft: FantasyDraft = { available, pickOrder, picks: [], nextPick: 0 };
  const started = withNews({ ...state, fantasyDraft: draft, teams: state.teams.map(team => ({ ...team, roster: [] })) }, 'Fantasy draft underway. You are on the clock when your team is up.');
  return advanceCpuPicks(started);
}

function makeFantasyPick(state: FranchiseState, playerId?: string): FranchiseState {
  const draft = state.fantasyDraft;
  if (!draft) return state;
  let index = draft.nextPick;
  if (index >= draft.pickOrder.length) return { ...state, fantasyDraft: undefined };
  const teamId = draft.pickOrder[index];
  const isUser = teamId === state.userTeamId;
  const roster = state.teams.find(team => team.id === teamId)?.roster ?? [];
  const preferred = positions.find(position => !roster.some(player => player.position === position));
  const best = draft.available.find(player => player.id === playerId) ?? (preferred ? draft.available.find(player => player.position === preferred) : undefined) ?? draft.available[0];
  if (!best) return { ...state, fantasyDraft: undefined };
  if (isUser && !playerId) return state;
  const round = picksRound(draft.picks, teamId);
  const picks = [...draft.picks, { teamId, playerId: best.id, round }];
  const available = draft.available.filter(player => player.id !== best.id);
  const teams = state.teams.map(team => team.id === teamId ? { ...team, roster: [...team.roster, best] } : team);
  const updated = { ...state, teams, fantasyDraft: { ...draft, available, picks, nextPick: index + 1 } };
  if (updated.fantasyDraft.nextPick >= updated.fantasyDraft.pickOrder.length) {
    const completed = withNews({ ...updated, fantasyDraft: undefined }, 'Fantasy draft complete. Your season is ready.');
    return completed;
  }
  return updated;
}

function picksRound(picks: FantasyDraft['picks'], teamId: string) {
  return picks.filter(pick => pick.teamId === teamId).length + 1;
}

function advanceCpuPicks(state: FranchiseState): FranchiseState {
  let next = state;
  while (next.fantasyDraft && next.fantasyDraft.pickOrder[next.fantasyDraft.nextPick] !== next.userTeamId) next = makeFantasyPick(next);
  return next;
}

export function draftFantasyPlayer(state: FranchiseState, playerId: string): FranchiseState {
  const draft = state.fantasyDraft;
  if (!draft) throw new Error('There is no fantasy draft in progress.');
  if (draft.pickOrder[draft.nextPick] !== state.userTeamId) throw new Error('Your team is not on the clock.');
  if (!draft.available.some(player => player.id === playerId)) throw new Error('That player is no longer available.');
  return advanceCpuPicks(makeFantasyPick(state, playerId));
}

export function addExpansionTeam(state: FranchiseState, team: Team): FranchiseState {
  if (state.phase !== 'offseason') throw new Error('Expansion teams join in the offseason.');
  if (state.teams.length >= 40) throw new Error('There are already 40 teams in the league.');
  if (state.teams.some(({ id, abbreviation }) => id === team.id || abbreviation.toLowerCase() === team.abbreviation.toLowerCase())) {
    throw new Error('The expansion team needs a distinct ID and abbreviation.');
  }
  const existingIds = new Set([...state.teams.flatMap(({ roster }) => roster), ...state.freeAgents, ...state.prospects].map(({ id }) => id));
  const starter = structuredClone(team);
  if (starter.roster.length > rosterLimit || new Set(starter.roster.map(({ id }) => id)).size !== starter.roster.length
    || starter.roster.some(({ id }) => existingIds.has(id))) throw new Error('The expansion roster contains unavailable players.');
  const teams = state.teams.map((candidate) => ({ ...candidate, roster: [...candidate.roster] }));
  const available = teams.flatMap((candidate) => [...candidate.roster].sort((a, b) => b.overall - a.overall).slice(8)
    .map((player) => ({ team: candidate, player }))).sort((a, b) => b.player.overall - a.player.overall);
  const selected = new Set<string>();
  for (const candidate of available) {
    if (starter.roster.length >= rotationMinimum) break;
    if (selected.has(candidate.team.id)) continue;
    selected.add(candidate.team.id);
    starter.roster.push(candidate.player);
    candidate.team.roster = candidate.team.roster.filter(({ id }) => id !== candidate.player.id);
  }
  while (starter.roster.length < rotationMinimum) {
    const index = starter.roster.length;
    starter.roster.push(playerProfile(`expansion-${state.year}-${team.id}-${index}`, state.seed, positions[index % positions.length], 62, 24));
  }
  const draftPicks = [1, 2].flatMap((round) => [...state.draftPicks.filter((pick) => pick.round === round), { round, teamId: starter.id }]);
  return withNews({ ...state, teams: [...teams, starter], draftPicks }, `The ${starter.city} ${starter.name} joined the league.`);
}

export function progressRosters(state: FranchiseState): FranchiseState {
  const random = seededRandom(state.seed ^ state.year ^ 0xd47);
  const contractExtensions = { ...state.contractExtensions };
  const waivedSalary = (state.waivedSalary ?? []).flatMap((waived) => {
    if (waived.startsIn) return [{ ...waived, startsIn: waived.startsIn - 1 }];
    return waived.years > 1 ? [{ ...waived, years: waived.years - 1 }] : [];
  });
  const freeAgents = state.freeAgents.filter(({ age }) => age < 38)
    .map((player) => ({ ...player, age: player.age + 1 }));
  const progressed = state.teams.map((team) => {
    const roster: Player[] = [];
    const pendingExtensions: Player[] = [];
    for (const player of team.roster) {
      if (player.id.startsWith(`rookie-${state.year + 1}-`)) {
        roster.push(player);
        continue;
      }
      const age = player.age + 1;
      if (age >= 36 && random() < (age - 35) * 0.16) {
        delete contractExtensions[player.id];
        continue;
      }
      const development = (hash(`${player.id}-development`) % 100) / 100;
      const projectionRisk = player.id.startsWith('rookie-') && age < 27 ? development : 0.5;
      const ceiling = player.potential + (projectionRisk > 0.89 ? 5 : projectionRisk < 0.18 ? -7 : 0);
      const naturalChange = age <= 25 ? Math.min(5, Math.max(0, (ceiling - player.overall) * 0.24))
        : age < 30 ? 0.25 : -(age - 28) * 0.4;
      const change = Math.round(naturalChange + (random() - 0.5) * 2.4);
      const overall = clampRating(player.overall + change);
      const ratings = { ...player.ratings, ...Object.fromEntries(ratingKeys.map((key) => [key, clampRating(player.ratings[key] + change)])) };
      const years = Math.max(0, (player.years ?? 2) - 1);
      const developed = { ...player, age, overall, ratings, years, potential: Math.max(player.potential, overall) };
      if (years > 0) roster.push(developed);
      else if (contractExtensions[player.id]) {
        roster.push({ ...developed, ...contractExtensions[player.id] });
        delete contractExtensions[player.id];
      } else pendingExtensions.push(developed);
    }
    pendingExtensions.sort((a, b) => b.overall - a.overall);
    const deadMoney = waivedSalary.filter((waived) => waived.teamId === team.id && !waived.startsIn)
      .reduce((total, waived) => total + waived.salary, 0);
    let payroll = roster.reduce((total, player) => total + salary(player), deadMoney);
    for (const player of pendingExtensions) {
      const annualSalary = Math.max(minimumSalary, Math.round(salary(player) * (player.overall >= 80 ? 1.07 : 0.96)));
      if (team.id !== state.userTeamId && payroll + annualSalary <= state.salaryCap && (roster.length < rotationMinimum || player.overall >= 80)) {
        roster.push({ ...player, salary: annualSalary, years: 2 });
        payroll += annualSalary;
      } else {
        freeAgents.push(player);
      }
    }
    return { ...team, roster };
  });
  freeAgents.sort((a, b) => b.overall - a.overall);
  const teams = progressed.map((team) => {
    const target = team.id === state.userTeamId ? 5 : rotationMinimum;
    while (team.roster.length < target) {
      const player = team.id !== state.userTeamId ? freeAgents.shift() : undefined;
      if (player) {
        team.roster.push({ ...player, salary: minimumSalary, years: 1 });
        continue;
      }
      const index = team.roster.length;
      team.roster.push(playerProfile(`reserve-${state.year + 1}-${team.id}-${index}`, state.seed, positions[index % positions.length], 58, 24));
    }
    return team;
  });
  return { ...state, teams, freeAgents, waivedSalary, contractExtensions };
}
