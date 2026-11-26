import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { zeroControl } from '../contracts/index.ts';
import type { ShotMeterState, Vec2 } from '../contracts/index.ts';
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
  { action: 'shoot', label: 'Shoot', accessibleLabel: 'Shoot' },
  { action: 'intenseD', label: 'Clamp', accessibleLabel: 'Intense defense or box out' },
  { action: 'handsUp', label: 'Hands Up', accessibleLabel: 'Hands up contest' },
  { action: 'switchPlayer', label: 'Switch', accessibleLabel: 'Switch player' },
  { action: 'steal', label: 'Steal', accessibleLabel: 'Steal' },
  { action: 'contest', label: 'Contest', accessibleLabel: 'Jump block or rebound' },
] as const;
const SPRINT_BUTTON = { action: 'sprint', label: 'Sprint', accessibleLabel: 'Sprint' } as const;
const JOYSTICK_TRAVEL = 0.28;
const SPRINT_ENTRY = 1.18;
const SPRINT_EXIT = 1.02;
const PASS_SWIPE_THRESHOLD = 16;
const VIRTUAL_POINTER = -1;
const STILL = { x: 0, z: 0 };

type Button = (typeof TOUCH_BUTTONS)[number] | typeof SPRINT_BUTTON;
export type TouchContext = 'offense' | 'offball' | 'defense' | 'loose' | 'freeThrow';
const MAIN_ACTIONS: Record<TouchContext, readonly TouchAction[]> = {
  offense: ['pass', 'shoot'],
  offball: ['pass'],
  defense: ['switchPlayer', 'steal', 'contest'],
  loose: ['switchPlayer', 'contest'],
  freeThrow: ['shoot'],
};
const EXTRA_ACTIONS: Record<TouchContext, readonly TouchAction[]> = {
  offense: ['iconPass', 'screen', 'pumpFake', 'bouncePass', 'lobPass', 'flashyPass', 'dribble', 'intenseD'],
  offball: ['screen'],
  defense: ['intenseD', 'handsUp'],
  loose: ['intenseD'],
  freeThrow: [],
};
const CORE_ACTIONS = new Set(Object.values(MAIN_ACTIONS).flat());
type TouchControlsProps = {
  touch: TouchInput; visible?: boolean; context: TouchContext;
  charge?: number; shotMeter?: ShotMeterState | null; iconPassActive?: boolean;
  playerLocked?: boolean; tactics?: ReactNode;
};

type Point = { x: number; y: number };
type StickGesture = { pointer: number; origin: Point; travel: number };

function getSwipeDirection(origin: Point, end: Point): Vec2 | undefined {
  const dx = end.x - origin.x;
  const dz = end.y - origin.y;
  const distance = Math.hypot(dx, dz);
  return distance >= PASS_SWIPE_THRESHOLD ? { x: dx / distance, z: dz / distance } : undefined;
}

