import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { Control, GameConfig, Team } from '../packages/contracts/index.ts';
import { createEngine } from '../packages/game-engine/index.ts';

const baseTeams: [Team, Team] = [fixtureTeam('home'), fixtureTeam('away', 'West')];
const idle: Control = { move: { x: 0, z: 0 } };

function makeEngine(config: GameConfig = {}, teams: [Team, Team] = baseTeams) {
  return createEngine(teams, config);
}

test('all four pass varieties complete cleanly and flashy passes apply rating-scaled Magnus sidespin', () => {
  for (const passType of ['chest', 'bounce', 'lob', 'flashy'] as const) {
    const g = makeEngine({ seed: 21 });
    const [passer, receiver] = [g.state.players[0], g.state.players[1]];
    passer.position = { x: 2, z: 2.2 };
    receiver.position = { x: 6.2, z: -1.2 };
    for (const q of g.state.players) {
      if (q.side === 1) q.position = { x: -12, z: -6 };
    }

    g.step({ [passer.id]: { ...idle, pass: true, targetId: receiver.id, passType } });
    assert.equal(g.state.ball.kind, 'pass', `${passType} should enter pass flight`);
    assert.equal(g.state.events.findLast(e => e.type === 'pass')?.detail, passType);
    if (passType === 'flashy') {
      assert.ok(Math.abs(g.state.ball.spin?.y ?? 0) > 5, 'flashy pass should apply sidespin for Magnus curve');
      assert.equal(passer.action?.passStyle, 'flashy');
    }

    for (let i = 0; i < 85 && g.state.ball.ownerId !== receiver.id; i++) g.step();
    assert.equal(g.state.ball.ownerId, receiver.id, `${passType} pass should arrive cleanly`);
  }

  // Long flashy pass risk/reward: 95-passing guard completes more accurately than 45-passing passer.
  function flashyCompletions(passingRating: number): { completions: number; meanMissDist: number } {
    let completions = 0;
    let totalErr = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const customTeams = structuredClone(baseTeams);
      customTeams[0].roster[0].ratings.passing = passingRating;
      const g = makeEngine({ seed }, customTeams);
      const [passer, receiver] = [g.state.players[0], g.state.players[1]];
      passer.position = { x: -2.0, z: 3.5 };
      receiver.position = { x: 7.4, z: -2.8 };
      for (const q of g.state.players) {
        if (q.side === 1) q.position = { x: -12, z: -6 };
      }
      g.step({ [passer.id]: { ...idle, pass: true, targetId: receiver.id, passType: 'flashy' } });
      let minDist = Infinity;
      for (let t = 0; t < 55; t++) {
        g.step();
        if (g.state.ball.ownerId === receiver.id) {
          completions++;
          minDist = 0;
          break;
        }
        minDist = Math.min(minDist, Math.hypot(g.state.ball.position.x - receiver.position.x, g.state.ball.position.z - receiver.position.z));
      }
      totalErr += minDist;
    }
    return { completions, meanMissDist: totalErr / 30 };
  }

  const elite = flashyCompletions(95);
  const poor = flashyCompletions(45);
  assert.ok(elite.completions > poor.completions || elite.meanMissDist < poor.meanMissDist,
    `95 passing (${JSON.stringify(elite)}) should beat 45 passing (${JSON.stringify(poor)}) on long flashy passes`);
});

