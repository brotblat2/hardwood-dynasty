import { COURT } from '../contracts/index.ts';
import type { Control, GamePlayer, Vec2 } from '../contracts/index.ts';
import { selectPassTarget } from '../game-engine/index.ts';

export type PlayerControl = Control & {
  switchPlayer?: boolean;
  touchShotReleased?: boolean;
  passAim?: Vec2;
  iconPassToggle?: boolean;
  iconSlot?: 0 | 1 | 2 | 3;
  padSlot?: 0 | 1 | 2 | 3;
  callPlay?: boolean;
  toggleScreenMode?: boolean;
  proStick?: Vec2;
  rightStick?: Vec2;
};

export const DEFAULT_KEYBOARD_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  shoot: ['Space'],
  pass: ['KeyJ'],
  dribble: ['KeyK'],
  intenseD: ['KeyL'],
  handsUp: ['KeyH'],
  bouncePass: ['KeyU'],
  lobPass: ['KeyI'],
  flashyPass: ['KeyO'],
  screen: ['KeyE'],
  toggleScreenMode: ['KeyF'],
  switchPlayer: ['KeyQ'],
  callPlay: ['KeyR'],
  iconPass: ['Tab'],
  contest: ['KeyC'],
  steal: ['KeyX'],
  pumpFake: ['KeyV'],
} as const;

export type InputAction = keyof typeof DEFAULT_KEYBOARD_BINDINGS;
export type KeyboardBindings = Record<InputAction, readonly string[]>;
export type TouchAction = Exclude<InputAction, 'up' | 'down' | 'left' | 'right' | 'callPlay' | 'toggleScreenMode'>;
export type TouchInput = {
  move: (position: Vec2) => void;
  press: (pointer: number, action: TouchAction) => void;
  release: (pointer: number) => void;
  cancel: (pointer: number) => void;
  dribbleFlick: (direction: Vec2) => void;
  clear: () => void;
};
type Source = { move: Vec2; aim: Vec2; down: (action: InputAction) => boolean };
type GamepadInput = Pick<Gamepad, 'axes' | 'buttons'>;

export function mergeBindings(partial?: Partial<Record<string, readonly string[]>>): KeyboardBindings {
  const merged = { ...DEFAULT_KEYBOARD_BINDINGS } as Record<InputAction, readonly string[]>;
  if (!partial) return merged;
  for (const action of Object.keys(DEFAULT_KEYBOARD_BINDINGS) as InputAction[]) {
    const custom = partial[action];
    if (Array.isArray(custom) && custom.length > 0) merged[action] = custom;
  }
  return merged;
}

const KEY_DISPLAY: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', ShiftLeft: 'Shift', ShiftRight: 'Shift',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

function formatKeys(codes: readonly string[]) {
  const names: string[] = [];
  for (const code of codes) {
    const label = KEY_DISPLAY[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '');
    if (!names.includes(label)) names.push(label);
  }
  return names.join(' / ');
}

export function formatKeyboardHints(bindings: Partial<KeyboardBindings> = DEFAULT_KEYBOARD_BINDINGS): [string, string][] {
  const b = mergeBindings(bindings);
  return [
    ['Move', `${formatKeys(b.up)} ${formatKeys(b.left)} ${formatKeys(b.down)} ${formatKeys(b.right)}`],
    ['Sprint', formatKeys(b.sprint)],
    ['Shoot / Block / Rebound', `Hold ${formatKeys(b.shoot)} (Tap = Fake · Def/Loose = Block/Rebound)`],
    ['Pass / Switch (Def)', `${formatKeys(b.pass)} (Aim Move · Def/Loose = Switch)`],
    ['Dribble / Steal (Def)', `${formatKeys(b.dribble)} or Right-Drag (Aim Move · Def = Steal)`],
    ['Post-Up / Tight D / Box Out', `${formatKeys(b.intenseD)} (Off = Post-Up · Def = Tight D · Loose = Box Out)`],
    ['Hands-Up Contest (Def)', `${formatKeys(b.handsUp)} (Feet planted, no pump-fake bite)`],
    ['Call Screen / Box Out', formatKeys(b.screen)],
    ['Toggle Pick Roll / Fade', formatKeys(b.toggleScreenMode)],
    ['Bounce / Lob / Flashy', `${formatKeys(b.bouncePass)} / ${formatKeys(b.lobPass)} / ${formatKeys(b.flashyPass)}`],
    ['Icon Pass', `${formatKeys(b.iconPass)}, then 1–4`],
    ['Cycle Play / Defense', `${formatKeys(b.callPlay)} (Motion / P&R / Iso / 5-Out / Floppy)`],
    ['Switch / Fake / Block / Steal', `${formatKeys(b.switchPlayer)} / ${formatKeys(b.pumpFake)} / ${formatKeys(b.contest)} / ${formatKeys(b.steal)}`],
  ];
}

