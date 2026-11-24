import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameState } from '../packages/contracts/index.ts';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import {
  addExpansionTeam, advanceOffseason, conductFantasyDraft, createFranchise, createPlayedBoxScore, draftProspect, extendContract, findTradeTargets, generateSchedule, getCapSheet,
  getInjuryReport, getNextUserGame, getSeasonLeaders, getStandings, getTeamForGame, loadFranchise, recordGameResult, saveFranchise, scoutProspect, setTeamRotation, signFreeAgent,
  simulateDays, simulateNextDay, simulateToEnd, tradePlayers, waivePlayer,
} from '../packages/franchise/index.ts';

const makeLeague = (size: number) => Array.from({ length: size }, (_, index) =>
  fixtureTeam(`team-${index}`, index % 2 ? 'West' : 'East'));

for (const size of [30, 32, 36, 40]) {
  test(`schedules ${size} teams for 82 balanced games`, () => {
    const teamIds = makeLeague(size).map(({ id }) => id);
    const games = generateSchedule(teamIds, 82, 2026, 42);
    assert.equal(games.length, size * 41);
    assert.equal(new Set(games.map(({ id }) => id)).size, games.length);
    for (const id of teamIds) {
      assert.equal(games.filter(({ homeId }) => homeId === id).length, 41);
      assert.equal(games.filter(({ awayId }) => awayId === id).length, 41);
      const fixtureDays = games.filter(({ homeId, awayId }) => homeId === id || awayId === id).map(({ day }) => day);
      assert.equal(new Set(fixtureDays).size, 82);
      for (const opponent of teamIds.filter((candidate) => candidate !== id)) {
        const atHome = games.filter(({ homeId, awayId }) => homeId === id && awayId === opponent).length;
        const onRoad = games.filter(({ homeId, awayId }) => homeId === opponent && awayId === id).length;
        assert.ok(Math.abs(atHome - onRoad) <= 1);
      }
    }
  });
}

test('preserves a live score, finishes deterministic playoffs and starts a fresh season', () => {
  const initial = createFranchise(makeLeague(32), { seasonLength: 24, seed: 81, playoffBestOf: 3 });
  const opener = getNextUserGame(initial)!;
  const scored = recordGameResult(initial, opener.id, 108, 98);
  assert.equal(initial.schedule[0].homeScore, undefined);
  assert.throws(() => recordGameResult(scored, opener.id, 100, 98), /no longer available/);
  assert.equal(getStandings(scored).find(({ teamId }) => teamId === opener.homeId)?.wins, 1);
  assert.equal(getStandings(scored).find(({ teamId }) => teamId === opener.awayId)?.losses, 1);
  assert.equal(simulateNextDay(scored).day, 2);

  const finished = simulateToEnd(scored);
  assert.deepEqual(finished, simulateToEnd(scored));
  assert.equal(finished.phase, 'offseason');
  assert.equal(finished.playoffs.length, 15);
  assert.ok(finished.playoffs.every(({ homeWins, awayWins, winnerId }) => winnerId && Math.max(homeWins, awayWins) === 2));
  assert.ok(finished.standings.every(({ wins, losses }) => wins + losses === 24));
  assert.equal(finished.history[0].championId, finished.playoffs.at(-1)?.winnerId);
  const next = advanceOffseason(finished);
  assert.equal(next.year, 2027);
  assert.equal(next.day, 1);
  assert.equal(next.phase, 'regular');
  assert.ok(next.standings.every(({ wins, losses }) => wins + losses === 0));
  assert.equal(simulateToEnd(next).history.length, 2);
});

test('supports odd expansion and saves an actionable offseason', () => {
  const finished = simulateToEnd(createFranchise(makeLeague(6), { seasonLength: 7, playoffBestOf: 1 }));
  const prospect = finished.prospects[0];
  const scouted = scoutProspect(finished, prospect.id);
  assert.equal(scouted.prospects[0].projectedOverall, prospect.overall);
  assert.equal(scouted.prospects[0].scouted, true);
  assert.ok(scouted.prospects[0].report?.combine.wingspan);
  assert.ok(scouted.prospects[0].report!.potentialLow <= scouted.prospects[0].report!.potentialHigh);
  const drafted = draftProspect(scouted, prospect.id);
  assert.ok(drafted.teams.find(({ id }) => id === drafted.userTeamId)?.roster.some(({ id }) => id === prospect.id));
  const expansion = addExpansionTeam(drafted, { ...fixtureTeam('nova', 'West'), roster: [] });
  assert.equal(expansion.teams.length, 7);
  assert.equal(expansion.teams.at(-1)?.roster.length, 10);

  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveFranchise(storage, 'league', expansion);
  const restored = loadFranchise(storage, 'league');
  assert.ok(restored);
  assert.equal(restored.history[0].championId, expansion.history[0].championId);
  const next = advanceOffseason(restored);
  assert.equal(next.seasonLength, 8);
  assert.equal(next.schedule.length, 28);
  assert.equal(simulateToEnd(next).phase, 'offseason');
  values.set('league', '{wrong');
  assert.equal(loadFranchise(storage, 'league'), null);
});

