import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { zeroControl } from '../contracts/index.ts';
import {
  DEFAULT_KEYBOARD_BINDINGS, createInputState, limitMove,
} from './input.ts';
import type { KeyboardBindings, PlayerControl, TouchAction, TouchInput } from './input.ts';
import './controls.css';

export { DEFAULT_KEYBOARD_BINDINGS, GAMEPAD_HINTS, KEYBOARD_HINTS, selectDirectionalPassTarget } from './input.ts';
export type { KeyboardBindings, PlayerControl, TouchAction, TouchInput } from './input.ts';

type Options = { enabled?: boolean; bindings?: KeyboardBindings };

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
  const [input] = useState(() => createInputState(bindings));

  useEffect(() => {
    input.clear();
    if (!enabled) return;

    const mappedCodes = new Set(Object.values(bindings).flat());
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !mappedCodes.has(event.code) || !shouldCaptureKey(event)) return;
      event.preventDefault();
      if (!event.repeat) input.keyDown(event.code, bindings);
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
  }, [bindings, enabled, input]);

  const sampleGamepad = useCallback(() => {
    if (enabled && !document.hidden) input.sampleGamepad(getGamepad());
  }, [enabled, input]);
  const read = useCallback((): PlayerControl => {
    if (!enabled || document.hidden) return zeroControl();
    return input.read(bindings, getGamepad());
  }, [bindings, enabled, input]);
  return { read, sampleGamepad, touch: input.touch };
}

const TOUCH_BUTTONS = [
  { action: 'dribble', label: 'Dribble', accessibleLabel: 'Dribble move' },
  { action: 'bouncePass', label: 'Bounce', accessibleLabel: 'Bounce pass' },
  { action: 'lobPass', label: 'Lob', accessibleLabel: 'Lob pass' },
  { action: 'screen', label: 'Screen', accessibleLabel: 'Set a screen' },
  { action: 'switchPlayer', label: 'Switch', accessibleLabel: 'Switch player' },
  { action: 'steal', label: 'Steal', accessibleLabel: 'Steal' },
  { action: 'contest', label: 'Contest', accessibleLabel: 'Contest or rebound' },
  { action: 'pass', label: 'Pass', accessibleLabel: 'Pass' },
  { action: 'shoot', label: 'Shoot', accessibleLabel: 'Shoot, hold and release' },
] as const;
const SPRINT_BUTTON = { action: 'sprint', label: 'Sprint', accessibleLabel: 'Sprint' } as const;
const JOYSTICK_TRAVEL = 0.28;
const SPRINT_ENTRY = 0.38;
const SPRINT_EXIT = 0.32;
const VIRTUAL_POINTER = -1;
const STILL = { x: 0, z: 0 };

type Button = (typeof TOUCH_BUTTONS)[number] | typeof SPRINT_BUTTON;
export type TouchContext = 'offense' | 'defense' | 'loose' | 'freeThrow';
const CONTEXT_ACTIONS: Record<TouchContext, readonly TouchAction[]> = {
  offense: ['shoot', 'pass', 'bouncePass', 'lobPass', 'screen', 'dribble', 'sprint'],
  defense: ['contest', 'steal', 'switchPlayer', 'sprint'],
  loose: ['contest', 'steal', 'switchPlayer', 'shoot', 'sprint'],
  freeThrow: ['shoot'],
};
type TouchControlsProps = { touch: TouchInput; visible?: boolean; context?: TouchContext };

export function TouchControls({ touch, visible, context }: TouchControlsProps) {
  const [stick, setStick] = useState(STILL);
  const [sprinting, setSprinting] = useState(false);
  const [pressedActions, setPressedActions] = useState<TouchAction[]>([]);
  const stickPointer = useRef<number | null>(null);
  const stickSprint = useRef(false);
  const buttonPointers = useRef(new Map<number, TouchAction>());
  useEffect(() => {
    const clear = () => {
      stickPointer.current = null;
      stickSprint.current = false;
      buttonPointers.current.clear();
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
    const next = limitMove(x / JOYSTICK_TRAVEL, z / JOYSTICK_TRAVEL);
    setStick(next);
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
    if (!buttonPointers.current.delete(pointerId)) return;
    setPressedActions([...buttonPointers.current.values()]);
    if (cancel) touch.cancel(pointerId);
    else touch.release(pointerId);
  };
  const renderButton = ({ action, label, accessibleLabel }: Button) => {
    const pressed = pressedActions.includes(action) || (action === 'sprint' && sprinting);
    return (
      <button
        type="button"
        key={action}
        className={`hd-touch-controls__action hd-touch-controls__action--${action}`}
        aria-label={accessibleLabel}
        hidden={!!context && !CONTEXT_ACTIONS[context].includes(action) && !pressed}
        data-pressed={pressed}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          buttonPointers.current.set(event.pointerId, action);
          setPressedActions([...buttonPointers.current.values()]);
          touch.press(event.pointerId, action);
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
        {label}
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
