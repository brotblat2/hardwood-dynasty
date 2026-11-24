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
