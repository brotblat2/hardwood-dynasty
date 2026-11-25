import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { Team } from '../packages/contracts/index.ts';
import { captureFrame, createEngine, interpolateState } from '../packages/game-engine/index.ts';
import {
  advanceBall, BALL_RADIUS, GRAVITY, solveShotVelocity, vector as vec,
} from '../packages/game-engine/physics-ball.ts';

const teams: [Team, Team] = [fixtureTeam('home'), fixtureTeam('away', 'West')];
const cmd = { move: { x: 0, z: 0 } };

test('inertia carries momentum into 180-degree sprint reversals and produces mass-scaled turning arcs', () => {
  const g = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 7 });
  const [p, def] = g.state.players;
  p.position = { x: -4, z: 0 };
  def.position = { x: -12, z: -6 };

  for (let i = 0; i < 18; i++) g.step({ [p.id]: { move: { x: 1, z: 0 }, sprint: true } });
  const forwardVx = p.velocity.x;
  assert.ok(forwardVx > 5.2, `expected sprint speed > 5.2, got ${forwardVx.toFixed(2)}`);

  // Sudden 180-degree reversal at full sprint: no instant velocity snap or 1-tick facing teleport.
  g.step({ [p.id]: { move: { x: -1, z: 0 }, sprint: true } });
  assert.ok(p.velocity.x > 2.5, `momentum should carry forward on tick 1 of reversal, got vx=${p.velocity.x.toFixed(2)}`);
  assert.ok(Math.cos(p.facing) > 0.5, 'facing turns smoothly rather than snapping 180 degrees in 1 tick');

  // Heavy vs light turning radius on a 90-degree cut at sprint.
  const makeTurnTest = (weight: number) => {
    const r = structuredClone(teams);
    Object.assign(r[0].roster[0], { weight });
    const sim = createEngine(r, { playersPerTeam: 1, mode: 'practice', seed: 3 });
    const [runner, d] = sim.state.players;
    runner.position = { x: 0, z: 0 };
    d.position = { x: -12, z: -6 };
    for (let i = 0; i < 16; i++) sim.step({ [runner.id]: { move: { x: 1, z: 0 }, sprint: true } });
    const cutStartX = runner.position.x;
    for (let i = 0; i < 10; i++) sim.step({ [runner.id]: { move: { x: 0, z: 1 }, sprint: true } });
    return { driftX: runner.position.x - cutStartX, lateralZ: runner.position.z };
  };
  const light = makeTurnTest(78);
  const heavy = makeTurnTest(124);
  assert.ok(light.driftX > 0.25 && heavy.driftX > 0.25, 'both players carry forward drift around turn');
  assert.ok(heavy.driftX > light.driftX, `heavier player should carve wider turn (${heavy.driftX.toFixed(3)} > ${light.driftX.toFixed(3)})`);
});

test('low stamina slows movement, dulls dribble cadence/duration, and shrinks shotMeter greenWindow', () => {
  const fresh = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 5 });
  const gassed = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 5 });
  const pFresh = fresh.state.players[0];
  const pGas = gassed.state.players[0];
  pFresh.position = { x: 5.5, z: 0 };
  pGas.position = { x: 5.5, z: 0 };
  pGas.stamina = 10;

  fresh.step({ [pFresh.id]: { move: { x: 1, z: 0 } } });
  gassed.step({ [pGas.id]: { move: { x: 1, z: 0 } } });

  fresh.step({ [pFresh.id]: { move: { x: 0, z: 1 }, dribble: true, dribbleDir: { x: 0, z: 1 } } });
  gassed.step({ [pGas.id]: { move: { x: 0, z: 1 }, dribble: true, dribbleDir: { x: 0, z: 1 } } });
  assert.ok(pFresh.velocity.z > pGas.velocity.z, 'fresh player bursts faster out of crossover');

  for (let i = 0; i < 20; i++) {
    fresh.step({ [pFresh.id]: { ...cmd, shoot: true } });
    gassed.step({ [pGas.id]: { ...cmd, shoot: true } });
  }
  assert.ok(fresh.state.shotMeter && gassed.state.shotMeter);
  assert.ok(
    fresh.state.shotMeter.greenWindow > gassed.state.shotMeter.greenWindow + 0.015,
    `fatigue should noticeably shrink greenWindow (${fresh.state.shotMeter.greenWindow.toFixed(4)} vs ${gassed.state.shotMeter.greenWindow.toFixed(4)})`,
  );
});

