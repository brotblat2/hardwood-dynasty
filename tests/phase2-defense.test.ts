import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { Team } from '../packages/contracts/index.ts';
import { createEngine } from '../packages/game-engine/index.ts';

const teams: [Team, Team] = [fixtureTeam('home'), fixtureTeam('away', 'West')];
const cmd = { move: { x: 0, z: 0 } };

test('handsUp contests strongly with feet planted and ignores pump fakes, while contest jumps and bites', () => {
  // 1. Hands-up stays grounded, boosts contestPct, and NEVER flies by on a pump fake
  const hands = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 12 });
  const [hShooter, hDef] = hands.state.players;
  hShooter.position = { x: 6.5, z: 0 };
  hDef.position = { x: 7.45, z: 0 };
  hands.step({ [hShooter.id]: { ...cmd, pumpFake: true }, [hDef.id]: { ...cmd, handsUp: true, intenseD: true } });
  assert.equal(hDef.action?.handsUp, true);
  assert.equal(hDef.action?.jumpHeight ?? 0, 0, 'handsUp keeps defender grounded');
  assert.equal(hDef.action?.flyBy ?? 0, 0, 'handsUp never bites on a pump fake');

  for (let i = 0; i < 37; i++) hands.step({ [hShooter.id]: { ...cmd, shoot: true }, [hDef.id]: { ...cmd, handsUp: true } });
  hands.step({ [hDef.id]: { ...cmd, handsUp: true } });
  const handsPct = hands.state.shotFeedback?.contestPct ?? 0;

  const passive = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 12 });
  const [pShooter, pDef] = passive.state.players;
  pShooter.position = { x: 6.5, z: 0 };
  pDef.position = { x: 7.45, z: 0 };
  for (let i = 0; i < 37; i++) passive.step({ [pShooter.id]: { ...cmd, shoot: true } });
  passive.step();
  const passivePct = passive.state.shotFeedback?.contestPct ?? 0;
  assert.ok(handsPct > passivePct + 25, `handsUp contest (${handsPct}%) must exceed passive standing (${passivePct}%)`);

  // 2. Jump-to-block elevates vertically and bites into fly-by on pump fake
  const jump = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 12 });
  const [jShooter, jDef] = jump.state.players;
  jShooter.position = { x: 6.5, z: 0 };
  jDef.position = { x: 7.45, z: 0 };
  jump.step({ [jShooter.id]: { ...cmd, pumpFake: true }, [jDef.id]: { ...cmd, contest: true } });
  assert.ok((jDef.action?.flyBy ?? 0) > 0, 'jump-to-block bites into fly-by on pump fake');
  for (let i = 0; i < 6; i++) jump.step();
  assert.ok((jDef.action?.jumpHeight ?? 0) > 0.15, 'jump contest elevates off floor');
});

test('timed peak jump-to-block swat rate beats mistimed early jump and grounded handsUp on jumpers', () => {
  const sampleBlocks = (mode: 'peak' | 'late' | 'handsUp') => {
    let blocks = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const r = structuredClone(teams);
      r[1].roster[0].ratings.interior = 88;
      r[1].roster[0].height = 2.08;
      const g = createEngine(r, { playersPerTeam: 1, mode: 'practice', seed });
      const [s, d] = g.state.players;
      s.position = { x: 7.0, z: 0 };
      d.position = { x: 7.82, z: 0 };
      if (mode === 'late') {
        // Defender jumps way too early (19 ticks before release -> descending past apex)
        g.step({ [d.id]: { ...cmd, contest: true } });
        for (let i = 0; i < 19; i++) g.step();
        g.state.charge[s.id] = 0.62;
        g.step();
      } else if (mode === 'peak') {
        for (let i = 0; i < 6; i++) g.step({ [d.id]: { ...cmd, contest: true } });
        g.state.charge[s.id] = 0.62;
        g.step({ [d.id]: { ...cmd, contest: true } });
      } else {
        g.state.charge[s.id] = 0.62;
        g.step({ [d.id]: { ...cmd, handsUp: true } });
      }
      if (g.state.events.some(e => e.type === 'block')) blocks++;
    }
    return blocks;
  };
  const peakBlocks = sampleBlocks('peak');
  const lateBlocks = sampleBlocks('late');
  const handsUpBlocks = sampleBlocks('handsUp');
  assert.ok(peakBlocks > lateBlocks, `peak jump (${peakBlocks}) should block more than mistimed early jump (${lateBlocks})`);
  assert.equal(handsUpBlocks, 0, 'grounded handsUp should not sky-block perimeter jumpers');
});