test('fantasy draft redistributes original players and cap rules validate transactions', () => {
  const initial = createFranchise(makeLeague(4), { seasonLength: 4, salaryCap: 52_000_000 });
  const id = initial.userTeamId;
  const first = initial.teams[0].roster[0];
  const second = initial.teams[1].roster[0];
  const traded = tradePlayers(initial, id, [first.id], initial.teams[1].id, [second.id]);
  assert.ok(traded.teams[0].roster.some((player) => player.id === second.id));
  assert.ok(initial.teams[0].roster.some((player) => player.id === first.id));
  const freeAgent = traded.freeAgents[0];
  assert.throws(() => signFreeAgent(traded, id, freeAgent.id, 3_000_000, 2), /cap space/);
  const signed = signFreeAgent(traded, id, freeAgent.id, 1_250_000, 2);
  assert.equal(getCapSheet(signed, id).payroll, 51_250_000);
  assert.ok(!signed.freeAgents.some((player) => player.id === freeAgent.id));

  const fantasy = conductFantasyDraft(initial);
  const getIds = (state: typeof initial) => state.teams.flatMap(({ roster }) => roster.map(({ id }) => id)).sort();
  assert.deepEqual(getIds(initial), getIds(fantasy));
  assert.ok(fantasy.teams.some(({ id, roster }) => roster.some((player) => !player.id.startsWith(id))));
  assert.throws(() => conductFantasyDraft(simulateNextDay(initial)), /before the first game/);
});


test('hosts a six-game play-in without changing the regular-season records', () => {
  const initial = createFranchise(makeLeague(30), { seasonLength: 8, playoffBestOf: 1 });
  const playIn = simulateDays(initial, 8);
  assert.equal(playIn.phase, 'playoffs');
  assert.equal(playIn.day, 9);
  assert.equal(playIn.schedule.filter(({ stage }) => stage === 'play-in').length, 4);
  const secondDate = simulateNextDay(playIn);
  assert.equal(secondDate.schedule.filter(({ stage }) => stage === 'play-in').length, 6);
  const bracket = simulateNextDay(secondDate);
  assert.equal(bracket.playoffs.length, 8);
  assert.deepEqual(bracket.standings, playIn.standings);
  const playInGames = bracket.schedule.filter(({ stage }) => stage === 'play-in');
  for (const suffix of ['upper', 'final']) {
    for (const game of playInGames.filter(({ id }) => id.endsWith(suffix))) {
      const winner = game.homeScore! > game.awayScore! ? game.homeId : game.awayId;
      assert.ok(bracket.playoffs.some(({ homeId, awayId }) => homeId === winner || awayId === winner));
    }
  }
});


test('derives simulated team totals from the configured rotation and records season awards', () => {
  const initial = createFranchise(makeLeague(6), { seasonLength: 12, playoffBestOf: 1 });
  const rotation = initial.teams[0].roster.slice(2, 9).map(({ id }) => id);
  const adjusted = setTeamRotation(initial, initial.userTeamId, rotation);
  const opener = getNextUserGame(adjusted)!;
  const played = simulateNextDay(adjusted);
  const result = played.schedule.find(({ id }) => id === opener.id)!;
  const box = result.boxScore!;
  assert.equal(box.source, 'simulated');
  const playerBox = opener.homeId === initial.userTeamId ? box.home : box.away;
  assert.deepEqual(playerBox.map(({ playerId }) => playerId), rotation);
  for (const [score, players] of [[result.homeScore, box.home], [result.awayScore, box.away]] as const) {
    assert.equal(players.reduce((total, { points }) => total + points, 0), score);
    assert.equal(players.reduce((total, { minutes }) => total + minutes, 0), 240);
    for (const player of players) {
      assert.equal(player.fieldGoalsMade * 2 + player.threesMade + player.freeThrowsMade, player.points);
      assert.ok(player.fieldGoalsAttempted >= player.fieldGoalsMade);
    }
  }
  const finished = simulateToEnd(played);
  assert.equal(getSeasonLeaders(finished, 'points', 3).length, 3);
  assert.ok(finished.history[0].awards?.some(({ title }) => title === 'Most Valuable Player'));
  assert.equal(advanceOffseason(finished).seasonStats && Object.keys(advanceOffseason(finished).seasonStats!).length, 0);
});


