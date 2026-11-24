import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Control, GameConfig, GameState, RoomInfo, Side, Team } from '../../../packages/contracts/index.ts';
import { TICK_RATE, COURT } from '../../../packages/contracts/index.ts';
import { createEngine, IDEAL_RELEASE } from '../../../packages/game-engine/index.ts';
import { createCoach } from '../../../packages/basketball-ai/index.ts';
import { createRenderer } from '../../../packages/rendering/index.ts';
import { TouchControls, useControls, KEYBOARD_HINTS } from '../../../packages/controls/index.tsx';
import type { KeyboardBindings } from '../../../packages/controls/index.tsx';
import { createRoomClient } from '../../../packages/multiplayer/index.ts';
import { createCourtAudio } from './court-audio.ts';
import { summarizeGame } from '../../../packages/analytics/index.ts';

export type Camera = 'broadcast' | 'baseline' | 'courtside' | 'player' | 'cinematic';
export type MatchSetup = {
  teams: [Team, Team]; config: GameConfig; side?: Side; playerLock?: string; initial?: GameState;
  online?: { url: string; code?: string; resume?: boolean };
};
type MatchProps = {
  setup: MatchSetup; camera: Camera; quality: 'auto' | 'low' | 'high'; bindings?: KeyboardBindings; mute?: boolean; onExit(): void;
  onResult?(state: GameState): void; onSnapshot?(state: GameState): void;
};

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
  const [showStats, setShowStats] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cameraMode, setCameraMode] = useState(camera);
  const controls = useControls({ enabled: !paused && !error && ready, bindings });
  const readControl = useRef(controls.read);
  readControl.current = controls.read;
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
      const input = readControl.current();
      const own = state.players.filter(player => player.side === side.current);
      const owner = own.find(player => player.id === state.ball.ownerId);
      if (!own.some(player => player.id === selected.current)) selected.current = initialSelection(state, side.current, setup.playerLock);
      if (!setup.playerLock) {
        if (input.switchPlayer) {
          autoFollow.current = false;
          const nearest = [...own].filter(player => player.id !== selected.current).sort((a, b) => {
            const distance = (p: typeof a) => Math.hypot(p.position.x - state.ball.position.x, p.position.z - state.ball.position.z);
            return distance(a) - distance(b);
          })[0];
          if (nearest) selected.current = nearest.id;
        }
        if (owner && autoFollow.current) selected.current = owner.id;
        if (!owner) autoFollow.current = true;
      }
      if (input.pass && passTarget.current) {
        input.targetId = passTarget.current;
        passTarget.current = undefined;
      }
      input.move = renderer.current?.projectMove(input.move) ?? input.move;
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
          const { id, input } = readFor(local.state);
          const ai = coach.controls(local.state, new Set([id]));
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
          client.current?.input(id, input);
          residual %= 33;
        }
      }
      last = now;
      if (state) {
        renderer.current?.draw(state, selected.current);
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
  const lastScore = hud?.events.findLast(value => value.type === 'score');
  const scoreFlash = lastScore && hud && hud.tick - lastScore.tick < TICK_RATE;
  const charge = hud?.charge[selection] ?? 0;
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

  return <main className="match">
    <div className="court-stage" tabIndex={-1} ref={stage} aria-label="Interactive 3D basketball court" onPointerDown={event => {
      const playerId = renderer.current?.pickPlayer(event.clientX, event.clientY);
      if (setup.playerLock || !latest.current?.players.some(player => player.id === playerId && player.side === side.current)) return;
      if (!playerId) return;
      if (latest.current.ball.ownerId === selected.current && playerId !== selected.current) passTarget.current = playerId;
      else { selected.current = playerId; autoFollow.current = false; setSelection(playerId); }
    }} />
    <div className="match-top">
      <div className="match-tools">
        <button className="icon-button" aria-label="Exit game" onClick={returnToMenu}>←</button>
        <button className="icon-button desktop-only" aria-label="Controls" onClick={() => setShowControls(value => !value)}>?</button>
      </div>
      {hud && <div className={'scoreboard' + (scoreFlash ? ' scoring' : '')} aria-label="Scoreboard">
        <div className="score-team"><i style={{ background: hud.teams[0].color }} />{hud.teams[0].abbreviation}<strong>{hud.score[0]}</strong></div>
        <div className="score-clock"><strong>{time(hud.clock)}</strong><span>{hud.config.mode === 'blacktop' ? 'TO ' + (hud.config.targetScore ?? 11) : 'Q' + hud.period} <b>{Math.ceil(hud.shotClock)}</b></span></div>
        <div className="score-team"><strong>{hud.score[1]}</strong>{hud.teams[1].abbreviation}<i style={{ background: hud.teams[1].color }} /></div>
      </div>}
      <div className="match-tools right">
        <select aria-label="Camera" value={cameraMode} onChange={event => { setCameraMode(event.target.value as Camera); setTimeout(() => stage.current?.focus(), 0); }}>
          <option value="broadcast">Broadcast</option><option value="baseline">Baseline</option><option value="courtside">Courtside</option><option value="player">Player lock</option><option value="cinematic">Cinematic</option>
        </select>
        {!setup.online && <button className="icon-button" aria-label="Pause game" onClick={() => setPaused(true)}>Ⅱ</button>}
      </div>
    </div>

    {localPlayer && <div className="player-hud"><div className="hud-name"><i style={{ background: hud?.teams[localPlayer.side].color }} /> <strong>{localPlayer.profile.name}</strong> <small>#{localPlayer.profile.number}</small></div>
      <div className="meter stamina" aria-label="Stamina"><i style={{ width: (localPlayer.stamina <= 1 ? localPlayer.stamina * 100 : localPlayer.stamina) + '%' }} /></div>
      <div className={'meter release' + (charge > 0 ? ' active' : '')} aria-label="Shot release"><i style={{ width: Math.min(100, charge / 1.2 * 100) + '%' }} /><b style={{ left: (IDEAL_RELEASE / 1.2 * 100) + '%' }} /></div>
      {event && event.type !== 'pass' && <p>{event.detail ?? ({ score: 'Basket', miss: 'Missed shot', rebound: 'Rebound', steal: 'Steal', block: 'Block', shot: 'Shot attempt', foul: 'Foul', turnover: 'Turnover', period: 'Period ended', assist: 'Assist', timeout: 'Timeout', substitution: 'Substitution' } as Record<string, string>)[event.type]}</p>}
    </div>}
    <TouchControls touch={controls.touch} />
    {showControls && <div className="control-help"><div className="panel-head"><h3>Keyboard controls</h3><button className="icon-button" onClick={() => { setShowControls(false); stage.current?.focus(); }}>×</button></div>
      {KEYBOARD_HINTS.map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
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