test('cutter lead-passing leads moving teammates ahead along cut vector and away from trailing defender', () => {
  const g = makeEngine({ seed: 9 });
  const [passer, cutter] = [g.state.players[0], g.state.players[1]];
  passer.position = { x: -2.0, z: -4.0 };
  cutter.position = { x: 4.2, z: 0.2 };
  cutter.velocity = { x: 4.0, z: 2.0 };
  for (const q of g.state.players) {
    if (q.id !== passer.id && q.id !== cutter.id) q.position = { x: -12, z: -6 };
  }
  const launchCutterPos = { ...cutter.position };

  g.step({
    [passer.id]: { ...idle, pass: true, targetId: cutter.id, passType: 'chest' },
    [cutter.id]: { move: { x: 0.89, z: 0.45 }, sprint: true },
  });
  let maxBallLeadX = -Infinity;
  for (let i = 0; i < 65 && g.state.ball.ownerId !== cutter.id; i++) {
    maxBallLeadX = Math.max(maxBallLeadX, g.state.ball.position.x);
    g.step({ [cutter.id]: { move: { x: 0.89, z: 0.45 }, sprint: true } });
  }
  assert.equal(g.state.ball.ownerId, cutter.id, 'moving cutter should catch lead pass cleanly');
  assert.ok(cutter.position.x > launchCutterPos.x + 1.0, 'catch should occur meaningfully ahead of launch spot');
  assert.ok(maxBallLeadX > launchCutterPos.x + 0.8, `pass flight should lead cutter ahead of launch spot (maxX=${maxBallLeadX.toFixed(2)})`);

  // Verify defender-separation lead bias steers the target point away from a trailing defender on -z.
  const gBias = makeEngine({ seed: 9 });
  const [bp, bc] = [gBias.state.players[0], gBias.state.players[1]];
  const trailer = gBias.state.players[5];
  bp.position = { x: -2.0, z: -4.0 };
  bc.position = { x: 4.2, z: 0.2 };
  bc.velocity = { x: 4.0, z: 2.0 };
  trailer.position = { x: 5.5, z: -0.6 };
  for (const q of gBias.state.players) {
    if (q.id !== bp.id && q.id !== bc.id && q.id !== trailer.id) q.position = { x: -12, z: -6 };
  }
  gBias.step({
    [bp.id]: { ...idle, pass: true, targetId: bc.id, passType: 'chest' },
    [bc.id]: { move: { x: 0.89, z: 0.45 }, sprint: true },
  });
  // Initial ball velocity Z should bias positively (+z, away from trailer at z = -0.6) compared to no-trailer launch.
  const gOpen = makeEngine({ seed: 9 });
  const [op, oc] = [gOpen.state.players[0], gOpen.state.players[1]];
  op.position = { x: -2.0, z: -4.0 };
  oc.position = { x: 4.2, z: 0.2 };
  oc.velocity = { x: 4.0, z: 2.0 };
  for (const q of gOpen.state.players) {
    if (q.id !== op.id && q.id !== oc.id) q.position = { x: -12, z: -6 };
  }
  gOpen.step({
    [op.id]: { ...idle, pass: true, targetId: oc.id, passType: 'chest' },
    [oc.id]: { move: { x: 0.89, z: 0.45 }, sprint: true },
  });
  assert.ok(gBias.state.ball.velocity.z > gOpen.state.ball.velocity.z + 0.1,
    'pass launch velocity should bias away from defender near predicted cutter catch point');
});

test('swept 3D passing-lane collisions prevent tunneling, let lobs clear grounded defenders, and credit deflected OOB properly', () => {
  // Fast chest pass directly through active stealing defender in lane cannot tunnel cleanly through.
  let disrupted = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const custom = structuredClone(baseTeams);
    custom[1].roster[0].ratings.perimeter = 90;
    const g = makeEngine({ seed }, custom);
    const [passer, receiver] = [g.state.players[0], g.state.players[1]];
    const hawk = g.state.players[5];
    passer.position = { x: -3.0, z: 0 };
    receiver.position = { x: 5.5, z: 0 };
    hawk.position = { x: 1.2, z: 0.1 };
    for (const q of g.state.players) {
      if (q.id !== passer.id && q.id !== receiver.id && q.id !== hawk.id) q.position = { x: -12, z: -6 };
    }
    g.step({ [passer.id]: { ...idle, pass: true, targetId: receiver.id, passType: 'chest' }, [hawk.id]: { ...idle, steal: true } });
    for (let t = 0; t < 40; t++) {
      g.step({ [hawk.id]: { ...idle, steal: true } });
      if (g.state.ball.ownerId === hawk.id || g.state.callout?.text === 'DEFLECTED!' || g.state.ball.kind === 'loose') {
        disrupted++;
        break;
      }
      if (g.state.ball.ownerId === receiver.id) break;
    }
  }
  assert.ok(disrupted >= 10, `expected swept 3D lane checks to disrupt chest pass through defender, got ${disrupted}/12`);

  // Overhead lob over grounded defender clears vertical reach and completes to receiver.
  const lobGame = makeEngine({ seed: 15 });
  const [lp, lr] = [lobGame.state.players[0], lobGame.state.players[1]];
  const lowDef = lobGame.state.players[5];
  lp.position = { x: -3.5, z: 0 };
  lr.position = { x: 4.5, z: 0 };
  lowDef.position = { x: 0.5, z: 0 };
  for (const q of lobGame.state.players) {
    if (q.id !== lp.id && q.id !== lr.id && q.id !== lowDef.id) q.position = { x: -12, z: -6 };
  }
  lobGame.step({ [lp.id]: { ...idle, pass: true, targetId: lr.id, passType: 'lob' } });
  let peakY = 0;
  for (let t = 0; t < 80 && lobGame.state.ball.ownerId !== lr.id; t++) {
    peakY = Math.max(peakY, lobGame.state.ball.position.y);
    lobGame.step();
  }
  assert.ok(peakY > 2.35, `lob should arc high over grounded defender (peakY=${peakY.toFixed(2)})`);
  assert.equal(lobGame.state.ball.ownerId, lr.id, 'overhead lob should complete cleanly over grounded lane defender');

  // Defender deflection out of bounds returns inbound possession to offense without charging a turnover.
  const oob = makeEngine({ seed: 19 });
  const [op, or] = [oob.state.players[0], oob.state.players[1]];
  const def = oob.state.players[5];
  def.profile.ratings.perimeter = 62; // deflect rather than clean steal when hands are up/steal edge
  op.position = { x: 2.0, z: 4.2 };
  or.position = { x: 5.5, z: 6.4 };
  def.position = { x: 3.7, z: 5.8 };
  for (const q of oob.state.players) {
    if (q.id !== op.id && q.id !== or.id && q.id !== def.id) q.position = { x: -12, z: -6 };
  }
  oob.step({ [op.id]: { ...idle, pass: true, targetId: or.id, passType: 'chest' }, [def.id]: { ...idle, handsUp: true } });
  let sawDeflect = false;
  for (let t = 0; t < 40; t++) {
    oob.step({ [def.id]: { ...idle, handsUp: true } });
    if (oob.state.callout?.text === 'DEFLECTED!') {
      sawDeflect = true;
      // Nudge deflected ball toward sideline to test lastLooseTouch OOB attribution deterministically.
      oob.state.ball.position.z = 7.75;
      oob.state.ball.velocity = { x: 0, y: 0.5, z: 3.0 };
      oob.step();
      break;
    }
  }
  assert.ok(sawDeflect, 'hands-up defender in tight sideline lane should trigger DEFLECTED!');
  assert.equal(oob.state.possession, 0, 'deflected pass going out of bounds should stay offense ball');
  assert.equal(oob.state.events.some(e => e.type === 'turnover'), false, 'defender deflection OOB should not charge turnover');
});