export const KEYBOARD_HINTS = [
  ['Move', 'WASD or Arrows'], ['Sprint', 'Shift'], ['Shoot / Block / Rebound', 'Space (Tap = Fake)'],
  ['Pass / Switch (Def)', 'J (Aim Move)'], ['Dribble / Steal (Def)', 'K (Aim Move)'],
  ['Post-Up / Tight D / Box Out', 'L'], ['Hands-Up Contest (Def)', 'H'], ['Call Screen / Box Out', 'E'],
  ['Toggle Roll / Fade', 'F'], ['Bounce / Lob / Flashy', 'U / I / O'], ['Icon Pass', 'Tab, then 1–4'],
  ['Cycle Play / Defense', 'R'], ['Optional (Switch/Fake/Block/Steal)', 'Q / V / C / X'],
] as const;

export const GAMEPAD_HINTS = [
  ['Move', 'Left stick or D-pad'], ['Sprint / Turbo', 'RT / R2'], ['Shoot / Pro-Stick', 'X / Square (Tap = Fake) or Right Stick'],
  ['Pass / Switch (Def)', 'A / Cross (Def = Switch)'], ['Bounce / Lob / Flashy', 'LT+A / L3+A / RB+A'],
  ['Icon Pass', 'View/Back, then X / B / Y / A'], ['Post-Up / Intense-D / Box Out', 'LT / L2'],
  ['Hands-Up Contest (Def)', 'Hold Right Stick (No fly-by)'], ['Jump Block / Rebound', 'Y / Triangle'],
  ['Steal / Pump fake', 'B / Circle'], ['Switch player', 'LB / L1 or A (Def)'],
  ['Screen / Box Out', 'RB / R1'], ['Dribble move', 'Flick Right Stick or R3'], ['Play / scheme', 'Start / Menu'],
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
  const buttons: Partial<Record<InputAction, boolean>> = {
    sprint: button(7),
    shoot: button(2),
    pass,
    flashyPass: pass && button(5),
    bouncePass: pass && button(6),
    lobPass: pass && button(10),
    contest: button(3),
    steal: button(1),
    screen: !pass && button(5),
    dribble: button(11),
    intenseD: !pass && button(6),
    switchPlayer: button(4),
    iconPass: button(8),
    callPlay: button(9),
  };
  return {
    move: dpad.x || dpad.z ? dpad : stick,
    aim,
    down: (action) => buttons[action] ?? false,
  };
}

export function selectDirectionalPassTarget(passer: GamePlayer, teammates: readonly GamePlayer[], aim: Vec2) {
  return selectPassTarget(passer, teammates, aim);
}

