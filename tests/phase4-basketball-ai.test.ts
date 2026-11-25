import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoach, defensiveAssignments } from '../packages/basketball-ai/index.ts';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { GamePlayer, GameState, Player, Ratings, Team } from '../packages/contracts/index.ts';
import { createEngine } from '../packages/game-engine/index.ts';

function fullFixture(overrides?: Partial<Ratings>): GameState {
  const baseRatings: Ratings = {
    shooting: 80, finishing: 80, passing: 82, handling: 82, rebounding: 80,
    speed: 82, perimeter: 80, interior: 80, iq: 84, durability: 85, strength: 78,
    ...overrides,
  };
  const roles: Player['position'][] = ['PG', 'SG', 'SF', 'PF', 'C'];
  const heights = [1.91, 1.96, 2.01, 2.06, 2.12];
  const teams: [Team, Team] = [0, 1].map(side => ({
    id: String(side),
    city: 'City',
    name: 'Club',
    abbreviation: 'C',
    color: '#ffffff',
    accent: '#000000',
    conference: 'East',
    roster: roles.map((position, i): Player => ({
      id: `${side}-${i}`,
      name: `Player ${side}-${i}`,
      number: i + 1,
      position,
      height: heights[i],
      age: 26,
      overall: 82,
      potential: 86,
      ratings: { ...baseRatings },
    })),
  })) as [Team, Team];

  const homeSpots = [
    { x: 5.5, z: 0 },
    { x: 11.4, z: 6.7 },
    { x: 6.8, z: -5.4 },
    { x: 11.4, z: -6.7 },
    { x: 7.4, z: 2.0 },
  ];
  const awaySpots = [
    { x: 6.8, z: 0 },
    { x: 11.6, z: 5.8 },
    { x: 7.6, z: -4.5 },
    { x: 11.5, z: -5.6 },
    { x: 9.2, z: 1.5 },
  ];

  const players = teams.flatMap((team, side) => team.roster.map((profile, i): GamePlayer => ({
    id: profile.id,
    profile,
    side: side as 0 | 1,
    position: side === 0 ? { ...homeSpots[i] } : { ...awaySpots[i] },
    velocity: { x: 0, z: 0 },
    stamina: 100,
    facing: side === 0 ? 0 : Math.PI,
    pose: 'idle',
  })));

  return {
    tick: 0,
    teams,
    players,
    score: [0, 0],
    possession: 0,
    period: 1,
    clock: 180,
    shotClock: 24,
    phase: 'live',
    events: [],
    config: { difficulty: 'All-Star', seed: 42 },
    charge: {},
    ball: { kind: 'held', ownerId: players[0].id, position: { x: 5.5, y: 1.0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
  };
}

test('Pick & Roll Roll-vs-Fade override controls screener action regardless of shooting rating and updates live', () => {
  // High-shooting big (94) forced to ROLL when screenMode is 'roll'.
  const rollState = fullFixture();
  const stretchBig = rollState.players[4];
  stretchBig.profile.ratings.shooting = 94;
  rollState.players[0].position = { x: 6.0, z: 0 };
  stretchBig.position = { x: 7.8, z: 1.6 };
  rollState.players[5].position = { x: 7.0, z: -0.2 };
  const rollCoach = createCoach();
  rollCoach.controls(rollState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, callScreen: true, screenMode: 'roll' } });
  rollState.tick = 1;
  stretchBig.position = { x: 6.88, z: 1.15 };
  rollCoach.controls(rollState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, screenMode: 'roll' } }); // plants at tick 1
  rollState.tick = 26;
  const rollMove = rollCoach.controls(rollState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, screenMode: 'roll' } })[stretchBig.id];
  assert.ok(rollMove.move.x > 0.35, `Roll mode should send even a 94-shooting big toward the rim (vx=${rollMove.move.x.toFixed(2)})`);

  // Non-shooting center (55) forced to FADE/POP when screenMode is 'fade'.
  const fadeState = fullFixture();
  const nonShooter = fadeState.players[4];
  nonShooter.profile.ratings.shooting = 55;
  fadeState.players[0].position = { x: 6.0, z: 0 };
  nonShooter.position = { x: 7.8, z: 1.6 };
  fadeState.players[5].position = { x: 7.0, z: -0.2 };
  const fadeCoach = createCoach();
  fadeCoach.controls(fadeState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, callScreen: true, screenMode: 'fade' } });
  fadeState.tick = 1;
  nonShooter.position = { x: 6.88, z: 1.15 };
  fadeCoach.controls(fadeState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, screenMode: 'fade' } });
  fadeState.tick = 26;
  const fadeMove = fadeCoach.controls(fadeState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, screenMode: 'fade' } })[nonShooter.id];
  assert.ok(fadeMove.move.x < -0.15, `Fade mode should pop even a 55-shooting center out behind the arc (vx=${fadeMove.move.x.toFixed(2)})`);

  // Live mid-play toggle flips an already-planted roller into a pop immediately.
  rollState.tick = 27;
  const flipped = rollCoach.controls(rollState, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, screenMode: 'fade' } })[stretchBig.id];
  assert.ok(flipped.move.x < -0.15, 'live Roll->Fade toggle should redirect active roller out toward the arc');
});

