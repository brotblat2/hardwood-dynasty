import type { Control, Vec2 } from '../contracts/index.ts';

export type PlayerControl = Control & { switchPlayer?: boolean };

export const DEFAULT_KEYBOARD_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  shoot: ['Space'],
  pass: ['KeyJ'],
  bouncePass: ['KeyK'],
  lobPass: ['KeyL'],
  contest: ['KeyC'],
  steal: ['KeyX'],
  screen: ['KeyE'],
  dribble: ['KeyF'],
  switchPlayer: ['KeyQ'],
} as const;

export type InputAction = keyof typeof DEFAULT_KEYBOARD_BINDINGS;
export type KeyboardBindings = Record<InputAction, readonly string[]>;
export type TouchAction = Exclude<InputAction, 'up' | 'down' | 'left' | 'right'>;
export type TouchInput = {
  move: (position: Vec2) => void;
  press: (pointer: number, action: TouchAction) => void;
  release: (pointer: number) => void;
  cancel: (pointer: number) => void;
  clear: () => void;
};
type Source = { move: Vec2; down: (action: InputAction) => boolean };
type GamepadInput = Pick<Gamepad, 'axes' | 'buttons'>;

export const KEYBOARD_HINTS = [
  ['Move', 'WASD or arrows'], ['Sprint', 'Shift'], ['Shoot', 'Hold and release Space'],
  ['Pass', 'J'], ['Bounce pass', 'K'], ['Lob pass', 'L'],
  ['Contest / rebound', 'C'], ['Steal', 'X'], ['Switch player', 'Q'],
  ['Screen', 'E'], ['Dribble move', 'F'],
] as const;

export const GAMEPAD_HINTS = [
  ['Move', 'Left stick or D-pad'], ['Sprint', 'RT / R2'], ['Shoot', 'Hold and release X / Square'],
  ['Pass', 'A / Cross'], ['Bounce pass', 'LT / L2 + pass'], ['Lob pass', 'Left stick click + pass'],
  ['Contest / rebound', 'Y / Triangle'], ['Steal', 'B / Circle'], ['Switch player', 'LB / L1'],
  ['Screen', 'RB / R1'], ['Dribble move', 'Right stick click'],
] as const;

export function limitMove(x: number, z: number): Vec2 {
  const length = Math.max(1, Math.hypot(x, z));
  return { x: x / length, z: z / length };
}

const GAMEPAD_DEAD_ZONE = 0.18;

export function gamepadMove(x: number, z: number): Vec2 {
  const distance = Math.hypot(x, z);
  if (distance <= GAMEPAD_DEAD_ZONE) return { x: 0, z: 0 };
  const magnitude = Math.min(1, (distance - GAMEPAD_DEAD_ZONE) / (1 - GAMEPAD_DEAD_ZONE));
  return { x: x * magnitude / distance, z: z * magnitude / distance };
}

function gamepadSource(gamepad?: GamepadInput): Source {
  const button = (index: number) => {
    const value = gamepad?.buttons[index];
    return !!value && (value.pressed || value.value > 0.5);
  };
  const dpad = limitMove(Number(button(15)) - Number(button(14)), Number(button(13)) - Number(button(12)));
  const stick = gamepadMove(gamepad?.axes[0] ?? 0, gamepad?.axes[1] ?? 0);
  const pass = button(0);
  const buttons: Partial<Record<InputAction, boolean>> = {
    sprint: button(7),
    shoot: button(2),
    pass,
    bouncePass: pass && button(6),
    lobPass: pass && button(10),
    contest: button(3),
    steal: button(1),
    screen: button(5),
    dribble: button(11),
    switchPlayer: button(4),
  };
  return {
    move: dpad.x || dpad.z ? dpad : stick,
    down: (action) => buttons[action] ?? false,
  };
}

const pulseActions = new Set<InputAction>(['shoot', 'pass', 'bouncePass', 'lobPass', 'switchPlayer', 'steal', 'screen', 'dribble', 'contest']);

export function createInputState() {
  const keys = new Set<string>();
  const keyPulses = new Set<InputAction>();
  const touchActions = new Map<number, TouchAction>();
  const touchPulses = new Map<number, TouchAction>();
  let touchMove: Vec2 = { x: 0, z: 0 };
  let gamepadSwitch = false;

  const touch: TouchInput = {
    move: (position) => { touchMove = position; },
    press(pointer, action) {
      if (pulseActions.has(action) && !Array.from(touchActions.values()).includes(action)) {
        touchPulses.set(pointer, action);
      }
      touchActions.set(pointer, action);
    },
    release(pointer) { touchActions.delete(pointer); },
    cancel(pointer) {
      touchActions.delete(pointer);
      touchPulses.delete(pointer);
    },
    clear() {
      touchActions.clear();
      touchPulses.clear();
      touchMove = { x: 0, z: 0 };
    },
  };

  return {
    touch,
    keyDown(code: string, bindings: KeyboardBindings) {
      if (keys.has(code)) return;
      for (const action of pulseActions) {
        if (bindings[action].includes(code) && !bindings[action].some((key) => keys.has(key))) keyPulses.add(action);
      }
      keys.add(code);
    },
    keyUp(code: string) { keys.delete(code); },
    clear() {
      keys.clear();
      keyPulses.clear();
      touch.clear();
    },
    read(bindings: KeyboardBindings, gamepad?: GamepadInput): PlayerControl {
      const keyDown = (action: InputAction) => bindings[action].some((code) => keys.has(code));
      const keyMove = limitMove(
        Number(keyDown('right')) - Number(keyDown('left')),
        Number(keyDown('down')) - Number(keyDown('up')),
      );
      const pad = gamepadSource(gamepad);
      const move = [keyMove, touchMove, pad.move].reduce((strongest, candidate) =>
        Math.hypot(candidate.x, candidate.z) > Math.hypot(strongest.x, strongest.z) ? candidate : strongest,
      );
      const touchDown = new Set<InputAction>(touchActions.values());
      const touchPressed = new Set<InputAction>(touchPulses.values());
      const down = (action: InputAction) => keyDown(action) || keyPulses.has(action)
        || touchDown.has(action) || touchPressed.has(action) || pad.down(action);
      const nextGamepadSwitch = pad.down('switchPlayer');
      const switchPlayer = keyPulses.has('switchPlayer') || touchPressed.has('switchPlayer') || (nextGamepadSwitch && !gamepadSwitch);
      gamepadSwitch = nextGamepadSwitch;
      const bounce = down('bouncePass');
      const lob = down('lobPass');
      const pass = down('pass') || bounce || lob;
      const control: PlayerControl = {
        move,
        sprint: down('sprint'),
        shoot: down('shoot'),
        pass,
        passType: pass ? (lob ? 'lob' : bounce ? 'bounce' : 'chest') : undefined,
        contest: down('contest'),
        steal: down('steal'),
        screen: down('screen'),
        dribble: down('dribble'),
        switchPlayer,
      };
      keyPulses.clear();
      touchPulses.clear();
      return control;
    },
  };
}