export function selectSwitchTarget(
  current: GamePlayer,
  teammates: readonly GamePlayer[],
  ballPos: Vec2,
  aim: Vec2,
  recentIds: readonly string[] = [],
): string | undefined {
  const candidates = teammates.filter(q => q.side === current.side && q.id !== current.id);
  if (!candidates.length) return undefined;
  const mag = Math.hypot(aim.x, aim.z);
  if (Number.isFinite(mag) && mag >= 0.25) {
    let best: string | undefined;
    let bestScore = -Infinity;
    for (const q of candidates) {
      const dx = q.position.x - current.position.x;
      const dz = q.position.z - current.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.01) continue;
      const align = (dx * aim.x + dz * aim.z) / (d * mag);
      if (align <= 0.25) continue;
      const score = align * 5 - d * 0.08;
      if (score > bestScore) { bestScore = score; best = q.id; }
    }
    if (best) return best;
  }
  const sorted = [...candidates].sort((a, b) => {
    const score = (q: GamePlayer) => Math.hypot(q.position.x - ballPos.x, q.position.z - ballPos.z) +
      (candidates.length > 1 && recentIds.includes(q.id) ? 3.5 : 0);
    return score(a) - score(b);
  });
  return sorted[0]?.id;
}

export function deriveShotType(
  player: GamePlayer,
  moveCourt: Vec2,
  rim: Vec2,
  options: { sprint?: boolean; dribble?: boolean; proStickCourt?: Vec2 } = {},
): Control['shotType'] {
  const dir = options.proStickCourt ?? moveCourt;
  const toRimX = rim.x - player.position.x;
  const toRimZ = rim.z - player.position.z;
  const dist = Math.hypot(toRimX, toRimZ);
  const dirLen = Math.hypot(dir.x, dir.z);
  const toward = dist > 0.01 && dirLen > 0.15 ? (toRimX * dir.x + toRimZ * dir.z) / (dist * dirLen) : 0;
  const lateral = dist > 0.01 && dirLen > 0.15 ? (toRimX * dir.z - toRimZ * dir.x) / (dist * dirLen) : 0;
  const isBig = player.profile.position === 'PF' || player.profile.position === 'C';
  const speed = Math.hypot(player.velocity.x, player.velocity.z);
  const deepBaseline = Math.abs(player.position.x) > COURT.rimX - 0.7 && Math.abs(player.position.z) > 0.65;
  if (options.proStickCourt) {
    if (toward > 0.45) {
      if (deepBaseline && dist < 2.8) return 'reverseLayup';
      return dist < 2.8 && options.sprint ? 'dunk' : dist < 3.4 ? 'layup' : 'floater';
    }
    if (toward < -0.45) return 'fadeaway';
    if (dist < 3.8 && options.dribble && Math.abs(lateral) > 0.55) return 'euro';
    return isBig ? 'hook' : 'floater';
  }
  if (options.dribble && dist < 3.8 && Math.abs(lateral) > 0.45 && toward > 0.15) return 'euro';
  if (options.dribble && dist < 5.5) return isBig ? 'hook' : 'floater';
  if (dist < 2.6 && options.sprint && toward > 0.25) return 'dunk';
  if (deepBaseline && dist < 2.8 && toward > 0.1) return 'reverseLayup';
  if (dist < 2.7 && toward > 0.25) return 'layup';
  if (dist >= 2.0 && dist < 3.8 && !options.sprint && toward > 0.15 && Math.abs(lateral) > 0.65) return 'euro';
  if (dist >= 2.6 && toward < -0.5) return 'fadeaway';
  if (dist >= 3.2 && speed >= 2.1 && toward >= -0.25) return 'pullUp';
  return undefined;
}

const passActions = ['flashyPass', 'lobPass', 'bouncePass', 'pass'] as const;
type PassAction = (typeof passActions)[number];
const heldActions = ['sprint', 'contest', 'handsUp', 'steal', 'screen', 'dribble', 'intenseD'] as const;
const tapActions = ['switchPlayer', 'pumpFake', 'iconPass', 'callPlay', 'toggleScreenMode'] as const;
const bufferedActions = [...passActions, ...tapActions, ...heldActions] as const;
type BufferedAction = (typeof bufferedActions)[number];
const slotCodes = ['Digit1', 'Digit2', 'Digit3', 'Digit4'] as const;
const padFaceSlots: readonly [InputAction, 0 | 1 | 2 | 3][] = [['shoot', 0], ['steal', 1], ['contest', 2], ['pass', 3]];
type SlotIndex = 0 | 1 | 2 | 3;
type TouchPress = { action: TouchAction };
type BufferedPress = { action: BufferedAction; aim?: Vec2; touch?: TouchPress };
const isPassAction = (action: BufferedAction): action is PassAction => passActions.some((pass) => pass === action);
type ShootEdge = { down: boolean; touch?: TouchPress };

