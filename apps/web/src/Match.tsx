import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Control, DefenseScheme, GameConfig, GameState, OffensePlay, RoomInfo, Side, Team } from '../../../packages/contracts/index.ts';
import { TICK_RATE, COURT, attackSign } from '../../../packages/contracts/index.ts';
import { createEngine, IDEAL_RELEASE, selectPassTarget } from '../../../packages/game-engine/index.ts';
import { computeGreenWindow } from '../../../packages/game-engine/shooting.ts';
import { createCoach } from '../../../packages/basketball-ai/index.ts';
import { createRenderer } from '../../../packages/rendering/index.ts';
import {
  TouchControls, useControls, deriveShotType, formatKeyboardHints, GAMEPAD_HINTS,
  mergeBindings, selectDirectionalPassTarget, selectSwitchTarget,
} from '../../../packages/controls/index.tsx';
import type { KeyboardBindings, TouchContext } from '../../../packages/controls/index.tsx';
import { createRoomClient } from '../../../packages/multiplayer/index.ts';
import { createCourtAudio } from './court-audio.ts';
import { summarizeGame } from '../../../packages/analytics/index.ts';

export type Camera = 'broadcast' | '2k' | 'baseline' | 'courtside' | 'player' | 'cinematic';
export type MatchSetup = {
  teams: [Team, Team]; config: GameConfig; side?: Side; playerLock?: string; initial?: GameState;
  online?: { url: string; code?: string; resume?: boolean };
};
type MatchProps = {
  setup: MatchSetup; camera: Camera; quality: 'auto' | 'low' | 'high'; bindings?: Partial<KeyboardBindings>; mute?: boolean; onExit(): void;
  onResult?(state: GameState): void; onSnapshot?(state: GameState): void;
};

const PLAYS: readonly OffensePlay[] = ['motion', 'pickAndRoll', 'iso', 'fiveOut'];
const PLAY_LABELS: Record<OffensePlay, string> = { motion: 'Motion', pickAndRoll: 'Pick & Roll', iso: 'Isolation', fiveOut: '5-Out' };
const SCHEMES: readonly DefenseScheme[] = ['man', 'zone23', 'switch', 'press'];
const SCHEME_LABELS: Record<DefenseScheme, string> = { man: 'Man-to-Man', zone23: '2-3 Zone', switch: 'Switch All', press: 'Full Press' };

type PrevFrame = { tick: number; players: Map<string, { x: number; z: number; facing: number }>; ball: { x: number; y: number; z: number } };

const captureFrame = (state: GameState): PrevFrame => ({
  tick: state.tick,
  players: new Map(state.players.map(p => [p.id, { x: p.position.x, z: p.position.z, facing: p.facing }])),
  ball: { ...state.ball.position },
});

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

function interpolateState(prev: PrevFrame | null, curr: GameState, alpha: number): GameState {
  if (!prev || alpha >= 0.999 || curr.tick !== prev.tick + 1 || curr.phase !== 'live') return curr;
  const ballDist = Math.hypot(curr.ball.position.x - prev.ball.x, curr.ball.position.y - prev.ball.y, curr.ball.position.z - prev.ball.z);
  const ballPos = ballDist < 2.4
    ? {
      x: prev.ball.x + (curr.ball.position.x - prev.ball.x) * alpha,
      y: prev.ball.y + (curr.ball.position.y - prev.ball.y) * alpha,
      z: prev.ball.z + (curr.ball.position.z - prev.ball.z) * alpha,
    }
    : curr.ball.position;
  const players = curr.players.map(p => {
    const old = prev.players.get(p.id);
    if (!old || Math.hypot(p.position.x - old.x, p.position.z - old.z) >= 2.4) return p;
    return {
      ...p,
      position: { x: old.x + (p.position.x - old.x) * alpha, z: old.z + (p.position.z - old.z) * alpha },
      facing: lerpAngle(old.facing, p.facing, alpha),
    };
  });
  return { ...curr, players, ball: { ...curr.ball, position: ballPos } };
}

function cleanMultiplayerInput(input: Control): Control {
  const out: Control = { move: { x: Math.max(-1, Math.min(1, input.move.x)), z: Math.max(-1, Math.min(1, input.move.z)) } };
  if (input.sprint) out.sprint = true;
  if (input.shoot) out.shoot = true;
  if (input.pass) out.pass = true;
  if (input.targetId) out.targetId = input.targetId;
  if (input.passType) out.passType = input.passType;
  if (input.contest) out.contest = true;
  if (input.steal) out.steal = true;
  if (input.screen) out.screen = true;
  if (input.dribble) out.dribble = true;
  if (input.intenseD) out.intenseD = true;
  if (input.postUp) out.postUp = true;
  if (input.dribbleDir) {
    out.dribbleDir = { x: Math.max(-1, Math.min(1, input.dribbleDir.x)), z: Math.max(-1, Math.min(1, input.dribbleDir.z)) };
  }
  if (input.shotType) out.shotType = input.shotType;
  if (input.pumpFake) out.pumpFake = true;
  if (input.callScreen) out.callScreen = true;
  if (input.callPass) out.callPass = true;
  if (input.offensePlay) out.offensePlay = input.offensePlay;
  if (input.defenseScheme) out.defenseScheme = input.defenseScheme;
  return out;
}

