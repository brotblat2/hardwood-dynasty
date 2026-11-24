import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { GameConfig, Team } from '../packages/contracts/index.ts';
import { createEngine } from '../packages/game-engine/index.ts';

const teams: [Team, Team] = [fixtureTeam('home'), fixtureTeam('away', 'West')];
const cmd = { move: { x: 0, z: 0 } };
function engine(config: GameConfig = {}) { return createEngine(teams, config); }

test('full teams, configurable sizes, movement, stamina and half court bounds', () => {
  assert.equal(engine().state.players.length, 10);
  const game = engine({ playersPerTeam: 2, mode: 'blacktop' });
  assert.equal(game.state.players.length, 4);
  for (let i = 0; i < 240; i++) game.step({ 'home-0': { move: { x: -5, z: -5 }, sprint: true } });
  assert.ok(game.state.players[0].position.x >= 0);
  assert.ok(game.state.players[0].stamina < 100);
  assert.equal(game.state.clock, 300);
});

test('perfect close release flies, counts two, then changes possession', () => {
  const game = engine(), p = game.state.players[0];
  p.position = { x: 11.5, z: 0 };
  for (let i = 0; i < 37; i++) game.step({ [p.id]: { ...cmd, shoot: true } });
  game.step();
  assert.equal(game.state.ball.kind, 'shot');
  assert.match(game.state.events.at(-1)!.detail!, /Excellent/);
  const resumed = createEngine(teams, undefined, JSON.parse(JSON.stringify(game.state)));
  for (let i = 0; i < 130; i++) { game.step(); resumed.step(); }
  assert.deepEqual(resumed.state, game.state);
  assert.deepEqual(game.state.score, [2, 0]);
  assert.equal(game.state.possession, 1);
});

test('targeted pass, catch and assisted three', () => {
  const game = engine();
  const [passer, receiver] = game.state.players;
  passer.position = { x: 4, z: 3 };
  receiver.position = { x: 4, z: 1 };
  game.step({ [passer.id]: { ...cmd, pass: true, targetId: receiver.id, passType: 'bounce' } });
  assert.equal(game.state.ball.kind, 'pass');
  for (let i = 0; i < 65; i++) game.step();
  assert.equal(game.state.ball.ownerId, receiver.id);
  for (let i = 0; i < 37; i++) game.step({ [receiver.id]: { ...cmd, shoot: true } });
  for (let i = 0; i < 125; i++) game.step();
  assert.deepEqual(game.state.score, [3, 0]);
  assert.equal(game.state.events.find(e => e.type === 'assist')?.playerId, passer.id);
});

test('blacktop target, shot clock violation, regulation overtime and final', () => {
  const street = engine({ mode: 'blacktop', targetScore: 1 });
  street.state.players[0].position = { x: 11.6, z: 0 };
  for (let i = 0; i < 37; i++) street.step({ 'home-0': { ...cmd, shoot: true } });
  for (let i = 0; i < 70; i++) street.step();
  assert.equal(street.state.phase, 'final');
  assert.deepEqual(street.state.score, [1, 0]);
  const game = engine();
  game.state.shotClock = 1 / 60;
  game.step();
  assert.equal(game.state.events.at(-1)?.detail, 'Shot clock violation');
  for (let i = 0; i < 38; i++) game.step();
  assert.equal(game.state.possession, 1);
  game.state.period = 4; game.state.clock = 1 / 60;
  game.step();
  assert.equal(game.state.period, 5);
  for (let i = 0; i < 38; i++) game.step();
  game.state.clock = 1 / 60; game.state.score[1] = 3; game.step();
  assert.equal(game.state.phase, 'final');
});

test('bench changes, timeout and full-court eight-second count', () => {
  const game = engine();
  const sub = { ...cmd, substituteId: 'home-6' };
  game.step({ 'home-0': sub });
  assert.equal(game.state.ball.ownerId, 'home-6');
  assert.equal(game.state.events.at(-1)?.type, 'substitution');
  const timeout = { ...cmd, timeout: true };
  const clock = game.state.shotClock;
  game.step({ 'home-6': timeout });
  assert.equal(game.state.events.at(-1)?.type, 'timeout');
  for (let i = 0; i < 90; i++) game.step();
  assert.equal(game.state.shotClock, clock);
  for (let i = 0; i < 480; i++) game.step();
  assert.equal(game.state.events.at(-1)?.detail, 'Eight-second violation');
});

test('shooting foul awards free throws and freezes game clock until completed', () => {
  const game = engine({ seed: 8 });
  const shooter = game.state.players[0];
  shooter.position = { x: 11.5, z: 0 };
  const defender = game.state.players[5];
  defender.position = { x: 12.27, z: 0 };
  for (let i = 0; i < 37; i++) game.step({ [shooter.id]: { ...cmd, shoot: true }, [defender.id]: { ...cmd, contest: true } });
  game.step({ [defender.id]: { ...cmd, contest: true } });
  assert.equal(game.state.events.at(-1)?.type, 'foul');
  const clock = game.state.clock;
  for (let i = 0; i < 400; i++) game.step();
  assert.equal(game.state.clock, clock);
  for (let i = 0; i < 60; i++) game.step();
  assert.equal(game.state.events.filter(e => e.type === 'shot' && e.detail === 'Free throw').length, 2);
});

test('custom blacktop scoring applies before the target-score check', () => {
  const config = { mode: 'blacktop' as const, scoring: { inside: 2, outside: 3 }, targetScore: 3 };
  const game = engine(config);
  game.state.players[0].position = { x: 3.1, z: -2 };
  for (let i = 0; i < 37; i++) game.step({ 'home-0': { ...cmd, shoot: true } });
  for (let i = 0; i < 120; i++) game.step();
  assert.deepEqual(game.state.score, [3, 0]);
  assert.equal(game.state.phase, 'final');
});