test('Floppy playbook sets twin off-ball pin-down screens while the top shooter curls open to the wing', () => {
  const s = fullFixture();
  s.players[1].profile.ratings.shooting = 96; // top shooter curl target (`0-1`)
  s.players[2].profile.ratings.shooting = 78;
  s.players[0].position = { x: 5.0, z: 0 }; // ballhandler (`0-0`)
  s.players[1].position = { x: 10.75, z: 0 }; // near paint setup spot
  s.players[3].position = { x: 9.5, z: -2.45 }; // pin-down PF
  s.players[4].position = { x: 9.5, z: 2.45 }; // pin-down C
  s.tick = 32; // active curl phase
  const coach = createCoach();
  const out = coach.controls(s, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, offensePlay: 'floppy' } });

  const pinScreenCount = [s.players[3], s.players[4]].filter(big => out[big.id].screen).length;
  assert.equal(pinScreenCount, 2, 'both Floppy bigs at pin-down blocks should set off-ball screens');
  assert.ok(out['0-1'].move.x < -0.3 && Math.abs(out['0-1'].move.z) > 0.5 && out['0-1'].sprint,
    'top shooter should curl hard off the pin-down out toward the 3-point wing');
});

test('off-ball AI cuts backdoor when overplayed and relocates into open passing windows', () => {
  // Overplay backdoor cut: wing denied closely on perimeter cuts rimward with sprint.
  const backdoor = fullFixture();
  backdoor.players[0].position = { x: 6.2, z: 0 };
  backdoor.players[1].position = { x: 7.0, z: 5.4 };
  backdoor.players[6].position = { x: 6.5, z: 4.5 }; // defender denying lane between ball & 0-1
  // Clear paint & rest out of cut path
  backdoor.players[2].position = { x: 11.4, z: -6.8 };
  backdoor.players[3].position = { x: 6.4, z: -5.8 };
  backdoor.players[4].position = { x: 11.3, z: -6.2 };
  backdoor.players[5].position = { x: 7.5, z: 0 };
  backdoor.players[7].position = { x: 11.5, z: -6.0 };
  backdoor.players[8].position = { x: 8.5, z: -5.5 };
  backdoor.players[9].position = { x: 11.8, z: -5.5 };
  backdoor.tick = 20;
  const bdCtrl = createCoach().controls(backdoor, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, offensePlay: 'fiveOut' } })['0-1'];
  assert.ok(bdCtrl.move.x > 0.55 && bdCtrl.sprint,
    `overplayed wing should sprint backdoor toward rim (${JSON.stringify(bdCtrl)})`);

  // Passing-window relocation: corner shooter slides up toward wing when passing lane is blocked.
  const reloc = fullFixture();
  reloc.players[0].position = { x: 10.1, z: 1.5 }; // deep drive
  reloc.players[1].profile.ratings.shooting = 88;
  reloc.players[1].position = { x: 11.45, z: 6.85 }; // corner
  reloc.players[6].position = { x: 10.8, z: 4.2 }; // standing directly in corner pass lane
  reloc.players[7].position = { x: 12.1, z: 6.2 };
  reloc.tick = 22;
  const relCtrl = createCoach().controls(reloc, new Set(['0-0']), { '0-0': { move: { x: 0, z: 0 }, offensePlay: 'motion' } })['0-1'];
  assert.ok(relCtrl.move.x < -0.25, `blocked corner shooter should relocate up to wing passing window (vx=${relCtrl.move.x.toFixed(2)})`);
});