test('rigid-body ball simulates Magnus backspin lift, velocity-dependent rim restitution, rim bracket, and drag solver', () => {
  // 1. Magnus backspin lift vs zero spin
  const noSpin = { kind: 'shot' as const, ownerId: null, position: vec(0, 2.2, 0), velocity: vec(6.5, 5.2, 0), spin: vec(0, 0, 0) };
  const backSpin = { kind: 'shot' as const, ownerId: null, position: vec(0, 2.2, 0), velocity: vec(6.5, 5.2, 0), spin: vec(0, 0, 14) };
  for (let i = 0; i < 45; i++) {
    advanceBall(noSpin, 1 / 60, true);
    advanceBall(backSpin, 1 / 60, true);
  }
  assert.ok(backSpin.position.y > noSpin.position.y + 0.015, 'backspin creates upward Magnus lift');

  // 2. Soft rim kiss vs hard brick bounce restitution
  const softBall = { kind: 'shot' as const, ownerId: null, position: vec(12.65 - 0.235, 3.23, 0), velocity: vec(0.4, -1.6, 0), spin: vec(0, 0, 10) };
  const hardBall = { kind: 'shot' as const, ownerId: null, position: vec(12.65 - 0.235, 3.30, 0), velocity: vec(0.8, -6.4, 0), spin: vec(0, 0, 0) };
  for (let i = 0; i < 6; i++) {
    advanceBall(softBall, 1 / 60, true);
    advanceBall(hardBall, 1 / 60, true);
  }
  assert.ok(softBall.velocity.y < 1.2 && hardBall.velocity.y > softBall.velocity.y * 2.2, 'soft rim touch absorbs energy while hard brick rebounds sharply');

  // 3. Rim mounting bracket collider stops ball passing through
  let bracketHit = false;
  const bracketBall = { kind: 'shot' as const, ownerId: null, position: vec(12.96, 3.22, 0), velocity: vec(0, -3.5, 0), spin: vec(0, 0, 0) };
  for (let i = 0; i < 12; i++) {
    advanceBall(bracketBall, 1 / 60, true, undefined, surface => {
      if (surface === 'rim') bracketHit = true;
    });
  }
  assert.ok(bracketHit, 'rim mounting bracket triggers physical rim bounce');

  // 4. Ballistic solver lands physically at target under drag + Magnus + gravity (with realistic shooter arc)
  const start = vec(5.0, 2.35, 0);
  const target = vec(12.65, 3.05, 0);
  const spin = vec(0, 0, 11);
  const v0 = solveShotVelocity(start, target, 1.35, spin);
  const flightBall = { kind: 'shot' as const, ownerId: null, position: { ...start }, velocity: { ...v0 }, spin: { ...spin } };
  for (let i = 0; i < 81; i++) advanceBall(flightBall, 1 / 60, true);
  assert.ok(
    Math.hypot(flightBall.position.x - target.x, flightBall.position.y - target.y, flightBall.position.z - target.z) < 0.01,
    `solved trajectory should physically arrive at rim center (dist=${Math.hypot(flightBall.position.x - target.x, flightBall.position.y - target.y, flightBall.position.z - target.z).toFixed(4)})`,
  );
  assert.ok(GRAVITY > 9 && BALL_RADIUS > 0.12);
});