const time = (seconds: number) => {
  const displayed = Math.max(0, Math.ceil(seconds));
  return Math.floor(displayed / 60) + ':' + String(displayed % 60).padStart(2, '0');
};
const initialSelection = (state: GameState, side: Side, locked?: string) =>
  state.players.find(player => player.id === locked)?.id ?? state.players.find(player => player.side === side)?.id ?? '';

export function Match({ setup, camera, quality, bindings, mute, onExit, onResult, onSnapshot }: MatchProps) {
  const stage = useRef<HTMLDivElement>(null);
  const engine = useRef<ReturnType<typeof createEngine> | null>(null);
  const renderer = useRef<ReturnType<typeof createRenderer> | null>(null);
  const client = useRef<ReturnType<typeof createRoomClient> | null>(null);
  const latest = useRef<GameState | null>(null);
  const selected = useRef('');
  const side = useRef<Side>(setup.side ?? 0);
  const autoFollow = useRef(true);
  const passTarget = useRef<string | undefined>(undefined);
  const pausedRef = useRef(false);
  const delivered = useRef(false);
  const [paused, setPaused] = useState(false);
  const [hud, setHud] = useState<GameState | null>(null);
  const [selection, setSelection] = useState('');
  const [room, setRoom] = useState<RoomInfo>();
  const [ready, setReady] = useState(!setup.online);
  const [connection, setConnection] = useState('');
  const [error, setError] = useState('');
  const [showControls, setShowControls] = useState(false);
  const [helpTab, setHelpTab] = useState<'keyboard' | 'gamepad'>('keyboard');
  const [showStats, setShowStats] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cameraMode, setCameraMode] = useState(camera);
  const [offensePlay, setOffensePlay] = useState<OffensePlay>('motion');
  const [defenseScheme, setDefenseScheme] = useState<DefenseScheme>('man');
  const offensePlayRef = useRef<OffensePlay>('motion');
  const defenseSchemeRef = useRef<DefenseScheme>('man');
  const pendingPlayRef = useRef<{ offensePlay?: OffensePlay; defenseScheme?: DefenseScheme }>({});
  const iconPassRef = useRef(false);
  const passTargetPreviewRef = useRef<string | undefined>(undefined);
  const recentSwitchRef = useRef<{ id: string; untilTick: number }>({ id: '', untilTick: -1 });
  const lastPossessionRef = useRef<Side | null>(null);
  const prevFrameRef = useRef<PrevFrame | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const meterFillRef = useRef<HTMLDivElement>(null);
  const meterGreenRef = useRef<HTMLSpanElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  const playCalloutRef = useRef<HTMLDivElement>(null);
  const badgeRefs = useRef<(HTMLSpanElement | null)[]>([null, null, null, null]);
  const controls = useControls({ enabled: !paused && !error && ready, bindings });
  const readControl = useRef(controls.read);
  readControl.current = controls.read;
  const sampleGamepad = useRef(controls.sampleGamepad);
  sampleGamepad.current = controls.sampleGamepad;
  const benchAction = useRef<{ timeout?: boolean; substituteId?: string }>({});
  const [benchPlayer, setBenchPlayer] = useState('');
  const snapshot = useRef(onSnapshot);
  snapshot.current = onSnapshot;
  const result = useRef(onResult);
  result.current = onResult;
  pausedRef.current = paused;

  useEffect(() => {
    const container = stage.current;
    if (!container) return;
    const resetSelection = (state: GameState) => {
      selected.current = initialSelection(state, side.current, setup.playerLock);
      setSelection(selected.current);
    };
    if (!setup.online) {
      engine.current = createEngine(setup.teams, setup.config, setup.initial);
      latest.current = engine.current.state;
      resetSelection(latest.current);
      setHud(latest.current);
    }
    const graphicsQuality = quality === 'auto'
      ? matchMedia('(pointer: coarse)').matches || navigator.hardwareConcurrency < 5 ? 'low' : 'high'
      : quality;
    try {
      renderer.current = createRenderer(container, { quality: graphicsQuality, camera });
      if (latest.current) renderer.current.draw(latest.current, selected.current);
    } catch {
      setError('This browser could not start the 3D court. Try enabling hardware acceleration or opening the game in another browser.');
      return;
    }
    container.focus();
    const audio = mute ? undefined : createCourtAudio();
    if (audio) {
      window.addEventListener('keydown', audio.start, { passive: true });
      window.addEventListener('pointerdown', audio.start, { passive: true });
    }
    const coach = createCoach();
    if (setup.online) {
      const online = setup.online;
      const roomClient = createRoomClient(online.url, {
        onRoom(info) {
          side.current = info.slot;
          setRoom(info);
          setReady(info.ready);
        },
        onState(state, isReady) {
          if (!latest.current || !selected.current) resetSelection(state);
          latest.current = state;
          setReady(isReady);
        },
        onStatus(status) { setConnection(status); },
        onError(message) { setError(message); },
      });
      client.current = roomClient;
      if (online.resume) {
        if (!roomClient.resume()) setError('There is no saved room on this browser.');
      } else if (online.code) {
        roomClient.join(online.code);
      } else {
        roomClient.create({ teams: setup.teams, game: setup.config });
      }
    }
    const readFor = (state: GameState): { id: string; input: Control } => {
      const {
        switchPlayer, passAim, iconPassToggle, iconSlot, callPlay, proStick, ...input
      } = readControl.current();
      const own = state.players.filter(player => player.side === side.current);
      const owner = own.find(player => player.id === state.ball.ownerId);
      const half = state.config.halfCourt ?? state.config.mode === 'blacktop';
      const moveCourt = renderer.current?.projectMove(input.move) ?? input.move;
      if (lastPossessionRef.current !== state.possession) {
        if (lastPossessionRef.current !== null && !setup.playerLock && state.possession !== side.current && own.length > 0) {
          const onBall = [...own].sort((a, b) =>
            Math.hypot(a.position.x - state.ball.position.x, a.position.z - state.ball.position.z) -
            Math.hypot(b.position.x - state.ball.position.x, b.position.z - state.ball.position.z),
          )[0];
          if (onBall) selected.current = onBall.id;
        }
        lastPossessionRef.current = state.possession;
      }
      const looseOrShot = state.ball.ownerId === null;
      const defending = !looseOrShot && state.possession !== side.current && owner?.id !== selected.current;
      const contextSwitch = (defending || looseOrShot) && input.pass && (!input.passType || input.passType === 'chest');
      if (!own.some(player => player.id === selected.current)) selected.current = initialSelection(state, side.current, setup.playerLock);
      if (!setup.playerLock) {
        if (switchPlayer || contextSwitch) {
          autoFollow.current = false;
          const current = own.find(p => p.id === selected.current) ?? own[0];
          const recent = recentSwitchRef.current.untilTick > state.tick ? [recentSwitchRef.current.id] : [];
          const nextId = current ? selectSwitchTarget(current, own, state.ball.position, moveCourt, recent) : undefined;
          if (nextId) {
            recentSwitchRef.current = { id: selected.current, untilTick: state.tick + 45 };
            selected.current = nextId;
          }
        }
        if (owner && autoFollow.current) selected.current = owner.id;
        if (!owner) autoFollow.current = true;
      }

      if (callPlay) {
        if (state.possession === side.current) {
          const next = PLAYS[(PLAYS.indexOf(offensePlayRef.current) + 1) % PLAYS.length];
          offensePlayRef.current = next;
          input.offensePlay = next;
          setOffensePlay(next);
        } else {
          const next = SCHEMES[(SCHEMES.indexOf(defenseSchemeRef.current) + 1) % SCHEMES.length];
          defenseSchemeRef.current = next;
          input.defenseScheme = next;
          setDefenseScheme(next);
        }
      }
      if (pendingPlayRef.current.offensePlay) {
        input.offensePlay = pendingPlayRef.current.offensePlay;
        delete pendingPlayRef.current.offensePlay;
      }
      if (pendingPlayRef.current.defenseScheme) {
        input.defenseScheme = pendingPlayRef.current.defenseScheme;
        delete pendingPlayRef.current.defenseScheme;
      }

      if (owner?.id === selected.current) {
        if (iconPassToggle) iconPassRef.current = !iconPassRef.current;
        const mates = own.filter(player => player.id !== owner.id);
        if (iconPassRef.current && iconSlot !== undefined && mates[iconSlot]) {
          input.pass = true;
          input.targetId = mates[iconSlot].id;
          input.passType = 'chest';
          iconPassRef.current = false;
        }
        if (input.screen) {
          input.callScreen = true;
          input.screen = false;
        }
        if (input.intenseD) {
          input.postUp = true;
          input.intenseD = false;
        }
        const curCharge = state.charge[owner.id] ?? 0;
        const atk = half ? 1 : attackSign(side.current);
        const distToRim = Math.hypot(atk * COURT.rimX - owner.position.x, -owner.position.z);
        const ownerSpeed = Math.hypot(owner.velocity.x, owner.velocity.z);
        const drivingRim = distToRim < 3.4 && ownerSpeed > 1.8;
        if (!input.shoot && !input.pass && curCharge > 0 && curCharge <= 0.12 && !state.freeThrow && !drivingRim) {
          input.pumpFake = true;
        }
        if (input.shoot) {
          const rim = { x: atk * COURT.rimX, z: 0 };
          if (input.postUp) {
            input.shotType = moveCourt.x * atk < -0.35 ? 'fadeaway' : 'hook';
          } else {
            const proStickCourt = proStick ? (renderer.current?.projectMove(proStick) ?? proStick) : undefined;
            const shotType = deriveShotType(owner, moveCourt, rim, { sprint: input.sprint, dribble: input.dribble, proStickCourt });
            if (shotType) input.shotType = shotType;
          }
        }
        const aim = passAim ? (renderer.current?.projectMove(passAim) ?? passAim) : moveCourt;
        const preview = (passTarget.current && mates.some(p => p.id === passTarget.current))
          ? passTarget.current
          : selectDirectionalPassTarget(owner, own, aim) ?? selectPassTarget(owner, own, moveCourt, half ? 1 : attackSign(side.current));
        passTargetPreviewRef.current = preview;
        if (input.pass && !input.targetId) {
          if (passTarget.current && mates.some(player => player.id === passTarget.current)) {
            input.targetId = passTarget.current;
          } else if (passAim) {
            const target = selectDirectionalPassTarget(owner, own, renderer.current?.projectMove(passAim) ?? passAim);
            if (target) input.targetId = target;
          }
          passTarget.current = undefined;
          iconPassRef.current = false;
        }
      } else {
        iconPassRef.current = false;
        passTargetPreviewRef.current = undefined;
        if (looseOrShot) {
          if (input.shoot) {
            input.contest = true;
            input.shoot = false;
          }
          if (input.intenseD) {
            input.screen = true;
            input.intenseD = false;
          }
          if (input.pass) {
            input.pass = false;
            delete input.passType;
          }
        } else {
          if (state.possession === side.current && input.pass) {
            input.callPass = true;
          }
          if (defending) {
            if (input.dribble) {
              input.steal = true;
              input.dribble = false;
            }
            if (input.pass) {
              if (input.passType === 'bounce') input.steal = true;
              else if (input.passType === 'lob') input.contest = true;
              input.pass = false;
              delete input.passType;
            }
            if (input.shoot) {
              input.contest = true;
              input.shoot = false;
            }
            if (state.ball.kind === 'held' && input.screen) {
              input.intenseD = true;
              input.screen = false;
            }
          }
        }
      }

      if (input.dribbleDir) {
        input.dribbleDir = renderer.current?.projectMove(input.dribbleDir) ?? input.dribbleDir;
      }
      input.move = moveCourt;
      Object.assign(input, benchAction.current);
      benchAction.current = {};
      return { id: selected.current, input };
    };
    let frame = 0;
    let last = performance.now();
    let lastHud = 0;
    let lastSave = 0;
    let measuredFrames = 0;
    let slowFrames = 0;
    let qualityAdjusted = false;
    let residual = 0;
    const tickMs = 1000 / TICK_RATE;
    const loop = (now: number) => {
      if (!pausedRef.current) sampleGamepad.current();
      if (!document.hidden && quality === 'auto' && graphicsQuality === 'high' && !qualityAdjusted) {
        const frameMs = now - last;
        if (frameMs > 0 && frameMs < 150) {
          measuredFrames++;
          if (frameMs > 25) slowFrames++;
        }
        if (measuredFrames === 90) {
          if (slowFrames > 27) renderer.current?.setQuality('low');
          qualityAdjusted = true;
        }
      }
      const local = engine.current;
      let state = latest.current;
      if (local && !pausedRef.current && local.state.phase !== 'final') {
        residual += Math.min(100, now - last);
        while (residual >= tickMs) {
          prevFrameRef.current = captureFrame(local.state);
          const { id, input } = readFor(local.state);
          const ai = coach.controls(local.state, new Set([id]), { [id]: input });
          state = local.step({ ...ai, [id]: input });
          residual -= tickMs;
        }
        latest.current = state;
        if (state && snapshot.current && now - lastSave > 1800) {
          snapshot.current(state);
          lastSave = now;
        }
      } else if (setup.online && state && now - last >= 0) {
        residual += Math.min(100, now - last);
        if (residual >= 33) {
          const { id, input } = readFor(state);
          client.current?.input(id, cleanMultiplayerInput(input));
          residual %= 33;
        }
      }
      last = now;
      if (state) {
        const alpha = local && !pausedRef.current && state.phase === 'live' ? Math.max(0, Math.min(1, residual / tickMs)) : 1;
        const renderState = local ? interpolateState(prevFrameRef.current, state, alpha) : state;
        const hints = passTargetPreviewRef.current ? { passTargetId: passTargetPreviewRef.current } : undefined;
        renderer.current?.draw(renderState, selected.current, hints);

        // Update 60/120Hz projected court overlays directly without React re-renders
        const r = renderer.current;
        const activePlayer = renderState.players.find(p => p.id === selected.current);
        const curCharge = renderState.charge[selected.current] ?? 0;
        const meterEl = meterRef.current;
        const meterFillEl = meterFillRef.current;
        if (meterEl && meterFillEl && r && activePlayer && curCharge > 0 && !pausedRef.current) {
          const pt = r.projectPoint(activePlayer.position.x, 2.25, activePlayer.position.z);
          if (pt.visible) {
            meterEl.hidden = false;
            meterEl.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -100%)`;
            const pct = Math.min(100, (curCharge / 0.96) * 100);
            meterFillEl.style.width = `${pct.toFixed(1)}%`;
            const defenders = renderState.players.filter(p => p.side !== activePlayer.side);
            const closestDef = defenders.reduce<{ d: number; contesting: boolean }>((best, q) => {
              const d = Math.hypot(q.position.x - activePlayer.position.x, q.position.z - activePlayer.position.z);
              const c = q.pose === 'contest' || !!q.action?.intenseD;
              return d < best.d ? { d, contesting: c } : best;
            }, { d: 99, contesting: false });
            const halfCourt = renderState.config.halfCourt ?? renderState.config.mode === 'blacktop';
            const rimX = (halfCourt ? 1 : attackSign(activePlayer.side)) * COURT.rimX;
            const range = Math.hypot(rimX - activePlayer.position.x, -activePlayer.position.z);
            const rating = range < 3.2 ? activePlayer.profile.ratings.finishing : activePlayer.profile.ratings.shooting;
            const estPressure = Math.max(0, Math.min(1, 1 - closestDef.d / 2.2)) * (closestDef.contesting ? 0.65 : 0.25);
            const { greenWindow: gw } = computeGreenWindow(rating, 0, estPressure, 0, false, false, (activePlayer.action?.hotStreak ?? 0) >= 2);
            const idealPct = (IDEAL_RELEASE / 0.96) * 100;
            const widthPct = ((gw * 2) / 0.96) * 100;
            if (meterGreenRef.current) {
              meterGreenRef.current.style.left = `${(idealPct - widthPct / 2).toFixed(2)}%`;
              meterGreenRef.current.style.width = `${widthPct.toFixed(2)}%`;
            }
            meterEl.dataset.zone = Math.abs(curCharge - IDEAL_RELEASE) <= gw ? 'green' : curCharge > IDEAL_RELEASE + gw ? 'late' : 'early';
          } else {
            meterEl.hidden = true;
          }
        } else if (meterEl) {
          meterEl.hidden = true;
        }

        const fb = renderState.shotFeedback;
        const calloutEl = calloutRef.current;
        if (calloutEl && r && fb && renderState.tick - fb.tick < 96 && !pausedRef.current) {
          const shooter = renderState.players.find(p => p.id === fb.playerId);
          if (shooter) {
            const pt = r.projectPoint(shooter.position.x, 2.48, shooter.position.z);
            if (pt.visible) {
              calloutEl.hidden = false;
              calloutEl.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -100%)`;
              calloutEl.dataset.tone = fb.green ? 'green' : fb.timing.includes('Slightly') || fb.timing === 'Excellent' ? 'good' : 'miss';
              calloutEl.textContent = `${fb.green ? 'GREEN' : fb.timing.toUpperCase()} · ${fb.contest.toUpperCase()}${fb.bank ? ' · BANK' : ''}`;
            } else {
              calloutEl.hidden = true;
            }
          } else {
            calloutEl.hidden = true;
          }
        } else if (calloutEl) {
          calloutEl.hidden = true;
        }

        const playCalloutEl = playCalloutRef.current;
        const callout = renderState.callout;
        if (playCalloutEl && r && callout && renderState.tick - callout.tick >= 0 && renderState.tick - callout.tick < 72 && !pausedRef.current) {
          const actor = callout.playerId ? renderState.players.find(p => p.id === callout.playerId) : undefined;
          const pt = actor ? r.projectPoint(actor.position.x, 2.72, actor.position.z) : null;
          playCalloutEl.hidden = false;
          playCalloutEl.dataset.tone = callout.tone;
          playCalloutEl.textContent = callout.text;
          if (pt && pt.visible) {
            playCalloutEl.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -100%)`;
          } else {
            playCalloutEl.style.transform = `translate(${(container.clientWidth * 0.5).toFixed(1)}px, ${(container.clientHeight * 0.24).toFixed(1)}px) translate(-50%, -100%)`;
          }
        } else if (playCalloutEl) {
          playCalloutEl.hidden = true;
        }

        const ownOwner = renderState.ball.ownerId === selected.current && renderState.possession === side.current;
        const mates = ownOwner ? renderState.players.filter(p => p.side === side.current && p.id !== selected.current) : [];
        for (let i = 0; i < 4; i++) {
          const el = badgeRefs.current[i];
          if (!el) continue;
          const mate = mates[i];
          if (iconPassRef.current && mate && r && !pausedRef.current) {
            const pt = r.projectPoint(mate.position.x, 2.38, mate.position.z);
            if (pt.visible) {
              el.hidden = false;
              el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -100%)`;
            } else {
              el.hidden = true;
            }
          } else {
            el.hidden = true;
          }
        }

        if (!pausedRef.current) audio?.update(state, selected.current);
        if (now - lastHud >= 70 || (state.phase === 'final' && !delivered.current)) {
          setHud({ ...state, ball: { ...state.ball }, charge: { ...state.charge }, score: [...state.score] });
          setSelection(selected.current);
          lastHud = now;
        }
        if (state.phase === 'final' && !delivered.current) {
          delivered.current = true;
          snapshot.current?.(state);
          result.current?.(state);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      if (audio) {
        window.removeEventListener('keydown', audio.start);
        window.removeEventListener('pointerdown', audio.start);
        audio.dispose();
      }
      client.current?.close(false);
      client.current = null;
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [setup, quality, camera, mute]);

  useEffect(() => renderer.current?.setCamera(cameraMode), [cameraMode]);
  useEffect(() => {
    if (setup.online) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && hud?.phase !== 'final') setPaused(value => !value);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [setup.online, hud?.phase]);
  const localPlayer = hud?.players.find(player => player.id === selection);
  const bench = hud?.teams[side.current].roster.filter(player => !hud.players.some(active => active.id === player.id)) ?? [];
  const event = hud?.events.at(-1);
  const finish = hud?.phase === 'final';
  const touchContext: TouchContext = hud?.freeThrow
    ? 'freeThrow'
    : hud?.ball.kind === 'loose' || hud?.ball.kind === 'shot'
      ? 'loose'
      : hud?.possession === side.current
        ? (hud?.ball.ownerId === selection ? 'offense' : 'offball')
        : 'defense';
  const lastScore = hud?.events.findLast(value => value.type === 'score');
  const scoreFlash = lastScore && hud && hud.tick - lastScore.tick < TICK_RATE;
  const charge = hud?.charge[selection] ?? 0;
  const keyboardHints = useMemo(() => formatKeyboardHints(mergeBindings(bindings)), [bindings]);
  const cycleTactical = () => {
    if (hud?.possession === side.current) {
      const next = PLAYS[(PLAYS.indexOf(offensePlayRef.current) + 1) % PLAYS.length];
      offensePlayRef.current = next;
      pendingPlayRef.current.offensePlay = next;
      setOffensePlay(next);
    } else {
      const next = SCHEMES[(SCHEMES.indexOf(defenseSchemeRef.current) + 1) % SCHEMES.length];
      defenseSchemeRef.current = next;
      pendingPlayRef.current.defenseScheme = next;
      setDefenseScheme(next);
    }
    stage.current?.focus();
  };
  const copy = async () => {
    if (!room) return;
    const invite = new URL(window.location.href);
    invite.searchParams.set('room', room.code);
    try { await navigator.clipboard.writeText(invite.href); setCopied(true); }
    catch { setError('Could not copy the link. Share room code ' + room.code + '.'); }
  };
  const returnToMenu = () => {
    if (latest.current) snapshot.current?.(latest.current);
    onExit();
  };

  const renderFouls = (count: number | undefined, regulation: boolean) => {
    if (!regulation || count === undefined) return null;
    return <span className={'team-fouls' + (count >= 5 ? ' bonus' : '')}>{count >= 5 ? 'BONUS' : `F:${count}`}</span>;
  };

  return <main className="match">
    <div className="court-stage" tabIndex={-1} ref={stage} aria-label="Interactive 3D basketball court" onPointerDown={event => {
      const playerId = renderer.current?.pickPlayer(event.clientX, event.clientY);
      if (setup.playerLock || !latest.current?.players.some(player => player.id === playerId && player.side === side.current)) return;
      if (!playerId) return;
      if (latest.current.ball.ownerId === selected.current && playerId !== selected.current) passTarget.current = playerId;
      else { selected.current = playerId; autoFollow.current = false; setSelection(playerId); }
    }} />
    <div className="court-overlays" aria-hidden="true">
      <div className="overhead-meter" ref={meterRef} hidden>
        <span className="overhead-meter__green" ref={meterGreenRef} />
        <div className="overhead-meter__fill" ref={meterFillRef} />
        <i className="overhead-meter__notch" style={{ left: `${(IDEAL_RELEASE / 0.96) * 100}%` }} />
      </div>
      <div className="shot-callout" ref={calloutRef} hidden />
      <div className="play-callout" ref={playCalloutRef} hidden />
      {[0, 1, 2, 3].map(slot => (
        <span key={slot} className="icon-badge" ref={el => { badgeRefs.current[slot] = el; }} hidden>{slot + 1}</span>
      ))}
    </div>
    <div className="match-top">
      <div className="match-tools">
        <button className="icon-button" aria-label="Exit game" onClick={returnToMenu}>←</button>
        <button className="icon-button desktop-only" aria-label="Controls" onClick={() => setShowControls(value => !value)}>?</button>
      </div>
      {hud && <div className={'scoreboard' + (scoreFlash ? ' scoring' : '')} aria-label="Scoreboard">
        <div className="score-team"><i style={{ background: hud.teams[0].color }} /><span className="score-abbr">{hud.teams[0].abbreviation}{renderFouls(hud.teamFouls?.[0], hud.config.mode === 'regulation')}</span><strong>{hud.score[0]}</strong></div>
        <div className="score-clock"><strong>{time(hud.clock)}</strong><span>{hud.config.mode === 'blacktop' ? 'TO ' + (hud.config.targetScore ?? 11) : 'Q' + hud.period} <b>{Math.ceil(hud.shotClock)}</b></span></div>
        <div className="score-team"><strong>{hud.score[1]}</strong><span className="score-abbr">{hud.teams[1].abbreviation}{renderFouls(hud.teamFouls?.[1], hud.config.mode === 'regulation')}</span><i style={{ background: hud.teams[1].color }} /></div>
      </div>}
      <div className="match-tools right">
        <label className="match-camera"><svg aria-hidden="true" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="2" y="5" width="13" height="14" rx="3"/><path d="m15 10 6-4v12l-6-4"/></svg><select aria-label="Camera" value={cameraMode} onChange={event => { setCameraMode(event.target.value as Camera); setTimeout(() => stage.current?.focus(), 0); }}>
          <option value="broadcast">Broadcast</option><option value="2k">2K</option><option value="baseline">Baseline</option><option value="courtside">Courtside</option><option value="player">Player lock</option><option value="cinematic">Cinematic</option>
        </select></label>
        {!setup.online && <button className="icon-button" aria-label="Pause game" onClick={() => setPaused(true)}>Ⅱ</button>}
      </div>
    </div>

    {localPlayer && <div className="player-hud"><div className="hud-name"><i style={{ background: hud?.teams[localPlayer.side].color }} /> <strong>{localPlayer.profile.name}</strong> <small>#{localPlayer.profile.number}</small></div>
      <div className="meter stamina" aria-label="Stamina"><i style={{ width: (localPlayer.stamina <= 1 ? localPlayer.stamina * 100 : localPlayer.stamina) + '%' }} /></div>
      {hud && (hud.ball.ownerId === localPlayer.id ? ((localPlayer.action?.ballState === 'dead' || (localPlayer.action?.hotStreak ?? 0) >= 2) ? <div className="hud-status">
        {localPlayer.action?.ballState === 'dead' && <span className="ball-chip dead">PICKUP</span>}
        {(localPlayer.action?.hotStreak ?? 0) >= 2 && <span className="ball-chip hot">HOT {localPlayer.action?.hotStreak}x</span>}
      </div> : null) : localPlayer.action?.intenseD ? <div className="hud-status">
        <span className="ball-chip defense">TIGHT D</span>
      </div> : null)}
      {event && event.type !== 'pass' && <p>{event.detail ?? ({ score: 'Basket', miss: 'Missed shot', rebound: 'Rebound', steal: 'Steal', block: 'Block', shot: 'Shot attempt', foul: 'Foul', turnover: 'Turnover', period: 'Period ended', assist: 'Assist', timeout: 'Timeout', substitution: 'Substitution' } as Record<string, string>)[event.type]}</p>}
    </div>}
    {hud && !paused && !finish && !error && (
      <button type="button" className="tactical-pill desktop-only" onClick={cycleTactical} title="Click or press R to cycle">
        <span>{hud.possession === side.current ? 'OFFENSE' : 'DEFENSE'}</span>
        <strong>{hud.possession === side.current ? PLAY_LABELS[offensePlay] : SCHEME_LABELS[defenseScheme]}</strong>
      </button>
    )}
    {hud && !paused && !finish && !error && (
      <div className="context-bar desktop-only" aria-label="Active controls">
        {hud.ball.ownerId === null ? <>
          <span><kbd>Space</kbd> Rebound</span>
          <span><kbd>L</kbd>/<kbd>E</kbd> Box Out</span>
          <span><kbd>J</kbd> Switch</span>
        </> : hud.possession === side.current ? <>
          <span><kbd>Space</kbd> Shoot / Tap Fake</span>
          <span><kbd>J</kbd> Pass</span>
          <span><kbd>K</kbd> Dribble</span>
          <span><kbd>L</kbd> Post-Up</span>
          <span><kbd>E</kbd> Screen</span>
        </> : <>
          <span><kbd>L</kbd> Tight D</span>
          <span><kbd>J</kbd> Switch</span>
          <span><kbd>Space</kbd> Block</span>
          <span><kbd>K</kbd> Steal</span>
        </>}
      </div>
    )}
    <TouchControls touch={controls.touch} context={touchContext} charge={charge} visible={paused || finish || !ready ? false : undefined} />
    {showControls && <div className="control-help"><div className="panel-head"><h3>Controls</h3><button className="icon-button" onClick={() => { setShowControls(false); stage.current?.focus(); }}>×</button></div>
      <div className="help-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={helpTab === 'keyboard'} className={helpTab === 'keyboard' ? 'active' : ''} onClick={() => setHelpTab('keyboard')}>Keyboard</button>
        <button type="button" role="tab" aria-selected={helpTab === 'gamepad'} className={helpTab === 'gamepad' ? 'active' : ''} onClick={() => setHelpTab('gamepad')}>Gamepad</button>
      </div>
      {(helpTab === 'keyboard' ? keyboardHints : GAMEPAD_HINTS).map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
    </div>}
    {setup.online && !error && (!ready || connection === 'reconnecting') && <Overlay>
      <p className="eyebrow">PRIVATE MATCH</p>
      <h2>{connection === 'reconnecting' ? 'Reconnecting' : room ? 'Waiting for a friend' : 'Connecting to the court'}</h2>
      {room && <><p>Share this room code with a friend. The game starts when both players join.</p><div className="room-code">{room.code}</div>
        <button className="button primary" onClick={copy}>{copied ? 'Link copied' : 'Copy invite link'}</button></>}
      <button className="button" onClick={returnToMenu}>Leave room</button>
    </Overlay>}
    {error && <Overlay><h2>Couldn’t start the match</h2><p>{error}</p><button className="button primary" onClick={returnToMenu}>Back to menu</button></Overlay>}
    {paused && !finish && !error && <Overlay><p className="eyebrow">GAME PAUSED</p><h2>Take a breather</h2>
      <button className="button primary" onClick={() => { setPaused(false); stage.current?.focus(); }}>Resume game</button>
      <button className="button" onClick={returnToMenu}>{onSnapshot ? 'Save and exit' : 'Back to menu'}</button>
      {!setup.playerLock && bench.length > 0 && <div className="bench-panel">
        <button className="button" onClick={() => { benchAction.current = { timeout: true }; setPaused(false); stage.current?.focus(); }}>Call timeout</button>
        <label>Bench player <select value={benchPlayer} onChange={event => setBenchPlayer(event.target.value)}><option value="">Select substitute</option>{bench.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
        <button className="button" disabled={!benchPlayer} onClick={() => { benchAction.current = { substituteId: benchPlayer }; setBenchPlayer(''); setPaused(false); stage.current?.focus(); }}>Substitute {localPlayer?.profile.name ?? 'selected player'}</button>
      </div>}
    </Overlay>}
    {finish && hud && !error && <Overlay>
      <p className="eyebrow">FINAL SCORE</p>
      <h2>{hud.teams[hud.score[0] > hud.score[1] ? 0 : 1].name} win</h2>
      <div className="final-score">{hud.score[0]} <span>–</span> {hud.score[1]}</div>
      <button className="button primary" onClick={() => setShowStats(value => !value)}>{showStats ? 'Close box score' : 'View box score'}</button>
      <button className="button" onClick={returnToMenu}>Back to menu</button>
      {showStats && <BoxScore state={hud} />}
    </Overlay>}
  </main>;
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="match-overlay"><section className="match-dialog">{children}</section></div>;
}

export function BoxScore({ state }: { state: GameState }) {
  const { players, shots } = summarizeGame(state);
  return <div className="box-score">
    <div className="scroll-table"><table><thead><tr><th>Player</th><th>PTS</th><th>FG</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>eFG%</th><th>TS%</th></tr></thead>
      <tbody>{players.filter(p => p.points || p.attempts || p.rebounds || p.assists || p.steals || p.blocks).map(player => <tr key={player.id}>
        <td>{player.name}</td><td>{player.points}</td><td>{player.makes}/{player.attempts}</td><td>{player.rebounds}</td><td>{player.assists}</td><td>{player.steals}</td><td>{player.blocks}</td><td>{player.effectiveFieldGoal === null ? '—' : Math.round(100 * player.effectiveFieldGoal) + '%'}</td><td>{player.trueShooting === null ? '—' : Math.round(100 * player.trueShooting) + '%'}</td>
      </tr>)}</tbody></table></div>
    {shots.length > 0 && <div className="shot-chart" aria-label="Shot chart">
      <svg viewBox="0 0 300 160" role="img" aria-label="Shot locations. Green makes, red misses.">
        <rect x="1" y="1" width="298" height="158" /><path d="M150 1v158 M1 54h60v52H1 M299 54h-60v52h60" /><circle cx="150" cy="80" r="22" />
        {shots.map(({ event, made }, i) => <circle key={i} cx={(event.position!.x / COURT.length + 0.5) * 300} cy={(event.position!.z / COURT.width + 0.5) * 160} r="3.3" className={made ? 'make' : 'miss'}><title>{made ? 'Made' : 'Missed'} · {event.points ?? 2} points</title></circle>)}
      </svg>
      <p><span className="made-label">● Made</span> <span className="miss-label">● Missed</span></p>
    </div>}
  </div>;
}