test('defensive AI applies Go Over + Hedge vs elite shooters, Go Under + Drop vs non-shooters, and Switch All', () => {
  const rim = { x: 12.65, z: 0 };
  const s = fullFixture();
  const handler = s.players[0];
  const screener = s.players[4];
  const onBallDef = s.players[5];
  const bigDef = s.players[9];

  handler.position = { x: 6.0, z: 0 };
  screener.position = { x: 6.8, z: 1.15 };
  screener.pose = 'screen';
  onBallDef.position = { x: 7.2, z: 0.1 };
  bigDef.position = { x: 7.6, z: 1.4 };

  const team = s.players.filter(p => p.side === 1);
  const foes = s.players.filter(p => p.side === 0);

  // Elite shooter -> Go Over + Hedge.
  handler.profile.ratings.shooting = 94;
  bigDef.profile.ratings.speed = 86;
  const planShoot = defensiveAssignments(team, foes, handler, rim, 3, 'man');
  assert.equal(planShoot.onBallNav, 'goOver');
  assert.equal(planShoot.screenCoverage, 'hedge');
  const coachShoot = createCoach();
  const cShoot = coachShoot.controls(s, new Set(), { '1-0': { move: { x: 0, z: 0 }, defenseScheme: 'man' } });
  assert.ok(cShoot[onBallDef.id].move.x < -0.3, 'goOver should fight over ball side of screen');
  assert.ok(cShoot[bigDef.id].move.z < -0.2, 'hedge big should show toward ballhandler lane');

  // Non-shooter -> Go Under + Drop.
  handler.profile.ratings.shooting = 55;
  bigDef.profile.ratings.speed = 65;
  const planNon = defensiveAssignments(team, foes, handler, rim, 1, 'man');
  assert.equal(planNon.onBallNav, 'goUnder');
  assert.equal(planNon.screenCoverage, 'goUnder');
  assert.ok(planNon.dropId === bigDef.id && (planNon.dropSpot?.x ?? 0) > 8.5, 'drop coverage pulls big into paint');
  const coachNon = createCoach();
  const cNon = coachNon.controls(s, new Set(), { '1-0': { move: { x: 0, z: 0 }, defenseScheme: 'man' } });
  assert.ok(cNon[onBallDef.id].move.x > 0.3, 'goUnder should duck behind screen toward basket');

  // Switch All -> screener defender switches coverage assignment.
  const planSwitch = defensiveAssignments(team, foes, handler, rim, 3, 'switch');
  assert.equal(planSwitch.screenCoverage, 'switch');
  assert.equal(planSwitch.guard?.id, bigDef.id);
});

