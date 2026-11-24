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

test('dribble move produces lateral separation and step-back burst', () => {
  const lat = engine();
  lat.state.players[0].position = { x: 6, z: 0 };
  lat.step({ 'home-0': { move: { x: 0, z: 1 }, dribble: true } });
  assert.ok(lat.state.players[0].velocity.z > 2.2);
  assert.ok(lat.state.players[0].stamina < 98.5);
  for (let i = 0; i < 6; i++) lat.step({ 'home-0': { move: { x: 0, z: 1 } } });
  assert.ok(lat.state.players[0].position.z > 0.45);

  const stepBack = engine();
  stepBack.state.players[0].position = { x: 6, z: 0 };
  stepBack.step({ 'home-0': { move: { x: -1, z: 0 }, dribble: true } });
  assert.ok(stepBack.state.players[0].velocity.x < -2.4);
});

test('pump fake lifts contesting defender without shooting and early pass cancels charge', () => {
  const g = engine();
  const [shooter, defender] = [g.state.players[0], g.state.players[5]];
  shooter.position = { x: 8, z: 0 };
  defender.position = { x: 9.2, z: 0 };
  for (let i = 0; i < 5; i++) g.step({ [shooter.id]: { ...cmd, shoot: true }, [defender.id]: { ...cmd, contest: true } });
  g.step({ [shooter.id]: { ...cmd, pumpFake: true }, [defender.id]: { ...cmd, contest: true } });
  assert.equal(g.state.ball.ownerId, shooter.id);
  assert.equal(shooter.pose, 'pumpFake');
  assert.equal(g.state.events.filter(e => e.type === 'shot').length, 0);
  g.step({ [shooter.id]: cmd, [defender.id]: cmd });
  assert.equal(defender.pose, 'contest');

  const cancel = engine();
  const [passer, receiver] = [cancel.state.players[0], cancel.state.players[1]];
  passer.position = { x: 4, z: 2 };
  receiver.position = { x: 6, z: -2 };
  for (let i = 0; i < 5; i++) cancel.step({ [passer.id]: { ...cmd, shoot: true } });
  cancel.step({ [passer.id]: { ...cmd, pass: true, targetId: receiver.id } });
  assert.equal(cancel.state.ball.kind, 'pass');
  assert.equal(cancel.state.events.filter(e => e.type === 'shot').length, 0);
});

test('angled layup banks cleanly off the backboard and scores', () => {
  const g = engine({ seed: 17 });
  const p = g.state.players[0];
  p.position = { x: 11.4, z: 2.0 };
  for (let i = 0; i < 37; i++) g.step({ [p.id]: { ...cmd, shoot: true } });
  g.step();
  assert.equal(g.state.shotFeedback?.bank, true);
  for (let i = 0; i < 90; i++) g.step();
  assert.deepEqual(g.state.score, [2, 0]);
});

test('lob alley-oop converts near the rim and bounce pass arrives cleanly', () => {
  const g = engine();
  const [passer, cutter] = [g.state.players[0], g.state.players[1]];
  passer.position = { x: 5, z: 3 };
  cutter.position = { x: 11.1, z: 0.4 };
  g.step({ [passer.id]: { ...cmd, pass: true, targetId: cutter.id, passType: 'lob' } });
  assert.equal(g.state.ball.kind, 'pass');
  for (let i = 0; i < 90; i++) g.step({ [cutter.id]: { ...cmd, shoot: true } });
  assert.ok(g.state.events.some(e => e.type === 'shot' && e.detail === 'Alley-oop'));
  for (let i = 0; i < 60; i++) g.step();
  assert.deepEqual(g.state.score, [2, 0]);

  const b = engine();
  const [bp, br] = [b.state.players[0], b.state.players[1]];
  bp.position = { x: 4, z: 3 };
  br.position = { x: 8, z: -1 };
  b.step({ [bp.id]: { ...cmd, pass: true, targetId: br.id, passType: 'bounce' } });
  for (let i = 0; i < 70; i++) b.step();
  assert.equal(b.state.ball.ownerId, br.id);
});

test('and-one layups and five team fouls trigger regulation bonus and period reset', () => {
  let sawAndOne = false;
  for (let seed = 1; seed < 250 && !sawAndOne; seed++) {
    const roster = structuredClone(teams);
    roster[0].roster[0].ratings.finishing = 95;
    roster[0].roster[0].ratings.strength = 95;
    const g = createEngine(roster, { playersPerTeam: 1, seed });
    const [shooter, defender] = g.state.players;
    shooter.position = { x: 11.4, z: 0 };
    defender.position = { x: 12.15, z: 0 };
    for (let i = 0; i < 37; i++) g.step({ [shooter.id]: { ...cmd, shoot: true }, [defender.id]: { ...cmd, contest: true } });
    g.step({ [defender.id]: { ...cmd, contest: true } });
    if (g.state.events.some(e => e.type === 'foul' && e.detail?.includes('And-1'))) {
      for (let i = 0; i < 80; i++) g.step();
      if (g.state.score[0] === 2) {
        assert.equal(g.state.freeThrow?.andOne, true);
        assert.equal(g.state.freeThrow?.remaining, 1);
        sawAndOne = true;
      }
    }
  }
  assert.ok(sawAndOne, 'should observe an And-1 play');

  const bonus = engine({ seed: 11 });
  const [handler, pest] = [bonus.state.players[0], bonus.state.players[5]];
  for (let t = 0; t < 6000 && (bonus.state.teamFouls?.[1] ?? 0) < 5; t++) {
    bonus.state.clock = 300;
    bonus.state.shotClock = 24;
    if (bonus.state.phase === 'live') {
      handler.position = { x: 2, z: 0 };
      pest.position = { x: 2.8, z: 0 };
      if (bonus.state.ball.ownerId === pest.id) {
        bonus.step({ [pest.id]: { ...cmd, pass: true } });
        continue;
      }
      bonus.step({ [pest.id]: { ...cmd, steal: true } });
      if (bonus.state.ball.ownerId && bonus.state.ball.ownerId !== handler.id) {
        const cur = bonus.state.players.find(q => q.id === bonus.state.ball.ownerId)!;
        if (cur.side === 1) { bonus.state.ball.ownerId = handler.id; bonus.state.possession = 0; }
      }
    } else {
      bonus.step();
    }
  }
  assert.ok((bonus.state.teamFouls?.[1] ?? 0) >= 5);
  assert.ok(bonus.state.events.some(e => e.detail?.includes('Bonus (2 FT)')));
  while (bonus.state.freeThrow || bonus.state.phase === 'dead') bonus.step();
  bonus.state.clock = 1 / 60;
  bonus.step();
  assert.deepEqual(bonus.state.teamFouls, [0, 0]);
});

test('contesting and low stamina slow horizontal movement', () => {
  const free = engine();
  const contesting = engine();
  const fatigued = engine();
  fatigued.state.players[0].stamina = 5;
  for (let i = 0; i < 20; i++) {
    free.step({ 'home-0': { move: { x: 0, z: 1 } } });
    contesting.step({ 'home-0': { move: { x: 0, z: 1 }, contest: true } });
    fatigued.step({ 'home-0': { move: { x: 0, z: 1 } } });
  }
  assert.ok(contesting.state.players[0].position.z < free.state.players[0].position.z);
  assert.ok(fatigued.state.players[0].position.z < free.state.players[0].position.z);
});
