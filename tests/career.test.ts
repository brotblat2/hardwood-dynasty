import test from 'node:test';
import assert from 'node:assert/strict';
import { careerLineup, completeCombine, createCareer, draftPlayer, recordCareerGame, trainingCost, trainPlayer } from '../packages/career/index.ts';
import type { Team } from '../packages/contracts/index.ts';

const input = { name: 'Avery Lane', position: 'PG', height: 1.9, archetype: 'Playmaker', path: 'College', seed: 42 } as const;
const stats = { points: 15, assists: 6, rebounds: 3, won: true };
const team: Team = { id: 'otters', city: 'Cascadia', name: 'Otters', abbreviation: 'OTT', color: 'blue', accent: 'red', conference: 'West', roster: [] };

test('career game, combine, draft, training and seasons persist across serialization', () => {
  const initial = createCareer(input);
  const showcase = recordCareerGame(initial, stats);
  assert.equal(showcase.stage, 'combine');
  assert.equal(initial.xp, 0);
  const workout = completeCombine(showcase, 88, 'Team');
  assert.ok(workout.chemistry > showcase.chemistry);
  const rookie = draftPlayer(workout,[team]);
  assert.equal(rookie.teamId, team.id);
  assert.equal(rookie.stage, 'rookie');
  const trained = trainPlayer(rookie, 'shooting');
  assert.equal(trained.xp, rookie.xp - trainingCost(rookie, 'shooting'));
  assert.equal(trained.player.ratings.shooting, rookie.player.ratings.shooting + 1);
  let league = trained;
  for (let i = 0; i < 82; i++) league = recordCareerGame(JSON.parse(JSON.stringify(league)), stats);
  assert.equal(league.season, 2);
  assert.equal(league.totals.assists, 82 * stats.assists);
  assert.equal(league.games, 82);
  assert.equal(league.trust, 100);
});

test('position, height and archetype change the built player', () => {
  const guard = createCareer(input);
  const center = createCareer({ ...input, position: 'C', height: 2.17, archetype: 'Anchor', path: 'International' });
  assert.ok(center.player.ratings.interior > guard.player.ratings.interior);
  assert.ok(center.player.ratings.speed < guard.player.ratings.speed);
  assert.ok(center.player.ratings.passing < guard.player.ratings.passing);
  assert.equal(trainPlayer(guard,'shooting'), guard);
  assert.equal(draftPlayer(guard,[team]), guard);
});

test('career player starts in position and preserves the other starters', () => {
  const c = createCareer(input);
  const original = { ...team, roster: (['SG','SF','PG','PF','C'] as const).map((position,i) => ({ ...c.player, position, id: 'p'+i })) };
  const lineup = careerLineup(c, original);
  assert.deepEqual(lineup.roster.slice(0,5).map(p => p.id), ['p0','p1',c.player.id,'p3','p4']);
  assert.equal(original.roster.length, 5);
  assert.equal(lineup.roster.length, 6);
  assert.equal(careerLineup(c,lineup).roster.filter(p => p.id === c.player.id).length,1);
});