test('X-Out closeouts rotate on kick-out passes and 5v5 rebound logic mixes box-outs with transition leak-out', () => {
  // X-Out closeout on perimeter kick-out catch.
  const rim = { x: 12.65, z: 0 };
  const kick = fullFixture();
  kick.players[0].position = { x: 10.6, z: 0.4 }; // paint penetrator
  kick.players[2].position = { x: 6.4, z: -5.4 }; // open perimeter kick-out target
  kick.players[3].position = { x: 11.4, z: 6.8 }; // corner shooter exposed by rotation
  kick.players[7].position = { x: 9.2, z: -3.2 }; // helper shifting to close out kick-out
  kick.players[8].position = { x: 10.4, z: 1.8 }; // weak-side rotator covering exposed corner
  const team = kick.players.filter(p => p.side === 1);
  const foes = kick.players.filter(p => p.side === 0);
  // Catcher now holds ball (`0-2`) immediately after kick-out.
  kick.ball.ownerId = '0-2';
  const kickPlan = defensiveAssignments(team, foes, kick.players[2], rim, 4, 'man', { targetId: '0-2', until: 50 });
  assert.equal(kickPlan.closeoutId, '1-2', 'nearest defender closes out onto kick-out shooter');
  assert.ok(kickPlan.xOutId && kickPlan.xOutSpot, 'weak-side defender executes X-out rotation onto exposed shooter');

  // 5v5 rebound: interior big seals opponent with screen:true while furthest perimeter guard leaks out upcourt.
  const reb = fullFixture();
  reb.ball = { kind: 'shot', ownerId: null, position: { x: 12.2, y: 3.1, z: 0 }, velocity: { x: -0.8, y: 1.5, z: 0 } };
  reb.players[4].position = { x: 10.6, z: 0.8 }; // offensive crasher
  reb.players[3].position = { x: 10.4, z: -1.4 }; // second crasher
  reb.players[9].position = { x: 11.15, z: 0.55 }; // defending center inside seal spot
  reb.players[8].position = { x: 10.95, z: -1.0 }; // defending PF inside paint
  reb.players[7].position = { x: 9.5, z: -3.8 }; // wing closer to arc
  reb.players[6].position = { x: 10.2, z: 4.1 }; // weak-side wing
  reb.players[5].position = { x: 6.4, z: 1.5 }; // perimeter guard furthest from rim (`1-0`)
  const rOut = createCoach().controls(reb);
  assert.equal(rOut['1-4'].screen, true, 'inside big holds box-out screen on offensive crasher');
  assert.ok(rOut['1-0'].sprint && rOut['1-0'].move.x < -0.4,
    `perimeter guard should leak out upcourt when paint rebounders have numbers (move.x=${rOut['1-0'].move.x.toFixed(2)})`);
});

test('5v5 multi-quarter simulation finishes cleanly with finite physics, balanced turnovers, shooting, and assists', () => {
  const teams: [Team, Team] = [fixtureTeam('alpha'), fixtureTeam('bravo', 'West')];
  const engine = createEngine(teams, { periods: 2, periodSeconds: 180, difficulty: 'All-Star', seed: 101 });
  const coach = createCoach();
  for (let t = 0; t < 26000 && engine.state.phase !== 'final'; t++) {
    engine.step(coach.controls(engine.state));
    const b = engine.state.ball.position;
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z), 'ball position stays finite');
  }
  const s = engine.state;
  assert.equal(s.phase, 'final');
  const fga = s.events.filter(e => e.type === 'shot').length;
  const fgm = s.events.filter(e => e.type === 'score' && e.detail !== 'Free throw').length;
  const tov = s.events.filter(e => e.type === 'turnover').length;
  const reb = s.events.filter(e => e.type === 'rebound').length;
  const passes = s.events.filter(e => e.type === 'pass').length;
  assert.ok(fga >= 25, `5v5 game should generate healthy shot volume (fga=${fga})`);
  assert.ok(fgm > 0 && fgm < fga, '5v5 field-goal conversion stays realistic');
  assert.ok(tov <= 28, `turnovers should stay bounded after live-ball tuning (tov=${tov})`);
  assert.ok(reb >= 8 && passes >= 12, `game should record rebounds (${reb}) and ball movement passes (${passes})`);
});
