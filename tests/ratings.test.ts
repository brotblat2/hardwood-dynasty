import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPlayerGrade, loadNbaRosters } from '../packages/roster-data/nba.ts';
import { gradeNbaPlayer } from '../packages/roster-data/ratings.ts';

test('all NBA teams open offline with stable athlete IDs and grades', async () => {
  const source = await loadNbaRosters();
  assert.equal(source.teams.length, 30);
  const players = source.teams.flatMap(team => team.roster);
  assert.ok(players.length >= 500);
  assert.equal(new Set(players.map(player => player.id)).size, players.length);
  assert.ok(players.filter(player => player.weight && player.ratings.strength).length > 490);
  assert.ok(players.filter(player => player.gradeEvidence !== 'estimated').length > 490);
  const sga = players.find(player => player.name === 'Shai Gilgeous-Alexander')!;
  assert.ok(sga.overall >= 95 && sga.overall <= 98);
  assert.equal(getPlayerGrade(sga).overall, sga.overall);
  assert.deepEqual(getPlayerGrade(sga).seasons, [2027, 2026]);
  const curry = players.find(player => player.name === 'Stephen Curry')!;
  const jokic = players.find(player => player.name === 'Nikola Jokic')!;
  const wemby = players.find(player => player.name === 'Victor Wembanyama')!;
  assert.ok(curry.ratings.shooting > sga.ratings.shooting);
  assert.ok(jokic.ratings.passing > curry.ratings.passing);
  assert.ok(wemby.ratings.interior > sga.ratings.interior);
});

test('missing NBA statistics produce provisional grades and a visible explanation', () => {
  const grade = gradeNbaPlayer('C', [], 19);
  assert.equal(grade.evidence, 'estimated');
  assert.equal(grade.minutes, 0);
  assert.ok(grade.breakdown[0].detail.includes('No usable'));
});