test('physical box-out sealing holds incoming crashers outside the inside track and boosts glass win rate', () => {
  // Check immediate physical velocity seal & boxOut HUD flag during pending rebound.
  const boxed = makeEngine({ seed: 4, playersPerTeam: 1 });
  const [crasher, boxer] = boxed.state.players;
  crasher.position = { x: 9.8, z: 0 };
  boxer.position = { x: 10.65, z: 0 };
  boxed.state.ball = { kind: 'loose', ownerId: null, position: { x: 11.4, y: 2.95, z: 0 }, velocity: { x: 0, y: 1.5, z: 0 } };
  // Put game in shot/pending rebound mode via missed close heave or direct shot flight
  boxed.state.ball = { kind: 'shot', ownerId: null, position: { x: 11.5, y: 3.4, z: 0 }, velocity: { x: 0, y: 1.5, z: 0 } };
  boxed.step({ [crasher.id]: { move: { x: 1, z: 0 }, sprint: true }, [boxer.id]: { ...idle, screen: true } });
  const sealedCrashVel = crasher.velocity.x;
  assert.equal(boxer.action?.boxOut, true, 'inside player holding box-out should expose action.boxOut');

  const unboxed = makeEngine({ seed: 4, playersPerTeam: 1 });
  const [freeCrasher, idleDef] = unboxed.state.players;
  freeCrasher.position = { x: 9.8, z: 0 };
  idleDef.position = { x: 10.65, z: 0 };
  unboxed.state.ball = { kind: 'shot', ownerId: null, position: { x: 11.5, y: 3.4, z: 0 }, velocity: { x: 0, y: 1.5, z: 0 } };
  unboxed.step({ [freeCrasher.id]: { move: { x: 1, z: 0 }, sprint: true }, [idleDef.id]: idle });
  assert.ok(sealedCrashVel < unboxed.state.players[0].velocity.x,
    `box-out should check rimward velocity (${sealedCrashVel.toFixed(3)} < ${unboxed.state.players[0].velocity.x.toFixed(3)})`);

  // Across matched live rebounds, holding box-out wins more defensive boards than passive standing.
  function simBoardWinRate(boxOutActive: boolean): number {
    let wins = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const g = makeEngine({ seed, playersPerTeam: 1 });
      const [off, def] = g.state.players;
      off.profile.ratings.rebounding = 80;
      def.profile.ratings.rebounding = 78;
      off.position = { x: 10.2, z: 0 };
      def.position = { x: 11.15, z: 0 };
      // Shoot forced late shot so sim.pendingRebound activates on miss cleanly.
      g.state.charge[off.id] = 0.05;
      g.step(); // miss/launch near rim
      g.state.ball = { kind: 'shot', ownerId: null, position: { x: 12.1, y: 3.25, z: 0 }, velocity: { x: -1.4, y: 2.2, z: (seed % 3 - 1) * 0.4 } };
      for (let t = 0; t < 75 && g.state.ball.ownerId === null; t++) {
        g.step({
          [off.id]: { move: { x: 1, z: 0 }, sprint: true, contest: t > 18 },
          [def.id]: { move: { x: 0, z: 0 }, screen: boxOutActive && t < 18, contest: t >= 18 },
        });
      }
      if (g.state.ball.ownerId === def.id) wins++;
    }
    return wins;
  }

  const withBox = simBoardWinRate(true);
  const withoutBox = simBoardWinRate(false);
  assert.ok(withBox >= withoutBox, `box-out win rate (${withBox}/25) should equal or exceed no box-out (${withoutBox}/25)`);
});

