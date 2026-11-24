import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { zeroControl } from '../contracts/index.ts';
import {
  DEFAULT_KEYBOARD_BINDINGS, createInputState, limitMove,
} from './input.ts';
import type { KeyboardBindings, PlayerControl, TouchAction, TouchInput } from './input.ts';
import './controls.css';

export { DEFAULT_KEYBOARD_BINDINGS, GAMEPAD_HINTS, KEYBOARD_HINTS } from './input.ts';
export type { KeyboardBindings, PlayerControl, TouchAction, TouchInput } from './input.ts';

type Options = { enabled?: boolean; bindings?: KeyboardBindings };

function shouldCaptureKey(event: KeyboardEvent) {
  const target = event.target;
  if (target instanceof HTMLElement
    && (target.isContentEditable || !!target.closest('input, select, textarea, [role="textbox"]'))) return false;
  return !(event.code === 'Space' && target instanceof Element && !!target.closest('button, a, [role="button"]'));
}

export function useControls({ enabled = true, bindings = DEFAULT_KEYBOARD_BINDINGS }: Options = {}) {
  const [input] = useState(createInputState);

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

  const read = useCallback((): PlayerControl => {
    if (!enabled || document.hidden) return zeroControl();
    const gamepads = navigator.getGamepads?.() ?? [];
    const gamepad = Array.from(gamepads).find((pad) => pad?.connected && pad.mapping === 'standard');
    return input.read(bindings, gamepad ?? undefined);
  }, [bindings, enabled, input]);
  return { read, touch: input.touch };
}

const TOUCH_BUTTONS: readonly { action: TouchAction; label: string; accessibleLabel: string }[] = [
  { action: 'shoot', label: 'Shoot', accessibleLabel: 'Shoot, hold and release' },
  { action: 'pass', label: 'Pass', accessibleLabel: 'Pass' },
  { action: 'bouncePass', label: 'Bounce', accessibleLabel: 'Bounce pass' },
  { action: 'lobPass', label: 'Lob', accessibleLabel: 'Lob pass' },
  { action: 'contest', label: 'Contest', accessibleLabel: 'Contest or rebound' },
  { action: 'steal', label: 'Steal', accessibleLabel: 'Steal' },
  { action: 'switchPlayer', label: 'Switch', accessibleLabel: 'Switch player' },
  { action: 'sprint', label: 'Sprint', accessibleLabel: 'Sprint' },
  { action: 'screen', label: 'Screen', accessibleLabel: 'Set a screen' },
  { action: 'dribble', label: 'Dribble', accessibleLabel: 'Dribble move' },
];
const JOYSTICK_TRAVEL = 0.28;
const VIRTUAL_POINTER = -1;

type TouchControlsProps = { touch: TouchInput; visible?: boolean };

export function TouchControls({ touch, visible }: TouchControlsProps) {
  const [stick, setStick] = useState({ x: 0, z: 0 });
  const stickPointer = useRef<number | null>(null);
  useEffect(() => {
    const clear = () => {
      stickPointer.current = null;
      setStick({ x: 0, z: 0 });
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
    const length = Math.max(1, rect.width * JOYSTICK_TRAVEL);
    const next = limitMove(
      (event.clientX - rect.left - rect.width / 2) / length,
      (event.clientY - rect.top - rect.height / 2) / length,
    );
    setStick(next);
    touch.move(next);
  };

  const releaseStick = (event: PointerEvent<HTMLDivElement>) => {
    if (stickPointer.current !== event.pointerId) return;
    stickPointer.current = null;
    setStick({ x: 0, z: 0 });
    touch.move({ x: 0, z: 0 });
  };

  if (visible === false) return null;
  return (
    <div className={`hd-touch-controls${visible ? ' hd-touch-controls--visible' : ''}`} role="group" aria-label="Touch controls">
      <div
        className="hd-touch-controls__stick"
        role="img"
        aria-label="Movement joystick"
        onPointerDown={(event) => {
          if (event.button !== 0 || stickPointer.current !== null) return;
          stickPointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          moveStick(event);
        }}
        onPointerMove={moveStick}
        onPointerUp={releaseStick}
        onPointerCancel={releaseStick}
        onLostPointerCapture={releaseStick}
      >
        <span
          className="hd-touch-controls__thumb"
          style={{ left: `${50 + stick.x * JOYSTICK_TRAVEL * 100}%`, top: `${50 + stick.z * JOYSTICK_TRAVEL * 100}%` }}
        />
      </div>
      <div className="hd-touch-controls__actions">
        {TOUCH_BUTTONS.map(({ action, label, accessibleLabel }) => (
          <button
            type="button"
            key={action}
            className={`hd-touch-controls__action hd-touch-controls__action--${action}`}
            aria-label={accessibleLabel}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              touch.press(event.pointerId, action);
            }}
            onPointerUp={(event) => touch.release(event.pointerId)}
            onPointerCancel={(event) => touch.cancel(event.pointerId)}
            onLostPointerCapture={(event) => touch.release(event.pointerId)}
            onClick={(event) => {
              if (event.detail !== 0) return;
              touch.press(VIRTUAL_POINTER, action);
              touch.release(VIRTUAL_POINTER);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
