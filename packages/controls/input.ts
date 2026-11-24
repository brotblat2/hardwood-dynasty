import type { Control, GamePlayer, Vec2 } from '../contracts/index.ts';

export type PlayerControl = Control & { switchPlayer?: boolean; passAim?: Vec2 };

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
type Source = { move: Vec2; aim: Vec2; down: (action: TouchAction) => boolean };
type GamepadInput = Pick<Gamepad, 'axes' | 'buttons'>;

export const KEYBOARD_HINTS = [
  ['Move', 'WASD or arrows'], ['Sprint', 'Shift'], ['Shoot', 'Hold and release Space'],
  ['Pass', 'J, aim with movement'], ['Bounce pass', 'K'], ['Lob pass', 'L'],
  ['Contest / rebound', 'C'], ['Steal', 'X'], ['Switch player', 'Q'],
  ['Screen', 'E'], ['Dribble move', 'F'],
] as const;

export const GAMEPAD_HINTS = [
  ['Move', 'Left stick or D-pad'], ['Sprint', 'RT / R2'], ['Shoot', 'Hold and release X / Square'],
  ['Pass', 'A / Cross, aim with either stick'], ['Bounce pass', 'LT / L2 + pass'], ['Lob pass', 'Left stick click + pass'],
  ['Contest / rebound', 'Y / Triangle'], ['Steal', 'B / Circle'], ['Switch player', 'LB / L1'],
  ['Screen', 'RB / R1'], ['Dribble move', 'Right stick click'],
] as const;

export function limitMove(x: number, z: number): Vec2 {
  const length = Math.max(1, Math.hypot(x, z));
  return { x: x / length, z: z / length };
}

const STILL: Vec2 = { x: 0, z: 0 };
const PASS_AIM_MINIMUM = 0.22;

export function gamepadMove(x: number, z: number, deadZone = 0.16): Vec2 {
  const distance = Math.hypot(x, z);
  if (!Number.isFinite(distance) || distance <= deadZone) return STILL;
  const travel = Math.min(1, (distance - deadZone) / (1 - deadZone));
  const magnitude = travel * (0.55 + 0.45 * travel);
  return { x: x * magnitude / distance, z: z * magnitude / distance };
}

function gamepadSource(gamepad?: GamepadInput): Source {
  const button = (index: number) => {
    const value = gamepad?.buttons[index];
    return !!value && (value.pressed || value.value > 0.5);
  };
  const dpad = limitMove(Number(button(15)) - Number(button(14)), Number(button(13)) - Number(button(12)));
  const stick = gamepadMove(gamepad?.axes[0] ?? 0, gamepad?.axes[1] ?? 0);
  const aim = gamepadMove(gamepad?.axes[2] ?? 0, gamepad?.axes[3] ?? 0, 0.2);
  const pass = button(0);
  const buttons: Partial<Record<TouchAction, boolean>> = {
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
    aim,
    down: (action) => buttons[action] ?? false,
  };
}

export function selectDirectionalPassTarget(passer: GamePlayer, teammates: readonly GamePlayer[], aim: Vec2) {
  const magnitude = Math.hypot(aim.x, aim.z);
  if (!Number.isFinite(magnitude) || magnitude < PASS_AIM_MINIMUM) return undefined;
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const teammate of teammates) {
    if (teammate.side !== passer.side || teammate.id === passer.id) continue;
    const x = teammate.position.x - passer.position.x;
    const z = teammate.position.z - passer.position.z;
    const distance = Math.hypot(x, z);
    if (distance < 0.01) continue;
    const alignment = (x * aim.x + z * aim.z) / (distance * magnitude);
    if (alignment < 0.35) continue;
    const score = alignment * 4 - distance * 0.07;
    if (score <= bestScore) continue;
    best = teammate.id;
    bestScore = score;
  }
  return best;
}

const passActions = ['lobPass', 'bouncePass', 'pass'] as const;
type PassAction = (typeof passActions)[number];
const heldActions = ['sprint', 'contest', 'steal', 'screen', 'dribble'] as const;
const bufferedActions = [...passActions, 'switchPlayer', ...heldActions] as const;
type BufferedAction = (typeof bufferedActions)[number];
type TouchPress = { action: TouchAction };
type BufferedPress = { action: BufferedAction; aim?: Vec2; touch?: TouchPress };
const isPassAction = (action: BufferedAction): action is PassAction => passActions.some((pass) => pass === action);
type ShootEdge = { down: boolean; touch?: TouchPress };