test('vertical apex rebound timing, contested tip-outs, and JSON replay determinism hold', () => {
  // Timed jump reaches peak vertical apex several ticks after takeoff while tick-0 takeoff stays lower.
  const apexCustom = structuredClone(baseTeams);
  apexCustom[0].roster[0].height = 1.98;
  apexCustom[0].roster[0].wingspan = undefined;
  apexCustom[0].roster[0].ratings.rebounding = 75;
  const gEarly = makeEngine({ seed: 11, playersPerTeam: 1 }, apexCustom);
  const jumper = gEarly.state.players[0];
  jumper.position = { x: 8, z: 0 };
  gEarly.state.players[1].position = { x: -12, z: -6 };
  gEarly.state.ball = { kind: 'loose', ownerId: null, position: { x: 8, y: 2.86, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  gEarly.step({ [jumper.id]: { ...idle, contest: true } });
  assert.equal(gEarly.state.ball.ownerId, null, 'takeoff tick should not magically snatch above initial takeoff reach');
  for (let t = 1; t <= 10 && gEarly.state.ball.ownerId === null; t++) {
    gEarly.state.ball = { kind: 'loose', ownerId: null, position: { ...jumper.position, y: 2.86 }, velocity: { x: 0, y: 0, z: 0 } };
    gEarly.step({ [jumper.id]: { ...idle, contest: true } });
  }
  assert.equal(gEarly.state.ball.ownerId, jumper.id, 'rebounder should reach high ball at jump apex');

  // Contested glass tip-out triggers across matched bigs + JSON replay stays byte-identical.
  let sawTip = false;
  for (let seed = 1; seed <= 40 && !sawTip; seed++) {
    const custom = structuredClone(baseTeams);
    custom[0].roster[0].height = 2.08;
    custom[0].roster[0].ratings.rebounding = 84;
    custom[1].roster[0].height = 2.08;
    custom[1].roster[0].ratings.rebounding = 84;
    const g = makeEngine({ seed, playersPerTeam: 2 }, custom);
    const [oBig, shooter, dBig] = [g.state.players[0], g.state.players[1], g.state.players[2]];
    g.state.players[3].position = { x: -12, z: -6 };

    // Launch a genuine short-charge airball/miss near the corner so pendingRebound activates on miss.
    shooter.position = { x: 8.0, z: 6.2 };
    oBig.position = { x: -8, z: -4 };
    dBig.position = { x: -8, z: 4 };
    g.state.ball.ownerId = shooter.id;
    g.state.charge[shooter.id] = 0.04;
    g.step(); // releases very early shot
    for (let t = 0; t < 110 && g.state.ball.kind === 'shot'; t++) g.step();
    if (g.state.ball.kind !== 'loose') continue;

    // Position both matched bigs cleanly underneath a contested high board and jump together.
    oBig.position = { x: 11.2, z: -0.35 };
    dBig.position = { x: 11.2, z: 0.35 };
    oBig.velocity = { x: 0, z: 0 };
    dBig.velocity = { x: 0, z: 0 };
    g.state.ball = { kind: 'loose', ownerId: null, position: { x: 11.2, y: 2.25, z: 0 }, velocity: { x: 0, y: -0.4, z: 0 } };
    g.step({ [oBig.id]: { ...idle, contest: true }, [dBig.id]: { ...idle, contest: true } });
    if (g.state.callout?.text === 'TIPPED!' && g.state.ball.kind === 'loose' && g.state.ball.velocity.y > 2.0) {
      const r1 = createEngine(custom, { seed, playersPerTeam: 2 }, JSON.parse(JSON.stringify(g.state)));
      for (let i = 0; i < 40; i++) {
        g.step();
        r1.step();
      }
      assert.deepEqual(r1.state, g.state);
      sawTip = true;
    }
  }
  assert.ok(sawTip, 'contested rebounding battle between evenly matched bigs should spark a physical tip-out');
});
