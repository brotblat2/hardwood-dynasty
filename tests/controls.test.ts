import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { GamePlayer } from '../packages/contracts/index.ts';
import { createInputState, DEFAULT_KEYBOARD_BINDINGS as bindings, gamepadMove, selectDirectionalPassTarget } from '../packages/controls/input.ts';

test('movement normalizes diagonal input and typing opposite directions cancels', () => {
  const input = createInputState();
  input.keyDown('KeyD', bindings);
  input.keyDown('KeyW', bindings);
  const diagonal = input.read(bindings).move;
  assert.ok(diagonal.x > 0);
  assert.equal(diagonal.x, -diagonal.z);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 1e-10);
  input.keyDown('ArrowLeft', bindings);
  assert.deepEqual(input.read(bindings).move, { x: 0, z: -1 });
  input.clear();
  assert.deepEqual(input.read(bindings).move, { x: 0, z: 0 });
});

test('shoot is held through reads, and a quick tap survives a frame boundary', () => {
  const input = createInputState();
  input.keyDown('Space', bindings);
  assert.equal(input.read(bindings).shoot, true);
  assert.equal(input.read(bindings).shoot, true);
  input.keyUp('Space');
  assert.equal(input.read(bindings).shoot, false);
  input.keyDown('Space', bindings);
  input.keyUp('Space');
  assert.equal(input.read(bindings).shoot, true);
  assert.equal(input.read(bindings).shoot, false);
});

test('switch player produces a single command per keyboard or gamepad press', () => {
  const input = createInputState();
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const gamepad = { axes: [0, 0], buttons };
  input.keyDown('KeyQ', bindings);
  assert.equal(input.read(bindings, gamepad).switchPlayer, true);
  input.keyDown('KeyQ', bindings);
  assert.equal(input.read(bindings, gamepad).switchPlayer, false);
  input.keyUp('KeyQ');
  buttons[4].pressed = true;
  assert.equal(input.read(bindings, gamepad).switchPlayer, true);
  assert.equal(input.read(bindings, gamepad).switchPlayer, false);
  input.read(bindings);
  assert.equal(input.read(bindings, gamepad).switchPlayer, true);
});

test('touch movement and actions remain independent and cancellation drops an unsampled press', () => {
  const input = createInputState();
  input.touch.move({ x: 0.5, z: 0 });
  input.touch.press(1, 'sprint');
  input.touch.press(2, 'lobPass');
  input.touch.release(2);
  input.touch.press(3, 'shoot');
  input.touch.cancel(3);
  const control = input.read(bindings);
  assert.deepEqual(control.move, { x: 0.5, z: 0 });
  assert.equal(control.sprint, true);
  assert.equal(control.passType, 'lob');
  assert.equal(control.shoot, false);
  assert.equal(input.read(bindings).pass, false);
});

test('gamepad dead zone suppresses drift and maintains analog direction', () => {
  assert.deepEqual(gamepadMove(0.1, 0.1), { x: 0, z: 0 });
  assert.deepEqual(gamepadMove(0, -1), { x: 0, z: -1 });
  const move = gamepadMove(1, 1);
  assert.ok(Math.abs(Math.hypot(move.x, move.z) - 1) < 1e-10);
  assert.equal(move.x, move.z);
});


test('a shot release between ticks still fires before a new press charges', () => {
  const input = createInputState();
  input.keyDown('Space', bindings);
  assert.equal(input.read(bindings).shoot, true);
  input.keyUp('Space');
  input.keyDown('Space', bindings);
  assert.equal(input.read(bindings).shoot, false);
  assert.equal(input.read(bindings).shoot, true);
});

test('simultaneous touch movement, sprint and shot have independent lifetimes', () => {
  const input = createInputState();
  input.touch.move({ x: 1, z: 0 });
  input.touch.press(1, 'sprint');
  input.touch.press(2, 'shoot');
  const held = input.read(bindings);
  assert.deepEqual(held.move, { x: 1, z: 0 });
  assert.equal(held.sprint, true);
  assert.equal(held.shoot, true);
  input.touch.press(3, 'sprint');
  input.touch.release(1);
  input.touch.release(2);
  const released = input.read(bindings);
  assert.equal(released.sprint, true);
  assert.equal(released.shoot, false);
  input.touch.release(3);
  assert.equal(input.read(bindings).sprint, false);
});

test('pass presses preserve their aim and type even when movement changes before the tick', () => {
  const input = createInputState();
  input.keyDown('KeyA', bindings);
  input.keyDown('KeyK', bindings);
  input.keyUp('KeyK');
  input.keyUp('KeyA');
  input.touch.move({ x: 0, z: 1 });
  input.touch.press(1, 'lobPass');
  input.touch.release(1);
  input.touch.move({ x: 0, z: 0 });
  input.keyDown('KeyD', bindings);
  const bounce = input.read(bindings);
  assert.deepEqual(bounce.move, { x: 1, z: 0 });
  assert.deepEqual(bounce.passAim, { x: -1, z: 0 });
  assert.equal(bounce.passType, 'bounce');
  const lob = input.read(bindings);
  assert.deepEqual(lob.passAim, { x: 0, z: 1 });
  assert.equal(lob.passType, 'lob');
  assert.equal(input.read(bindings).pass, false);
});

test('gamepad samples preserve fast taps and right stick aims without moving', () => {
  const input = createInputState();
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const gamepad = { axes: [0, 0, 0, -1], buttons };
  buttons[0].pressed = true;
  buttons[2].pressed = true;
  buttons[6].pressed = true;
  input.sampleGamepad(gamepad);
  buttons[0].pressed = false;
  buttons[2].pressed = false;
  gamepad.axes[3] = 0;
  input.sampleGamepad(gamepad);
  const control = input.read(bindings, gamepad);
  assert.deepEqual(control.move, { x: 0, z: 0 });
  assert.deepEqual(control.passAim, { x: 0, z: -1 });
  assert.equal(control.passType, 'bounce');
  assert.equal(control.shoot, true);
  const released = input.read(bindings, gamepad);
  assert.equal(released.pass, false);
  assert.equal(released.shoot, false);
});

test('directional passing favors aligned teammates and leaves neutral aim to automatic targeting', () => {
  const team = fixtureTeam('home');
  function player(index: number, x: number, z: number, side: GamePlayer['side'] = 0): GamePlayer {
    const profile = team.roster[index];
    return { id: profile.id, profile, side, position: { x, z }, velocity: { x: 0, z: 0 }, facing: 0, stamina: 100, pose: 'idle' };
  }
  const passer = player(0, 0, 0);
  const near = player(1, 1, 3);
  const aligned = player(2, 8, 0);
  const opponent = player(3, 1, 0, 1);
  const players = [passer, near, aligned, opponent];
  assert.equal(selectDirectionalPassTarget(passer, players, { x: 0.4, z: 0 }), aligned.id);
  assert.equal(selectDirectionalPassTarget(passer, players, { x: 1, z: 0 }), aligned.id);
  assert.equal(selectDirectionalPassTarget(passer, players, { x: 0, z: 1 }), near.id);
  assert.equal(selectDirectionalPassTarget(passer, players, { x: 0.1, z: 0 }), undefined);
  assert.equal(selectDirectionalPassTarget(passer, players, { x: -1, z: 0 }), undefined);
});
