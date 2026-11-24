import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoach } from '../packages/basketball-ai/index.ts';
import type { GamePlayer, GameState, Player, Team } from '../packages/contracts/index.ts';

function fixture(): GameState {
  const ratings = { shooting: 80, finishing: 80, passing: 80, handling: 80, rebounding: 80, speed: 80, perimeter: 80, interior: 80, iq: 80, durability: 80 };
  const teams: [Team, Team] = [0,1].map(side => ({
    id: String(side), city: 'City', name: 'Club', abbreviation: 'C', color: '#fff', accent: '#000', conference: 'East',
    roster: ['PG','C'].map((position, i): Player => ({
      id: side + '-' + i, name: 'Player', number: i, position: position as Player['position'], height: 200,
      age: 25, overall: 80, potential: 85, ratings
    }))
  })) as [Team, Team];
  const players = teams.flatMap((team, side) => team.roster.map((profile,i): GamePlayer => ({
    id: profile.id, profile, side: side as 0 | 1, position: { x: side ? -7 : 11 - i * 7, z: i * 4 },
    velocity: { x: 0, z: 0 }, stamina: 100, facing: 0, pose: 'idle'
  })));
  return { tick: 0, teams, players, score: [0,0], possession: 0, period: 1, clock: 60, shotClock: 24,
    phase: 'live', events: [], config: { difficulty: 'Legendary', seed: 83 }, charge: {},
    ball: { kind: 'held', ownerId: players[0].id, position: { x: 11, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 } } };
}

test('coach excludes exactly the current human players across both teams', () => {
  const state = fixture(), coach = createCoach();
  const users = new Set(['0-0','1-1']);
  assert.deepEqual(Object.keys(coach.controls(state, users)).sort(), ['0-1','1-0']);
  users.clear();
  assert.equal(Object.keys(coach.controls(state, users)).length, 4);
});

test('open finisher holds for the release window and sends a falling edge', () => {
  const state = fixture(), a = createCoach(), b = createCoach();
  const shots: number[] = [];
  for (let tick = 0; tick < 65; tick++) {
    state.tick = tick;
    const frame = a.controls(state);
    assert.deepEqual(frame, b.controls(state));
    if (frame['0-0'].shoot) shots.push(tick);
    if (shots.length && !frame['0-0'].shoot) {
      assert.equal(frame['0-0'].shoot, false);
      assert.ok(shots.length >= 34 && shots.length <= 40);
      return;
    }
  }
  assert.fail('finisher did not release');
});

test('trapped handler passes to a wide-open finisher', () => {
  const state = fixture(), coach = createCoach();
  state.players[0].position = { x: 2, z: -4 };
  state.players[1].position = { x: 11, z: 1 };
  state.players[2].position = { x: 2, z: -3.8 };
  for (let tick = 0; tick < 60; tick++) {
    state.tick = tick;
    const decision = coach.controls(state)['0-0'];
    if (decision.pass) {
      assert.equal(decision.targetId, '0-1');
      return;
    }
  }
  assert.fail('handler never passed');
});

test('away ballhandler attacks the shared basket in half court', () => {
  const state = fixture(), coach = createCoach();
  state.possession = 1;
  state.ball.ownerId = '1-0';
  state.config.halfCourt = true;
  assert.ok(coach.controls(state)['1-0'].move.x > 0);
  state.config.halfCourt = false;
  assert.ok(coach.controls(state)['1-0'].move.x < 0);
});

test('a chosen screener sets their feet before rolling or popping', () => {
  for (const stretch of [false, true]) {
    const state = fixture(), coach = createCoach();
    state.players[0].position = { x: 6, z: 0 };
    state.players[1].position = { x: 8.25, z: 2 };
    state.players[2].position = { x: 7, z: -0.2 };
    if (stretch) {
      const screener = state.players[1];
      screener.profile = { ...screener.profile, ratings: { ...screener.profile.ratings, shooting: 91 } };
    }
    coach.controls(state);
    state.tick = 16;
    assert.ok(coach.controls(state)['0-1'].move.x < 0, 'screener approaches the ball defender');
    state.tick++;
    state.players[1].position = { x: 6.88, z: 1.15 };
    const planted = coach.controls(state);
    assert.equal(planted['0-1'].screen, true);
    assert.ok(planted['0-0'].move.z > 0, 'handler turns the corner on the outside of the screen');
    state.tick = 42;
    const follow = coach.controls(state)['0-1'];
    assert.ok(!follow.screen);
    assert.ok(stretch ? follow.move.x < 0 : follow.move.x > 0);
    assert.ok(follow.move.z < 0);
  }
});

