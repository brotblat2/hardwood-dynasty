import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { GamePlayer } from '../packages/contracts/index.ts';
import {
  createInputState, DEFAULT_KEYBOARD_BINDINGS as bindings, deriveShotType, gamepadMove,
  mergeBindings, selectDirectionalPassTarget, selectSwitchTarget,
} from '../packages/controls/input.ts';

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

test('partial saved bindings safely merge with defaults and support icon passing', () => {
  const legacy = { shoot: ['KeyU'] };
  const merged = mergeBindings(legacy);
  assert.deepEqual(merged.shoot, ['KeyU']);
  assert.deepEqual(merged.pumpFake, ['KeyV']);
  const input = createInputState(legacy);
  input.keyDown('KeyV', legacy);
  input.keyDown('Tab', legacy);
  input.keyDown('Digit2', legacy);
  const c = input.read(legacy);
  assert.equal(c.pumpFake, true);
  assert.equal(c.iconPassToggle, true);
  assert.equal(c.iconSlot, 1);
  assert.equal(input.read(legacy).pumpFake, false);
});

test('pro-stick hold initiates shot with direction and quick flick triggers dribble', () => {
  const input = createInputState();
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { axes: [0, 0, 0.85, 0], buttons };
  for (let i = 0; i < 6; i++) input.sampleGamepad(pad);
  const holding = input.read(bindings, pad);
  assert.equal(holding.shoot, true);
  assert.ok(holding.proStick && holding.proStick.x > 0.5);
  pad.axes = [0, 0, 0, 0];
  assert.equal(input.read(bindings, pad).shoot, false);

  pad.axes = [0, 0, 0.85, 0];
  input.sampleGamepad(pad);
  input.sampleGamepad(pad);
  pad.axes = [0, 0, 0, 0];
  input.sampleGamepad(pad);
  const flick = input.read(bindings, pad);
  assert.equal(flick.shoot, false);
  assert.equal(flick.dribble, true);
});

test('smart player switching aligns directionally and avoids two-player ping-pong', () => {
  const team = fixtureTeam('home');
  const mk = (i: number, x: number, z: number): GamePlayer => ({
    id: team.roster[i].id, profile: team.roster[i], side: 0,
    position: { x, z }, velocity: { x: 0, z: 0 }, facing: 0, stamina: 100, pose: 'idle',
  });
  const cur = mk(0, 0, 0), near = mk(1, 1, 1), right = mk(2, 6, 0), third = mk(3, 2, -2);
  const all = [cur, near, right, third];
  assert.equal(selectSwitchTarget(cur, all, { x: 0, z: 0 }, { x: 1, z: 0 }), right.id);
  assert.equal(selectSwitchTarget(cur, all, { x: 0, z: 0 }, { x: 0, z: 0 }, [near.id]), third.id);
});

test('controls map intenseD, capture directional dribbleDir, and derive euro step', () => {
  const input = createInputState();
  input.keyDown('KeyZ', bindings);
  assert.equal(input.read(bindings).intenseD, true);
  input.keyUp('KeyZ');
  assert.equal(input.read(bindings).intenseD, false);

  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  buttons[6] = { pressed: true, touched: true, value: 1 };
  const pad = { axes: [0, 0, 0, 0], buttons };
  assert.equal(input.read(bindings, pad).intenseD, true);
  buttons[0] = { pressed: true, touched: true, value: 1 };
  const bounceFrame = input.read(bindings, pad);
  assert.equal(bounceFrame.passType, 'bounce');
  assert.equal(bounceFrame.intenseD, false);

  input.clear();
  input.keyDown('KeyD', bindings);
  input.keyDown('KeyF', bindings);
  const keyDribble = input.read(bindings);
  assert.equal(keyDribble.dribble, true);
  assert.ok((keyDribble.dribbleDir?.x ?? 0) > 0.5);
  input.clear();

  const stickButtons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const stickPad = { axes: [0, 0, -0.9, 0], buttons: stickButtons };
  input.sampleGamepad(stickPad);
  input.sampleGamepad(stickPad);
  stickPad.axes = [0, 0, 0, 0];
  input.sampleGamepad(stickPad);
  const flick = input.read(bindings, stickPad);
  assert.equal(flick.dribble, true);
  assert.ok((flick.dribbleDir?.x ?? 0) < -0.5);

  const team = fixtureTeam('home');
  const slasher: GamePlayer = {
    id: team.roster[0].id, profile: team.roster[0], side: 0,
    position: { x: 9.8, z: 0 }, velocity: { x: 0, z: 0 }, facing: 0, stamina: 100, pose: 'dribble',
  };
  const rim = { x: 12.65, z: 0 };
  assert.equal(deriveShotType(slasher, { x: 0.45, z: 0.89 }, rim, { dribble: true, sprint: false }), 'euro');
});
