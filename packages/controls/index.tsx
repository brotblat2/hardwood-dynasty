import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { zeroControl } from '../contracts/index.ts';
import type { ShotMeterState } from '../contracts/index.ts';
import {
  DEFAULT_KEYBOARD_BINDINGS, createInputState, limitMove, mergeBindings,
} from './input.ts';
import type { KeyboardBindings, PlayerControl, TouchAction, TouchInput } from './input.ts';
import './controls.css';

export {
  DEFAULT_KEYBOARD_BINDINGS, GAMEPAD_HINTS, KEYBOARD_HINTS,
  deriveShotType, formatKeyboardHints, mergeBindings, selectDirectionalPassTarget, selectSwitchTarget,
} from './input.ts';
export type { KeyboardBindings, PlayerControl, TouchAction, TouchInput } from './input.ts';

type Options = { enabled?: boolean; bindings?: Partial<KeyboardBindings> };

function shouldCaptureKey(event: KeyboardEvent) {
  const target = event.target;
  if (target instanceof HTMLElement
    && (target.isContentEditable || !!target.closest('input, select, textarea, [role="textbox"]'))) return false;
  return !(event.code === 'Space' && target instanceof Element && !!target.closest('button, a, [role="button"]'));
}

function getGamepad() {
  return Array.from(navigator.getGamepads?.() ?? [])
    .find((pad) => pad?.connected && pad.mapping === 'standard') ?? undefined;
}

export function useControls({ enabled = true, bindings = DEFAULT_KEYBOARD_BINDINGS }: Options = {}) {
  const merged = useMemo(() => mergeBindings(bindings), [bindings]);
  const [input] = useState(() => createInputState(merged));

  useEffect(() => {
    input.clear();
    if (!enabled) return;

    const mappedCodes = new Set([...Object.values(merged).flat(), 'Digit1', 'Digit2', 'Digit3', 'Digit4']);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !mappedCodes.has(event.code) || !shouldCaptureKey(event)) return;
      event.preventDefault();
      if (!event.repeat) input.keyDown(event.code, merged);
    };
    const keyup = (event: KeyboardEvent) => input.keyUp(event.code);
    const clear = () => input.clear();
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);

    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      input.clear();
    };
  }, [merged, enabled, input]);

  const sampleGamepad = useCallback(() => {
    if (enabled && !document.hidden) input.sampleGamepad(getGamepad());
  }, [enabled, input]);
  const read = useCallback((): PlayerControl => {
    if (!enabled || document.hidden) return zeroControl();
    return input.read(merged, getGamepad());
  }, [merged, enabled, input]);
  return { read, sampleGamepad, touch: input.touch, proStickFlick: input.proStickFlick };
}

const TOUCH_BUTTONS = [
  { action: 'iconPass', label: 'Icons', accessibleLabel: 'Toggle icon passing' },
  { action: 'screen', label: 'Screen', accessibleLabel: 'Set a screen' },
  { action: 'pumpFake', label: 'Fake', accessibleLabel: 'Pump fake' },
  { action: 'bouncePass', label: 'Bounce', accessibleLabel: 'Bounce pass' },
  { action: 'lobPass', label: 'Lob', accessibleLabel: 'Lob pass' },
  { action: 'flashyPass', label: 'Flashy', accessibleLabel: 'Flashy pass' },
  { action: 'dribble', label: 'Dribble', accessibleLabel: 'Dribble move' },
  { action: 'pass', label: 'Pass', accessibleLabel: 'Pass' },
  { action: 'shoot', label: 'Shoot', accessibleLabel: 'Shoot, hold and release' },
  { action: 'intenseD', label: 'Clamp', accessibleLabel: 'Intense defense or box out' },
  { action: 'handsUp', label: 'Hands Up', accessibleLabel: 'Hands up contest' },
  { action: 'switchPlayer', label: 'Switch', accessibleLabel: 'Switch player' },
  { action: 'steal', label: 'Steal', accessibleLabel: 'Steal' },
  { action: 'contest', label: 'Contest', accessibleLabel: 'Jump block or rebound' },
] as const;
const SPRINT_BUTTON = { action: 'sprint', label: 'Sprint', accessibleLabel: 'Sprint' } as const;
const JOYSTICK_TRAVEL = 0.28;
const SPRINT_ENTRY = 0.38;
const SPRINT_EXIT = 0.32;
const VIRTUAL_POINTER = -1;
const STILL = { x: 0, z: 0 };