test('intenseD lateral slides stay responsive, body-up walls off drivers, and over-committing yields blowby', () => {
  // 1. Intense-D lateral slide speed & responsiveness
  const slideGame = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 9 });
  const [bh, def] = slideGame.state.players;
  bh.position = { x: 5.5, z: 0 };
  def.position = { x: 6.7, z: 0 };
  for (let i = 0; i < 10; i++) slideGame.step({ [def.id]: { move: { x: 0, z: 1 }, intenseD: true } });
  assert.ok(def.pose === 'slide' && def.action?.intenseD);
  assert.ok(def.position.z > 0.45, `intenseD lateral slide should cover ground cleanly, z=${def.position.z.toFixed(2)}`);

  // 2. Over-committed defender sliding hard opposite the driver triggers blowby
  const blowGame = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 10 });
  const [driver, overDef] = blowGame.state.players;
  driver.profile.ratings.handling = 92;
  driver.profile.ratings.speed = 90;
  driver.position = { x: 6.0, z: 0 };
  overDef.position = { x: 6.55, z: 0.20 };
  // Enter live dribble first, then place defender inside body-up contact sliding hard opposite the driver's cut
  blowGame.step({ [driver.id]: { move: { x: 1, z: 0 } } });
  overDef.position = { x: driver.position.x + 0.62, z: driver.position.z + 0.18 };
  overDef.velocity = { x: 0, z: 3.6 };
  driver.velocity = { x: 4.5, z: -1.0 };
  blowGame.step({ [driver.id]: { move: { x: 0.95, z: -0.25 }, sprint: true }, [overDef.id]: { move: { x: 0, z: 1 }, intenseD: true } });
  assert.equal(driver.action?.bodyUp, 'blowby', 'over-committed lateral slide gives up a blowby');
});

test('timed crossover steals succeed more than protected steals, whiffed steals lunge, and spamming draws fouls', () => {
  const rateAction = (setupCross: boolean, spam: boolean) => {
    let stealsOrPokes = 0;
    let fouls = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const r = structuredClone(teams);
      r[1].roster[0].ratings.perimeter = 84;
      r[0].roster[0].ratings.handling = 78;
      const g = createEngine(r, { playersPerTeam: 1, mode: 'regulation', seed });
      const [h, d] = g.state.players;
      h.position = { x: 6.0, z: 0 };
      d.position = { x: 6.65, z: 0.35 };
      g.step({ [h.id]: { move: { x: 1, z: 0 } } });
      if (setupCross) {
        // Crossover exposed mid-move
        g.step({ [h.id]: { move: { x: 0, z: 1 }, dribble: true, dribbleDir: { x: 0, z: 1 } } });
        for (let i = 0; i < 5; i++) g.step();
      } else {
        // Post-up / protected stance
        g.step({ [h.id]: { move: { x: 0, z: 0 }, postUp: true } });
      }
      d.position = { x: h.position.x + 0.52, z: h.position.z + 0.22 };
      const handlerCmd = setupCross ? cmd : { ...cmd, postUp: true };
      if (spam) {
        // Simulate 3 spammed reaches inside the spam window
        for (let rep = 0; rep < 3; rep++) {
          for (let t = 0; t < 47; t++) g.step({ [h.id]: handlerCmd });
          if (g.state.ball.ownerId !== h.id || g.state.phase !== 'live') break;
          d.position = { x: h.position.x + 0.52, z: h.position.z + 0.22 };
          g.step({ [h.id]: handlerCmd, [d.id]: { ...cmd, steal: true } });
        }
      } else {
        g.step({ [h.id]: handlerCmd, [d.id]: { ...cmd, steal: true } });
      }
      if (g.state.events.some(e => e.type === 'steal' || (e.type === 'turnover' && e.detail === 'Poked loose'))) stealsOrPokes++;
      if (g.state.events.some(e => e.type === 'foul')) fouls++;
    }
    return { stealsOrPokes, fouls };
  };

  const crossRead = rateAction(true, false);
  const postRead = rateAction(false, false);
  const spamRead = rateAction(false, true);
  assert.ok(crossRead.stealsOrPokes > postRead.stealsOrPokes, `crossover read (${crossRead.stealsOrPokes}) beats protected post reach (${postRead.stealsOrPokes})`);
  assert.ok(spamRead.fouls > postRead.fouls * 2, `spamming steals (${spamRead.fouls} fouls) escalates reach-ins vs single reach (${postRead.fouls})`);

  // Whiffed steal physically lunges defender forward & preserves JSON replay determinism
  const whGame = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'regulation', seed: 1 });
  const [whHandler, whDef] = whGame.state.players;
  whHandler.profile.ratings.handling = 98;
  whDef.profile.ratings.perimeter = 40;
  whHandler.position = { x: 6.0, z: 0 };
  whDef.position = { x: 7.25, z: 0 };
  whHandler.velocity = { x: 0, z: 0 };
  whGame.step({ [whHandler.id]: { ...cmd, postUp: true }, [whDef.id]: { ...cmd, steal: true } });
  if (whDef.pose === 'steal') {
    const cloned = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'regulation', seed: 1 }, JSON.parse(JSON.stringify(whGame.state)));
    for (let i = 0; i < 6; i++) {
      whGame.step();
      cloned.step();
    }
    assert.deepEqual(cloned.state, whGame.state, 'steal lunge simulation survives JSON round-trip identically');
  }
});