export function createInputState(initialBindings: KeyboardBindings = DEFAULT_KEYBOARD_BINDINGS) {
  const keys = new Set<string>();
  const touchActions = new Map<number, TouchPress>();
  const presses: BufferedPress[] = [];
  const shootEdges: ShootEdge[] = [];
  let lastShoot = false;
  let bindings = initialBindings;
  let touchMove = STILL;
  let pad = gamepadSource();

  const keyDown = (action: InputAction) => bindings[action].some((code) => keys.has(code));
  const touchDown = (action: TouchAction) => [...touchActions.values()].some((press) => press.action === action);
  const shootDown = () => keyDown('shoot') || touchDown('shoot') || pad.down('shoot');
  const activeMove = () => {
    const keyMove = limitMove(
      Number(keyDown('right')) - Number(keyDown('left')),
      Number(keyDown('down')) - Number(keyDown('up')),
    );
    return [keyMove, touchMove, pad.move].reduce((strongest, candidate) =>
      Math.hypot(candidate.x, candidate.z) > Math.hypot(strongest.x, strongest.z) ? candidate : strongest,
    );
  };
  const aimForPass = (move: Vec2) => Math.hypot(pad.aim.x, pad.aim.z) >= PASS_AIM_MINIMUM ? pad.aim : move;
  const changeShoot = (update: () => void, touch?: TouchPress) => {
    const previous = shootDown();
    update();
    const down = shootDown();
    if (down !== previous) shootEdges.push({ down, touch });
  };
  const takePress = (actions: readonly BufferedAction[]) => {
    const index = presses.findIndex(({ action }) => actions.includes(action));
    return index < 0 ? undefined : presses.splice(index, 1)[0];
  };
  const discardTouch = (touch?: TouchPress) => {
    for (const buffer of [presses, shootEdges]) {
      for (let index = buffer.length - 1; index >= 0; index--) {
        if (buffer[index].touch && (!touch || buffer[index].touch === touch)) buffer.splice(index, 1);
      }
    }
  };
  const sampleGamepad = (gamepad?: GamepadInput) => {
    const last = pad;
    changeShoot(() => { pad = gamepadSource(gamepad); });
    if (pad.down('pass') && !last.down('pass')) {
      const action = passActions.find((candidate) => pad.down(candidate)) ?? 'pass';
      presses.push({ action, aim: aimForPass(activeMove()) });
    }
    for (const action of ['switchPlayer', ...heldActions] as const) {
      if (pad.down(action) && !last.down(action)) presses.push({ action });
    }
  };

  const touch: TouchInput = {
    move: (position) => { touchMove = limitMove(position.x, position.z); },
    press(pointer, action) {
      if (touchActions.has(pointer)) return;
      const press = { action };
      const wasDown = touchDown(action);
      changeShoot(() => { touchActions.set(pointer, press); }, press);
      if (action !== 'shoot' && !wasDown) {
        const aim = isPassAction(action) ? aimForPass(activeMove()) : undefined;
        presses.push({ action, aim, touch: press });
      }
    },
    release(pointer) {
      const press = touchActions.get(pointer);
      if (press) changeShoot(() => { touchActions.delete(pointer); }, press);
    },
    cancel(pointer) {
      const press = touchActions.get(pointer);
      if (press) {
        changeShoot(() => { touchActions.delete(pointer); });
        discardTouch(press);
      }
    },
    clear() {
      touchActions.clear();
      discardTouch();
      touchMove = STILL;
    },
  };

  return {
    touch,
    sampleGamepad,
    keyDown(code: string, nextBindings: KeyboardBindings) {
      bindings = nextBindings;
      if (keys.has(code)) return;
      const next = bufferedActions.filter((action) => bindings[action].includes(code) && !keyDown(action));
      changeShoot(() => { keys.add(code); });
      const pass = passActions.find((action) => next.includes(action));
      if (pass) presses.push({ action: pass, aim: aimForPass(activeMove()) });
      for (const action of next) {
        if (!isPassAction(action)) presses.push({ action });
      }
    },
    keyUp(code: string) { changeShoot(() => { keys.delete(code); }); },
    clear() {
      keys.clear();
      presses.length = 0;
      shootEdges.length = 0;
      lastShoot = false;
      touch.clear();
      pad = gamepadSource();
    },
    read(nextBindings: KeyboardBindings, gamepad?: GamepadInput): PlayerControl {
      bindings = nextBindings;
      sampleGamepad(gamepad);
      while (shootEdges[0]?.down === lastShoot) shootEdges.shift();
      lastShoot = shootEdges.shift()?.down ?? shootDown();
      const held = (action: (typeof heldActions)[number]) =>
        !!takePress([action]) || keyDown(action) || touchDown(action) || pad.down(action);
      const pass = takePress(passActions);
      const move = activeMove();
      const heldAim = aimForPass(move);
      const passAim = pass?.aim && Math.hypot(pass.aim.x, pass.aim.z) >= PASS_AIM_MINIMUM ? pass.aim : heldAim;
      return {
        move,
        sprint: held('sprint'),
        contest: held('contest'),
        steal: held('steal'),
        screen: held('screen'),
        dribble: held('dribble'),
        shoot: lastShoot,
        pass: !!pass,
        passType: pass && (pass.action === 'lobPass' ? 'lob' : pass.action === 'bouncePass' ? 'bounce' : 'chest'),
        passAim: pass && Math.hypot(passAim.x, passAim.z) >= PASS_AIM_MINIMUM ? passAim : undefined,
        switchPlayer: !!takePress(['switchPlayer']),
      };
    },
  };
}