type Button = (typeof TOUCH_BUTTONS)[number] | typeof SPRINT_BUTTON;
export type TouchContext = 'offense' | 'offball' | 'defense' | 'loose' | 'freeThrow';
const CONTEXT_ACTIONS: Record<TouchContext, readonly TouchAction[]> = {
  offense: ['iconPass', 'screen', 'pumpFake', 'bouncePass', 'lobPass', 'flashyPass', 'dribble', 'pass', 'shoot', 'sprint'],
  offball: ['pass', 'screen', 'switchPlayer', 'sprint'],
  defense: ['intenseD', 'handsUp', 'switchPlayer', 'steal', 'contest', 'sprint'],
  loose: ['intenseD', 'steal', 'switchPlayer', 'contest', 'sprint'],
  freeThrow: ['shoot'],
};
type TouchControlsProps = { touch: TouchInput; visible?: boolean; context?: TouchContext; charge?: number; shotMeter?: ShotMeterState | null; iconPassActive?: boolean };

export function TouchControls({ touch, visible, context, charge = 0, shotMeter, iconPassActive }: TouchControlsProps) {
  const [stick, setStick] = useState(STILL);
  const [sprinting, setSprinting] = useState(false);
  const [pressedActions, setPressedActions] = useState<TouchAction[]>([]);
  const stickPointer = useRef<number | null>(null);
  const stickSprint = useRef(false);
  const buttonPointers = useRef(new Map<number, TouchAction>());
  const dribbleSwipes = useRef(new Map<number, { x: number; y: number; swiped: boolean }>());
  useEffect(() => {
    const clear = () => {
      stickPointer.current = null;
      stickSprint.current = false;
      buttonPointers.current.clear();
      dribbleSwipes.current.clear();
      setStick(STILL);
      setSprinting(false);
      setPressedActions([]);
      touch.clear();
    };
    if (visible === false) clear();
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      touch.clear();
    };
  }, [touch, visible]);

  const moveStick = (event: PointerEvent<HTMLDivElement>) => {
    if (stickPointer.current !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const size = Math.max(1, rect.width);
    const x = (event.clientX - rect.left - rect.width / 2) / size;
    const z = (event.clientY - rect.top - rect.height / 2) / size;
    const rawX = x / JOYSTICK_TRAVEL;
    const rawZ = z / JOYSTICK_TRAVEL;
    const dist = Math.hypot(rawX, rawZ);
    const visualThumb = limitMove(rawX, rawZ);
    let next = STILL;
    if (dist > 0.10) {
      const travel = Math.min(1, (dist - 0.10) / 0.90);
      const curve = travel * (0.45 + 0.55 * travel);
      next = { x: (rawX / dist) * curve, z: (rawZ / dist) * curve };
    }
    setStick(visualThumb);
    touch.move(next);
    const sprint = Math.hypot(x, z) >= (stickSprint.current ? SPRINT_EXIT : SPRINT_ENTRY);
    if (sprint === stickSprint.current) return;
    stickSprint.current = sprint;
    setSprinting(sprint);
    if (sprint) touch.press(event.pointerId, 'sprint');
    else touch.release(event.pointerId);
  };

  const releaseStick = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    if (stickPointer.current !== event.pointerId) return;
    stickPointer.current = null;
    stickSprint.current = false;
    setStick(STILL);
    setSprinting(false);
    touch.move(STILL);
    if (cancel) touch.cancel(event.pointerId);
    else touch.release(event.pointerId);
  };

  const releaseButton = (pointerId: number, cancel = false) => {
    const action = buttonPointers.current.get(pointerId);
    if (!buttonPointers.current.delete(pointerId)) return;
    setPressedActions([...buttonPointers.current.values()]);
    if (action === 'dribble') {
      const swipe = dribbleSwipes.current.get(pointerId);
      dribbleSwipes.current.delete(pointerId);
      if (!cancel && swipe && !swipe.swiped) {
        touch.press(pointerId, 'dribble');
        touch.release(pointerId);
      }
      return;
    }
    if (cancel) touch.cancel(pointerId);
    else touch.release(pointerId);
  };
  const renderButton = ({ action, label, accessibleLabel }: Button) => {
    const pressed = pressedActions.includes(action) || (action === 'sprint' && sprinting) || (action === 'iconPass' && !!iconPassActive);
    const displayLabel = context === 'offense' && action === 'screen' ? 'Pick'
      : context === 'offball' && action === 'pass' ? 'Call Pass'
      : context === 'defense' && action === 'contest' ? 'Block'
      : context === 'loose' && action === 'contest' ? 'Rebound'
      : context === 'loose' && action === 'intenseD' ? 'Box Out'
      : label;
    const isShoot = action === 'shoot';
    const progress = shotMeter?.progress ?? charge;
    const maxC = shotMeter?.maxCharge ?? 1.2;
    const ideal = shotMeter?.ideal ?? 0.62;
    const gw = shotMeter?.greenWindow ?? 0.065;
    const chargePct = isShoot && progress > 0 ? Math.min(100, Math.round((progress / maxC) * 100)) : 0;
    const inGreen = isShoot && progress > 0 && Math.abs(progress - ideal) <= gw;
    return (
      <button
        type="button"
        key={action}
        className={`hd-touch-controls__action hd-touch-controls__action--${action}`}
        aria-label={accessibleLabel}
        hidden={!!context && !CONTEXT_ACTIONS[context].includes(action) && !pressed}
        data-pressed={pressed}
        data-green={inGreen || undefined}
        style={chargePct ? ({ '--charge': `${chargePct}%` } as CSSProperties) : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          buttonPointers.current.set(event.pointerId, action);
          setPressedActions([...buttonPointers.current.values()]);
          if (action === 'dribble') {
            dribbleSwipes.current.set(event.pointerId, { x: event.clientX, y: event.clientY, swiped: false });
          } else {
            touch.press(event.pointerId, action);
          }
        }}
        onPointerMove={(event) => {
          if (action !== 'dribble') return;
          const swipe = dribbleSwipes.current.get(event.pointerId);
          if (!swipe || swipe.swiped) return;
          const dx = event.clientX - swipe.x;
          const dy = event.clientY - swipe.y;
          if (Math.hypot(dx, dy) >= 18) {
            swipe.swiped = true;
            touch.dribbleFlick(limitMove(dx / 32, dy / 32));
          }
        }}
        onPointerUp={(event) => releaseButton(event.pointerId)}
        onPointerCancel={(event) => releaseButton(event.pointerId, true)}
        onLostPointerCapture={(event) => releaseButton(event.pointerId, true)}
        onClick={(event) => {
          if (event.detail !== 0) return;
          touch.press(VIRTUAL_POINTER, action);
          touch.release(VIRTUAL_POINTER);
        }}
      >
        {displayLabel}
      </button>
    );
  };

  if (visible === false) return null;
  return (
    <div className={`hd-touch-controls${visible ? ' hd-touch-controls--visible' : ''}`} role="group" aria-label="Touch controls">
      <div className="hd-touch-controls__movement">
        {renderButton(SPRINT_BUTTON)}
        <div
          className="hd-touch-controls__stick"
          role="img"
          aria-label="Movement joystick"
          aria-description="Push the joystick to its outer ring to sprint."
          data-sprinting={sprinting}
          onPointerDown={(event) => {
            if (event.button !== 0 || stickPointer.current !== null) return;
            event.preventDefault();
            stickPointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            moveStick(event);
          }}
          onPointerMove={moveStick}
          onPointerUp={(event) => releaseStick(event)}
          onPointerCancel={(event) => releaseStick(event, true)}
          onLostPointerCapture={(event) => releaseStick(event, true)}
        >
          <span
            className="hd-touch-controls__thumb"
            style={{ left: `${50 + stick.x * JOYSTICK_TRAVEL * 100}%`, top: `${50 + stick.z * JOYSTICK_TRAVEL * 100}%` }}
          />
        </div>
      </div>
      <div className="hd-touch-controls__actions">
        {TOUCH_BUTTONS.map(renderButton)}
      </div>
    </div>
  );
}