test('dribble combos support snatchBack, branching cancels, 150ms input buffer, move-to-shot rhythm cancel, and ball-hand tracking', () => {
  const g = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 11 });
  const [pg, def] = g.state.players;
  pg.position = { x: 2.0, z: 0 };
  def.position = { x: -10, z: -4 };

  // Sprint forward to build drive speed, then pull back -> triggers snatchBack
  for (let i = 0; i < 14; i++) g.step({ [pg.id]: { move: { x: 1, z: 0 }, sprint: true } });
  assert.equal(pg.action?.ballState, 'live');
  const startHand = pg.action?.ballHand;
  assert.ok(startHand === -1 || startHand === 1);

  g.step({ [pg.id]: { move: { x: -1, z: 0 }, dribble: true, dribbleDir: { x: -1, z: 0 } } });
  assert.equal(pg.action?.dribbleMove, 'snatchBack');
  assert.ok(pg.velocity.x < -1.0, 'snatchBack arrests forward sprint and pulls back');

  // Let snatchBack finish, then execute crossover and buffer a second crossover mid-move (within 150ms / 9 ticks)
  for (let i = 0; i < 20; i++) g.step({ [pg.id]: { move: { x: 0.2, z: 0 } } });
  g.step({ [pg.id]: { move: { x: 0, z: 1 }, dribble: true, dribbleDir: { x: 0, z: 1 } } });
  assert.equal(pg.action?.dribbleMove, 'crossover');
  const crossHand = pg.action?.ballHand;

  // Step 4 ticks into the crossover (before cancelAfter ~0.46), tap dribble once -> buffered!
  for (let i = 0; i < 4; i++) g.step({ [pg.id]: { move: { x: 0, z: 1 } } });
  g.step({ [pg.id]: { move: { x: 0, z: -1 }, dribble: true, dribbleDir: { x: 0, z: -1 } } });
  // Release button on following ticks; buffer should automatically fire the chained combo as soon as cancelAfter opens (~tick 8-9).
  let chainedEarly = false;
  for (let i = 0; i < 7; i++) {
    g.step({ [pg.id]: { move: { x: 0, z: -1 } } });
    if ((pg.action?.moveProgress ?? 1) < 0.25 && pg.action?.dribbleMove) chainedEarly = true;
  }
  assert.ok(chainedEarly, 'buffered combo should branch cleanly once cancelAfter opens');

  // Cancel active dribble move straight into a pull-up / rhythm shot!
  g.step({ [pg.id]: { move: { x: 0, z: 0 }, shoot: true } });
  assert.ok(g.state.shotMeter && g.state.shotMeter.progress > 0, 'shoot cancels dribble move immediately into shot gather');
  assert.ok(pg.action?.ballHand === undefined || crossHand !== undefined);
  for (let i = 0; i < 36; i++) g.step({ [pg.id]: { move: { x: 0, z: 0 }, shoot: true } });
  g.step();
  assert.equal(g.state.shotFeedback?.rhythm, true, 'shot canceled out of dribble combo retains rhythm boost');
});

test('live-ball physical collisions jar exposed dribbles loose against defender hips or reaching hands', () => {
  let sawLooseOrSteal = false;
  for (let seed = 1; seed <= 25 && !sawLooseOrSteal; seed++) {
    const r = structuredClone(teams);
    r[0].roster[0].ratings.handling = 65;
    r[1].roster[0].ratings.perimeter = 92;
    const g = createEngine(r, { playersPerTeam: 1, mode: 'regulation', seed });
    const [handler, def] = g.state.players;
    handler.position = { x: 6.0, z: 0 };
    def.position = { x: 6.55, z: 0.35 };
    def.facing = Math.PI;
    // Drive recklessly with sprint right into defender's hip/hand while crossing over
    g.step({ [handler.id]: { move: { x: 1, z: 0 }, sprint: true } });
    for (let i = 0; i < 8; i++) {
      def.position = { x: handler.position.x + 0.36, z: handler.position.z + 0.20 };
      g.step({
        [handler.id]: { move: { x: 0.8, z: 0.6 }, sprint: true, dribble: i === 1, dribbleDir: { x: 0.4, z: 1 } },
        [def.id]: { move: { x: -0.2, z: 0 }, steal: true, intenseD: true },
      });
      if (g.state.ball.ownerId !== handler.id) {
        sawLooseOrSteal = true;
        break;
      }
    }
  }
  assert.ok(sawLooseOrSteal, 'live-ball collision with defender hip/reaching hand should pop the ball loose or steal it');
});