test('the CPU uses shooting and finishing profiles to choose different shot zones', () => {
  function takesShot(position: GamePlayer['position'], shooting: number, finishing: number, handling: number) {
    const state = fixture(), coach = createCoach();
    const handler = state.players[0];
    handler.position = position;
    handler.profile = { ...handler.profile, ratings: { ...handler.profile.ratings, shooting, finishing, handling } };
    for (let tick = 0; tick < 30; tick++) {
      state.tick = tick;
      if (coach.controls(state)[handler.id].shoot) return true;
    }
    return false;
  }
  assert.ok(takesShot({ x: 5.2, z: 0 }, 99, 86, 92));
  assert.ok(!takesShot({ x: 5.2, z: 0 }, 79, 97, 96));
  assert.ok(takesShot({ x: 8, z: 2.7 }, 82, 98, 96));
});

test('transition sends the big ahead through the middle before half-court spacing', () => {
  const state = fixture();
  state.players[0].position = { x: -5, z: 0 };
  state.players[1].position = { x: -2, z: 4 };
  const control = createCoach().controls(state)['0-1'];
  assert.ok(control.sprint);
  assert.ok(control.move.x > 0.5);
  assert.ok(control.move.z < -0.3);
});

test('the interior defender helps on a drive and then seals the rebound', () => {
  const state = fixture();
  state.players[0].position = { x: 8.4, z: 2 };
  state.players[0].velocity = { x: 3.7, z: 0 };
  state.players[1].position = { x: 10.8, z: -2 };
  state.players[2].position = { x: 8.4, z: 3 };
  state.players[3].position = { x: 11, z: -1.55 };
  const coach = createCoach();
  assert.ok(coach.controls(state)['1-1'].move.z > 0.6);
  state.tick++;
  state.ball.kind = 'shot';
  state.ball.ownerId = null;
  state.players[3].position = { x: 11.27, z: -1.49 };
  assert.equal(coach.controls(state)['1-1'].screen, true);
});

test('an elite passing big offers an outlet at the high post', () => {
  const state = fixture();
  state.players[0].position = { x: 6, z: 2.8 };
  const center = state.players[1];
  center.position = { x: 8.7, z: -4 };
  center.profile = { ...center.profile, ratings: { ...center.profile.ratings, passing: 97, iq: 91 } };
  const control = createCoach().controls(state)[center.id];
  assert.ok(control.move.x < 0 && control.move.z > 0);
});

test('a moving CPU receiver adjusts toward the lead pass while the ball is in flight', () => {
  const state = fixture(), coach = createCoach();
  state.players[0].position = { x: 2, z: -4 };
  state.players[1].position = { x: 11, z: 1 };
  state.players[1].velocity = { x: 0, z: 2 };
  state.players[2].position = { x: 2, z: -3.8 };
  while (state.tick < 60 && !coach.controls(state)['0-0'].pass) state.tick++;
  assert.ok(state.tick < 60);
  state.tick++;
  state.ball.ownerId = null;
  state.ball.kind = 'pass';
  assert.ok(coach.controls(state)['0-1'].move.z > 0);
  state.tick++;
  state.players[1].position.z = 3.4;
  assert.ok(coach.controls(state)['0-1'].move.z < 0);
});

test('an opening outlet advances a possession through a clear lane', () => {
  for (const blocked of [false, true]) {
    const state = fixture(), coach = createCoach();
    state.players[0].position = { x: -2, z: 0 };
    state.players[1].position = { x: 4, z: 4 };
    if (blocked) state.players[2].position = { x: 1, z: 2 };
    coach.controls(state);
    state.tick = 24;
    const control = coach.controls(state)['0-0'];
    if (blocked) assert.ok(!control.pass);
    else {
      assert.equal(control.pass, true);
      assert.equal(control.targetId, '0-1');
    }
  }
});
