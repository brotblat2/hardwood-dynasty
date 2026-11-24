import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputState, DEFAULT_KEYBOARD_BINDINGS as bindings, gamepadMove } from '../packages/controls/input.ts';

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