export function createInputState(initialBindings: Partial<KeyboardBindings> = DEFAULT_KEYBOARD_BINDINGS) {
  const keys = new Set<string>();
  const touchActions = new Map<number, TouchPress>();
  const presses: BufferedPress[] = [];
  const slotPresses: SlotIndex[] = [];
  const padSlots: SlotIndex[] = [];
  const shootEdges: ShootEdge[] = [];
  let lastShoot = false;
  let bindings = mergeBindings(initialBindings);
  let touchMove = STILL;
  let pad = gamepadSource();
  let stickHoldTicks = 0;
  let stickPeak = 0;
  let stickPeakDir = STILL;
  let proStickShooting = false;
  let proStickDir = STILL;

  const keyDown = (action: InputAction) => bindings[action].some((code) => keys.has(code));
  const touchDown = (action: TouchAction) => [...touchActions.values()].some((press) => press.action === action);
  const shootDown = () => keyDown('shoot') || touchDown('shoot') || pad.down('shoot') || proStickShooting;
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
    const nextPad = gamepadSource(gamepad);
    const rightMag = Math.hypot(nextPad.aim.x, nextPad.aim.z);
    const rawButtonShoot = keyDown('shoot') || touchDown('shoot') || nextPad.down('shoot');
    changeShoot(() => {
      pad = nextPad;
      if (!nextPad.down('pass') && !rawButtonShoot) {
        if (rightMag >= 0.58) {
          const reversed = stickPeak >= 0.65 && stickHoldTicks > 0 && stickHoldTicks < 4 &&
            (nextPad.aim.x * stickPeakDir.x + nextPad.aim.z * stickPeakDir.z) < 0.2;
          if (reversed) {
            presses.push({ action: 'dribble', aim: stickPeakDir });
            stickHoldTicks = 1;
            stickPeak = rightMag;
            stickPeakDir = nextPad.aim;
            proStickDir = nextPad.aim;
            proStickShooting = false;
          } else {
            stickHoldTicks++;
            if (rightMag >= stickPeak) {
              stickPeak = rightMag;
              stickPeakDir = nextPad.aim;
            }
            proStickDir = nextPad.aim;
            if (stickHoldTicks >= 4) proStickShooting = true;
          }
        } else {
          if (stickPeak >= 0.62 && rightMag < 0.30 && stickHoldTicks > 0 && stickHoldTicks < 4) {
            presses.push({ action: 'dribble', aim: stickPeakDir });
          }
          stickHoldTicks = 0;
          stickPeak = 0;
          stickPeakDir = STILL;
          proStickShooting = false;
        }
      } else {
        stickHoldTicks = 0;
        stickPeak = 0;
        stickPeakDir = STILL;
        proStickShooting = false;
      }
    });
    if (pad.down('pass') && !last.down('pass')) {
      const action = passActions.find((candidate) => pad.down(candidate)) ?? 'pass';
      presses.push({ action, aim: aimForPass(activeMove()) });
    }
    for (const action of [...tapActions, ...heldActions] as const) {
      if (pad.down(action) && !last.down(action)) presses.push({ action });
    }
    for (const [act, slot] of padFaceSlots) {
      if (pad.down(act) && !last.down(act)) padSlots.push(slot);
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
        const aim = isPassAction(action) || action === 'dribble' ? aimForPass(activeMove()) : undefined;
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
    dribbleFlick(direction) {
      const mag = Math.hypot(direction.x, direction.z);
      if (mag >= 0.15) presses.push({ action: 'dribble', aim: limitMove(direction.x, direction.z) });
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
    proStickFlick(direction: Vec2) {
      const mag = Math.hypot(direction.x, direction.z);
      if (mag >= 0.15) presses.push({ action: 'dribble', aim: limitMove(direction.x, direction.z) });
    },
    keyDown(code: string, nextBindings: Partial<KeyboardBindings>) {
      bindings = mergeBindings(nextBindings);
      if (keys.has(code)) return;
      const next = bufferedActions.filter((action) => bindings[action].includes(code) && !keyDown(action));
      changeShoot(() => { keys.add(code); });
      const pass = passActions.find((action) => next.includes(action));
      if (pass) presses.push({ action: pass, aim: aimForPass(activeMove()) });
      for (const action of next) {
        if (!isPassAction(action)) presses.push({ action, ...(action === 'dribble' ? { aim: activeMove() } : {}) });
      }
      const slotIdx = slotCodes.indexOf(code as (typeof slotCodes)[number]);
      if (slotIdx >= 0 && !next.length) slotPresses.push(slotIdx as SlotIndex);
    },
    keyUp(code: string) { changeShoot(() => { keys.delete(code); }); },
    clear() {
      keys.clear();
      presses.length = 0;
      slotPresses.length = 0;
      padSlots.length = 0;
      shootEdges.length = 0;
      lastShoot = false;
      stickHoldTicks = 0;
      stickPeak = 0;
      stickPeakDir = STILL;
      proStickShooting = false;
      proStickDir = STILL;
      touch.clear();
      pad = gamepadSource();
    },
    read(nextBindings: Partial<KeyboardBindings>, gamepad?: GamepadInput): PlayerControl {
      bindings = mergeBindings(nextBindings);
      sampleGamepad(gamepad);
      while (shootEdges[0]?.down === lastShoot) shootEdges.shift();
      const shotEdge = shootEdges.shift();
      lastShoot = shotEdge?.down ?? shootDown();
      const held = (action: (typeof heldActions)[number]) =>
        !!takePress([action]) || keyDown(action) || touchDown(action) || pad.down(action);
      const dribblePress = takePress(['dribble']);
      const dribbleHeld = !!dribblePress || keyDown('dribble') || touchDown('dribble') || pad.down('dribble');
      const pass = takePress(passActions);
      const move = activeMove();
      const heldAim = aimForPass(move);
      const passAim = pass?.aim && Math.hypot(pass.aim.x, pass.aim.z) >= PASS_AIM_MINIMUM ? pass.aim : heldAim;
      const dribbleDir = dribblePress?.aim && Math.hypot(dribblePress.aim.x, dribblePress.aim.z) >= 0.15
        ? dribblePress.aim
        : (dribbleHeld && Math.hypot(move.x, move.z) >= 0.15 ? move : undefined);
      const iconSlot = slotPresses.shift();
      const padSlot = padSlots.shift();
      const rightStick = Math.hypot(pad.aim.x, pad.aim.z) >= 0.35 ? pad.aim : undefined;
      return {
        move,
        sprint: held('sprint'),
        contest: held('contest'),
        handsUp: held('handsUp'),
        steal: held('steal'),
        screen: held('screen'),
        dribble: dribbleHeld,
        intenseD: held('intenseD'),
        ...(dribbleDir ? { dribbleDir } : {}),
        shoot: lastShoot,
        ...(!lastShoot && shotEdge?.touch ? { touchShotReleased: true } : {}),
        pass: !!pass,
        passType: pass && (pass.action === 'flashyPass' ? 'flashy' : pass.action === 'lobPass' ? 'lob' : pass.action === 'bouncePass' ? 'bounce' : 'chest'),
        passAim: pass && Math.hypot(passAim.x, passAim.z) >= PASS_AIM_MINIMUM ? passAim : undefined,
        switchPlayer: !!takePress(['switchPlayer']),
        pumpFake: !!takePress(['pumpFake']),
        iconPassToggle: !!takePress(['iconPass']),
        callPlay: !!takePress(['callPlay']),
        toggleScreenMode: !!takePress(['toggleScreenMode']),
        ...(iconSlot !== undefined ? { iconSlot } : {}),
        ...(padSlot !== undefined ? { padSlot } : {}),
        ...(proStickShooting ? { proStick: proStickDir } : {}),
        ...(rightStick ? { rightStick } : {}),
      };
    },
  };
}