test('runs a weighted lottery among clubs missing the playoffs', () => {
  const initial = createFranchise(makeLeague(30), { seasonLength: 8, playoffBestOf: 1 });
  const finished = simulateToEnd(initial);
  const lottery = finished.lottery!;
  assert.equal(lottery.length, 14);
  assert.deepEqual(lottery, simulateToEnd(initial).lottery);
  assert.ok(Math.abs(lottery.reduce((total, { firstPickChance }) => total + firstPickChance, 0) - 1) < 0.0001);
  const playoffTeams = finished.playoffs.flatMap(({ homeId, awayId }) => [homeId, awayId]);
  assert.ok(lottery.every(({ teamId }) => !playoffTeams.includes(teamId)));
  assert.deepEqual(finished.draftPicks.slice(0, 14).map(({ teamId }) => teamId), lottery.map(({ teamId }) => teamId));
});


test('rolls guaranteed waivers and future extensions across seasons', () => {
  const teams = makeLeague(4);
  teams[0].roster[0].years = 1;
  const initial = createFranchise(teams, { seasonLength: 4, playoffBestOf: 1, salaryCap: 35_000_000 });
  const team = initial.teams[0];
  const [extender, release] = team.roster;
  assert.ok(getCapSheet(initial, team.id).luxuryTax > 0);
  assert.ok(findTradeTargets(initial, team.id, extender.id, { position: 'PG', minOverall: 75 }).length);
  const extended = extendContract(initial, team.id, extender.id, 6_000_000, 3);
  assert.equal(getCapSheet(extended, team.id).payroll, getCapSheet(initial, team.id).payroll);
  const waived = waivePlayer(extended, team.id, release.id);
  assert.equal(getCapSheet(waived, team.id).deadMoney, release.salary);
  assert.equal(getCapSheet(waived, team.id).payroll, getCapSheet(initial, team.id).payroll);
  const next = advanceOffseason(simulateToEnd(waived));
  const contracted = next.teams[0].roster.find(({ id }) => id === extender.id);
  assert.equal(contracted?.salary, 6_000_000);
  assert.equal(contracted?.years, 3);
  assert.equal(getCapSheet(next, team.id).deadMoney, release.salary);
});


test('records final gameplay events as played franchise statistics', () => {
  const initial = createFranchise(makeLeague(2), { seasonLength: 4 });
  const game = getNextUserGame(initial)!;
  const home = initial.teams.find(({ id }) => id === game.homeId)!;
  const away = initial.teams.find(({ id }) => id === game.awayId)!;
  const profile = home.roster[0];
  const gameplay = {
    tick: 240, clock: 0, period: 4, config: { periodSeconds: 90, periods: 4 },
    players: [{ id: profile.id }], events: [], teams: [home, away],
  } as unknown as GameState;
  const box = createPlayedBoxScore(gameplay, [{
    side: 0, id: profile.id, name: profile.name, points: 3, makes: 1, attempts: 2, threeMakes: 1, threeAttempts: 2,
    freeThrows: 0, freeThrowAttempts: 0, assists: 0, rebounds: 0, steals: 0, blocks: 0, turnovers: 0,
  }]);
  assert.equal(box.home[0].minutes, 6);
  const played = recordGameResult(initial, game.id, 3, 0, box);
  assert.equal(played.schedule[0].boxScore?.source, 'played');
  assert.equal(played.seasonStats?.[profile.id].points, 3);
});


test('breaks a tie by head-to-head record before point differential', () => {
  const input = createFranchise(makeLeague(4), { seasonLength: 4 });
  const fixture = input.schedule.find(({ homeId, awayId }) => [homeId, awayId].includes('team-0') && [homeId, awayId].includes('team-2'))!;
  const state = {
    ...input,
    schedule: [{ ...fixture, homeScore: 100, awayScore: 99 }],
    standings: input.standings.map((team) => ({ ...team, wins: 2, losses: 2, pointsFor: team.teamId === fixture.awayId ? 200 : 150, pointsAgainst: 150 })),
  };
  assert.equal(getStandings(state, 'East')[0].teamId, fixture.homeId);
});

test('removes an injured player from the rotation until their return date', () => {
  const league = createFranchise(makeLeague(6), { seasonLength: 10, injuries: false });
  const team = league.teams[0];
  const player = team.roster[0];
  const injured = { ...league, injuries: { [player.id]: {
    playerId: player.id, name: player.name, description: 'ankle sprain', day: 0, returnDay: 3,
  } } };
  assert.equal(getInjuryReport(injured, team.id).length, 1);
  assert.ok(!getTeamForGame(injured, team.id).roster.some(({ id }) => id === player.id));
  const returned = simulateDays(injured, 2);
  assert.equal(getInjuryReport(returned, team.id).length, 0);
  assert.ok(getTeamForGame(returned, team.id).roster.some(({ id }) => id === player.id));
});
