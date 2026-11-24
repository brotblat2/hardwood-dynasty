import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { GameEvent, GameState, Team } from '../packages/contracts/index.ts';
import { parseRosterCsv, validateRoster } from '../packages/roster-data/index.ts';
import { summarizeGame } from '../packages/analytics/index.ts';

const roster = () => ({ version: 1 as const, source: 'test', updatedAt: '2026-01-15T00:00:00.000Z', teams: [fixtureTeam('east'), fixtureTeam('west', 'West')] });

test('validates roster packs and rejects malformed team and player data', () => {
  const pack = roster();
  assert.equal(validateRoster(pack).teams.length, 2);
  assert.throws(() => validateRoster({ ...pack, updatedAt: 'yesterday' }), /valid updatedAt date/);
  assert.throws(() => validateRoster({ ...pack, teams: [pack.teams[0]] }), /2 to 40 teams/);

  const duplicateTeam = roster();
  duplicateTeam.teams[1].id = duplicateTeam.teams[0].id;
  assert.throws(() => validateRoster(duplicateTeam), /unique ID/);

  const invalidPlayer = roster();
  invalidPlayer.teams[0].roster[0].ratings.shooting = 100;
  assert.throws(() => validateRoster(invalidPlayer), /ten ratings/);
});

test('parses quoted CSV fields and validates imported rows', () => {
  const pack = roster();
  const header = ['teamId','city','teamName','abbreviation','color','accent','conference','playerId','playerName','number','position','height','age','overall','potential','salary','years','shooting','finishing','passing','handling','rebounding','speed','perimeter','interior','iq','durability'];
  const rows = pack.teams.flatMap(team => team.roster.map(player => [team.id, team.city, team.name, team.abbreviation, team.color, team.accent, team.conference, player.id, player.name, player.number, player.position, player.height, player.age, player.overall, player.potential, player.salary, player.years, ...Object.values(player.ratings)]));
  const csv = [header, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const parsed = parseRosterCsv('\uFEFF' + csv, 'CSV test', '2026-01-15T00:00:00.000Z');
  assert.equal(parsed.teams.length, 2);
  assert.equal(parsed.teams[0].roster[0].name, 'Player 1');
  assert.equal(parsed.teams[0].roster.length, 10);
  assert.throws(() => parseRosterCsv(csv.replace('"75"', '"oops"'), 'CSV test', '2026-01-15'), /Invalid or duplicate player/);
  assert.throws(() => parseRosterCsv('a,b\n"unfinished,b', 'CSV test', '2026-01-15'), /Unclosed quoted field/);
});

test('summarizes shooting splits and box-score events', () => {
  const teams: [Team, Team] = [fixtureTeam('home'), fixtureTeam('away', 'West')];
  const [shooter, passer] = teams[0].roster;
  const events: GameEvent[] = [
    { tick: 1, type: 'shot', side: 0, playerId: shooter.id, points: 3, position: { x: 8, z: 0 } },
    { tick: 2, type: 'score', side: 0, playerId: shooter.id, points: 3 },
    { tick: 2, type: 'assist', side: 0, playerId: passer.id },
    { tick: 3, type: 'shot', side: 0, playerId: shooter.id, points: 2, position: { x: 4, z: 0 } },
    { tick: 4, type: 'miss', side: 0, playerId: shooter.id },
    { tick: 5, type: 'shot', side: 0, playerId: shooter.id, points: 1 },
    { tick: 6, type: 'score', side: 0, playerId: shooter.id, points: 1 },
    { tick: 7, type: 'rebound', side: 0, playerId: passer.id },
    { tick: 8, type: 'steal', side: 0, playerId: passer.id },
    { tick: 9, type: 'block', side: 0, playerId: passer.id },
    { tick: 10, type: 'turnover', side: 0, playerId: shooter.id },
  ];
  const state = { teams, events, config: {} } as GameState;
  const summary = summarizeGame(state);
  const box = summary.players.find(player => player.id === shooter.id)!;
  assert.equal(box.points, 4);
  assert.equal(box.attempts, 2);
  assert.equal(box.makes, 1);
  assert.equal(box.threeAttempts, 1);
  assert.equal(box.threeMakes, 1);
  assert.equal(box.freeThrowAttempts, 1);
  assert.equal(box.freeThrows, 1);
  assert.equal(box.effectiveFieldGoal, 0.75);
  assert.equal(box.trueShooting, 4 / (2 * 2.44));
  assert.equal(box.turnovers, 1);
  assert.equal(summary.players.find(player => player.id === passer.id)?.assists, 1);
  assert.equal(summary.players.find(player => player.id === passer.id)?.rebounds, 1);
  assert.equal(summary.players.find(player => player.id === passer.id)?.steals, 1);
  assert.equal(summary.players.find(player => player.id === passer.id)?.blocks, 1);
  assert.deepEqual(summary.shots.map(shot => shot.made), [true, false]);
});
