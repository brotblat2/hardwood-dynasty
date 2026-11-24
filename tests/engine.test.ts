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

function physiqueGame(height: number, weight: number, strength: number, seed = 17) {
  const roster = structuredClone(teams);
  const profile = roster[0].roster[0];
  profile.height = height;
  Object.assign(profile, { weight });
  Object.assign(profile.ratings, { strength });
  return createEngine(roster, { playersPerTeam: 1, seed });
}

test('horizontal acceleration responds to mass and screen resistance responds separately to strength and mass', () => {
  function displacement(weight: number, strength: number, screen: boolean) {
    const game = physiqueGame(2, weight, strength);
    const [a, b] = game.state.players;
    a.position = { x: 0, z: 0 }; b.position = { x: 0.32, z: 0 };
    game.step({ [a.id]: { ...cmd, screen } });
    return -a.position.x;
  }
  assert.ok(displacement(120, 80, true) < displacement(75, 80, true));
  assert.ok(displacement(95, 95, true) < displacement(95, 40, true));
  assert.ok(displacement(95, 70, true) < displacement(95, 70, false));
  const fast = physiqueGame(2, 75, 80), heavy = physiqueGame(2, 120, 80);
  for (const g of [fast, heavy]) g.step({ 'home-0': { move: { x: 0, z: 1 }, sprint: true } });
  assert.ok(fast.state.players[0].velocity.z > heavy.state.players[0].velocity.z);
  assert.ok(fast.state.players[0].stamina > heavy.state.players[0].stamina);
});

test('height independently raises release and permits a high rebound', () => {
  const short = physiqueGame(1.75, 95, 75), tall = physiqueGame(2.2, 95, 75);
  for (const g of [short, tall]) {
    g.step({ 'home-0': { ...cmd, shoot: true } }); g.step();
  }
  assert.ok(tall.state.ball.position.y - short.state.ball.position.y > 0.4);
  for (const height of [1.75, 2.2]) {
    const g = physiqueGame(height, 95, 75);
    g.state.ball = { kind: 'loose', ownerId: null, position: { ...g.state.players[0].position, y: 2.7 }, velocity: { x: 0, y: 0, z: 0 } };
    g.step({ 'home-0': { ...cmd, contest: true } });
    assert.equal(g.state.ball.ownerId, height === 2.2 ? 'home-0' : null);
  }
});

test('over matched seed samples taller contests block more and stronger finishers score more through contact', () => {
  function attempts(height: number, weight: number, strength: number, defenderHeight: number, contest: boolean) {
    let scores = 0, blocks = 0;
    for (let i = 0; i < 160; i++) {
      const g = physiqueGame(height, weight, strength, i * 7919);
      const [p, q] = g.state.players;
      q.profile.height = defenderHeight;
      p.position = { x: 11.45, z: 0 }; q.position = { x: 12.42, z: 0 };
      g.state.charge[p.id] = 0.62;
      g.step({ [q.id]: { ...cmd, contest } });
      if (g.state.events.some(e => e.type === 'block')) blocks++;
      for (let t = 0; t < 35; t++) g.step();
      scores += g.state.score[0];
    }
    return { scores, blocks };
  }
  const tallDefense = attempts(1.95, 95, 75, 2.21, true);
  const shortDefense = attempts(1.95, 95, 75, 1.76, true);
  assert.ok(tallDefense.blocks > shortDefense.blocks);
  assert.ok(tallDefense.scores < shortDefense.scores);
  assert.ok(attempts(1.95, 95, 93, 2, false).scores > attempts(1.95, 95, 38, 2, false).scores);
});

test('imported players with invalid or missing physical measurements stay finite', () => {
  const g = physiqueGame(NaN, Infinity, NaN);
  g.step({ 'home-0': { move: { x: 1, z: 0 }, shoot: true } }); g.step();
  for (const value of Object.values(g.state.ball.position)) assert.ok(Number.isFinite(value));
  assert.ok(Number.isFinite(g.state.players[0].velocity.x));
});