export function TouchControls({ touch, visible, context, charge = 0, shotMeter, iconPassActive, playerLocked, tactics }: TouchControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const [stick, setStick] = useState(STILL);
  const [stickOrigin, setStickOrigin] = useState<Point | null>(null);
  const [sprinting, setSprinting] = useState(false);
  const [pressedActions, setPressedActions] = useState<TouchAction[]>([]);
  const [passDirection, setPassDirection] = useState<Vec2>();
  const stickGesture = useRef<StickGesture | null>(null);
  const stickRing = useRef<HTMLSpanElement>(null);
  const stickSprint = useRef(false);
  const buttonPointers = useRef(new Map<number, TouchAction>());
  const passGesture = useRef<{ pointer: number; origin: Point | null } | null>(null);
  const dribbleSwipes = useRef(new Map<number, { x: number; y: number; swiped: boolean }>());
  useEffect(() => {
    const clear = () => {
      stickGesture.current = null;
      stickSprint.current = false;
      passGesture.current = null;
      buttonPointers.current.clear();
      dribbleSwipes.current.clear();
      setStick(STILL);
      setStickOrigin(null);
      setSprinting(false);
      setPressedActions([]);
      setPassDirection(undefined);
      touch.clear();
    };
    if (visible === false) {
      clear();
      setExpanded(false);
    }
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      touch.clear();
    };
  }, [touch, visible]);

  const moveStick = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = stickGesture.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const rawX = (event.clientX - gesture.origin.x) / gesture.travel;
    const rawZ = (event.clientY - gesture.origin.y) / gesture.travel;
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
    const sprint = dist >= (stickSprint.current ? SPRINT_EXIT : SPRINT_ENTRY);
    if (sprint === stickSprint.current) return;
    stickSprint.current = sprint;
    setSprinting(sprint);
    if (sprint) touch.press(event.pointerId, 'sprint');
    else touch.release(event.pointerId);
  };

  const releaseStick = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    if (stickGesture.current?.pointer !== event.pointerId) return;
    stickGesture.current = null;
    stickSprint.current = false;
    setStick(STILL);
    setStickOrigin(null);
    setSprinting(false);
    touch.move(STILL);
    if (cancel) touch.cancel(event.pointerId);
    else touch.release(event.pointerId);
  };

  const releaseButton = (pointerId: number, cancel = false, end?: Point) => {
    const action = buttonPointers.current.get(pointerId);
    if (!buttonPointers.current.delete(pointerId)) return;
    setPressedActions([...buttonPointers.current.values()]);
    if (action === 'pass' && passGesture.current?.pointer === pointerId) {
      const { origin } = passGesture.current;
      passGesture.current = null;
      setPassDirection(undefined);
      if (!cancel) touch.pass(origin && end ? getSwipeDirection(origin, end) : undefined);
      return;
    }
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
  const renderButton = ({ action, label, accessibleLabel }: Button, visibleActions: readonly TouchAction[]) => {
    const pressed = pressedActions.includes(action) || (action === 'sprint' && sprinting) || (action === 'iconPass' && !!iconPassActive);
    const displayLabel = context === 'offense' && action === 'screen' ? 'Pick'
      : context === 'offball' && action === 'pass' ? 'Call Pass'
      : context === 'offense' && action === 'intenseD' ? 'Post Up'
      : context === 'defense' && action === 'contest' ? 'Block'
      : context === 'loose' && action === 'contest' ? 'Rebound'
      : context === 'loose' && action === 'intenseD' ? 'Box Out'
      : label;
    const isShoot = action === 'shoot';
    const isPass = action === 'pass';
    const isSwipePass = isPass && context === 'offense';
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
        aria-label={displayLabel === label ? accessibleLabel : displayLabel}
        aria-description={isShoot ? 'Tap to shoot, or hold and release to time your shot.'
          : isSwipePass ? 'Tap to pass. Swipe toward a teammate and release to pass in that direction.' : undefined}
        hidden={(!visibleActions.includes(action) && !pressed) || (playerLocked && action === 'switchPlayer')}
        data-pressed={pressed}
        data-green={inGreen || undefined}
        data-aiming={isSwipePass && passDirection ? true : undefined}
        style={chargePct ? ({ '--charge': `${chargePct}%` } as CSSProperties) : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (isPass && passGesture.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          buttonPointers.current.set(event.pointerId, action);
          setPressedActions([...buttonPointers.current.values()]);
          if (isPass) {
            passGesture.current = { pointer: event.pointerId, origin: isSwipePass ? { x: event.clientX, y: event.clientY } : null };
          } else if (action === 'dribble') {
            dribbleSwipes.current.set(event.pointerId, { x: event.clientX, y: event.clientY, swiped: false });
          } else {
            touch.press(event.pointerId, action);
          }
        }}
        onPointerMove={(event) => {
          if (isPass && passGesture.current?.pointer === event.pointerId && passGesture.current.origin) {
            setPassDirection(getSwipeDirection(passGesture.current.origin, { x: event.clientX, y: event.clientY }));
          }
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
        onPointerUp={(event) => releaseButton(event.pointerId, false, { x: event.clientX, y: event.clientY })}
        onPointerCancel={(event) => releaseButton(event.pointerId, true)}
        onLostPointerCapture={(event) => releaseButton(event.pointerId, true)}
        onClick={(event) => {
          if (event.detail !== 0) return;
          if (isPass) touch.pass();
          else {
            touch.press(VIRTUAL_POINTER, action);
            touch.release(VIRTUAL_POINTER);
          }
        }}
      >
        {displayLabel}
        {isShoot && <small aria-hidden="true">Tap or hold</small>}
        {isSwipePass && <small aria-hidden="true">Tap or swipe</small>}
        {isSwipePass && passDirection && <span aria-hidden="true" className="hd-touch-controls__aim"
          style={{ rotate: `${Math.atan2(passDirection.z, passDirection.x)}rad` }}>➜</span>}
      </button>
    );
  };

  const toggleExtras = () => {
    if (expanded) {
      for (const [id, action] of buttonPointers.current) {
        if (!CORE_ACTIONS.has(action)) releaseButton(id, true);
      }
    }
    setExpanded(value => !value);
  };
  if (visible === false) return null;
  return (
    <div className={`hd-touch-controls${visible ? ' hd-touch-controls--visible' : ''}`} role="group" aria-label="Touch controls">
      <div className="hd-touch-controls__movement">
        <div
          className="hd-touch-controls__stick"
          role="img"
          aria-label="Movement joystick"
          aria-description="Place your thumb anywhere in this area and drag to move. Push past the ring to sprint."
          data-active={stickOrigin !== null}
          data-sprinting={sprinting}
          onPointerDown={(event) => {
            if (event.button !== 0 || stickGesture.current) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const origin = { x: event.clientX, y: event.clientY };
            const localOrigin = { x: origin.x - rect.left, y: origin.y - rect.top };
            const travel = Math.max(20, (stickRing.current?.offsetWidth ?? 92) * JOYSTICK_TRAVEL);
            stickGesture.current = { pointer: event.pointerId, origin, travel };
            event.currentTarget.setPointerCapture(event.pointerId);
            setStickOrigin(localOrigin);
          }}
          onPointerMove={moveStick}
          onPointerUp={(event) => releaseStick(event)}
          onPointerCancel={(event) => releaseStick(event, true)}
          onLostPointerCapture={(event) => releaseStick(event, true)}
        >
          <span ref={stickRing} className="hd-touch-controls__ring"
            style={stickOrigin ? { left: stickOrigin.x, top: stickOrigin.y } : undefined}>
            <span className="hd-touch-controls__thumb"
              style={{ left: `${50 + stick.x * JOYSTICK_TRAVEL * 100}%`, top: `${50 + stick.z * JOYSTICK_TRAVEL * 100}%` }} />
          </span>
        </div>
      </div>
      <div className="hd-touch-controls__action-area">
        {context !== 'freeThrow' && <button type="button" className="hd-touch-controls__more"
          aria-expanded={expanded} onClick={toggleExtras}>{expanded ? 'Less' : 'More'}</button>}
        {expanded && <div hidden={context === 'freeThrow'} className="hd-touch-controls__extras" role="group" aria-label="More controls">
          {TOUCH_BUTTONS.filter(({ action }) => !CORE_ACTIONS.has(action))
            .map(button => renderButton(button, EXTRA_ACTIONS[context]))}
          {renderButton(SPRINT_BUTTON, ['sprint'])}
          {tactics}
        </div>}
        <div className="hd-touch-controls__actions">
          {TOUCH_BUTTONS.filter(({ action }) => CORE_ACTIONS.has(action))
            .map(button => renderButton(button, MAIN_ACTIONS[context]))}
        </div>
      </div>
    </div>
  );
}