test('contextual shot styles, dynamic shotMeter, Wide Open tier, interpolation, and JSON determinism work end-to-end', () => {
  // 1. Moving midrange pull-up jumper -> 'Pull-up' & 'Wide Open'
  const g1 = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 14 });
  const [p1, d1] = g1.state.players;
  p1.position = { x: 5.0, z: 2.0 };
  d1.position = { x: -12.0, z: -5.0 };
  for (let i = 0; i < 8; i++) g1.step({ [p1.id]: { move: { x: 1, z: 0 }, sprint: true } });
  for (let i = 0; i < 36; i++) g1.step({ [p1.id]: { move: { x: 1, z: 0 }, shoot: true } });
  assert.equal(g1.state.shotMeter?.style, 'pullUp');
  assert.equal(g1.state.shotMeter?.contestLevel, 'Wide Open');

  // Test mid-gather JSON serialization determinism & sub-frame interpolation
  const prev = captureFrame(g1.state);
  const cloned = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 14 }, JSON.parse(JSON.stringify(g1.state)));
  g1.step({ [p1.id]: { move: { x: 1, z: 0 }, shoot: true } });
  cloned.step({ [p1.id]: { move: { x: 1, z: 0 }, shoot: true } });
  assert.deepEqual(cloned.state, g1.state);

  const mid = interpolateState(prev, g1.state, 0.5);
  assert.ok(mid.shotMeter && mid.shotMeter.progress > prev.meterProgress! && mid.shotMeter.progress < g1.state.shotMeter!.progress);

  // Release shot -> Pull-up
  g1.step();
  assert.equal(g1.state.shotFeedback?.style, 'Pull-up');
  assert.equal(g1.state.shotFeedback?.contest, 'Wide Open');
  assert.equal(g1.state.shotMeter, null);

  // 2. Deep baseline drive -> Reverse layup
  const g2 = createEngine(structuredClone(teams), { playersPerTeam: 1, mode: 'practice', seed: 19 });
  const [p2, d2] = g2.state.players;
  p2.position = { x: 12.1, z: 2.2 };
  d2.position = { x: -10, z: -4 };
  for (let i = 0; i < 6; i++) g2.step({ [p2.id]: { move: { x: 0.2, z: -1 } } });
  p2.position = { x: 12.22, z: 1.1 };
  for (let i = 0; i < 28; i++) g2.step({ [p2.id]: { move: { x: 0.1, z: -1 }, shoot: true } });
  g2.step();
  assert.equal(g2.state.shotFeedback?.style, 'Reverse layup');

  // 3. Rim challenge with athletic finisher -> Contact dunk
  const r3 = structuredClone(teams);
  r3[0].roster[0].ratings.finishing = 95;
  r3[0].roster[0].ratings.strength = 90;
  r3[0].roster[0].height = 2.02;
  const g3 = createEngine(r3, { playersPerTeam: 1, mode: 'practice', seed: 21 });
  const [p3, d3] = g3.state.players;
  p3.position = { x: 9.2, z: 0 };
  d3.position = { x: 11.9, z: 0 };
  for (let i = 0; i < 8; i++) g3.step({ [p3.id]: { move: { x: 1, z: 0 }, sprint: true } });
  for (let i = 0; i < 27; i++) g3.step({ [p3.id]: { move: { x: 1, z: 0 }, sprint: true, shoot: true } });
  g3.step();
  assert.equal(g3.state.shotFeedback?.style, 'Contact dunk');
});
