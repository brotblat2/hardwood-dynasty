import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Difficulty, GameState, Player, Team } from '../../../packages/contracts/index.ts';
import { demoTeams, bobovTeam, parseRosterCsv, validateRoster } from '../../../packages/roster-data/index.ts';
import type { RosterPack } from '../../../packages/roster-data/index.ts';
import { DEFAULT_KEYBOARD_BINDINGS } from '../../../packages/controls/index.tsx';
import type { KeyboardBindings } from '../../../packages/controls/index.tsx';
import { createEngine } from '../../../packages/game-engine/index.ts';
import { createRenderer } from '../../../packages/rendering/index.ts';
import { Match } from './Match.tsx';
import type { MatchSetup, Camera } from './Match.tsx';
import { CareerHub, FranchiseHub } from './Management.tsx';

type Page = 'home' | 'play' | 'franchise' | 'career' | 'online' | 'blacktop' | 'practice' | 'rosters' | 'settings';
type Settings = { difficulty: Difficulty; quality: 'low' | 'high'; camera: Camera; novelty: boolean; server: string; keyboard?: KeyboardBindings };
const defaults: Settings = { difficulty: 'Pro', quality: 'low', camera: 'broadcast', novelty: false, server: '' };
const menu: { id: Exclude<Page, 'home'>; title: string }[] = [
  { id: 'play', title: 'Play Now' }, { id: 'franchise', title: 'Franchise' }, { id: 'career', title: 'MyPlayer' },
  { id: 'online', title: 'Online' }, { id: 'blacktop', title: 'Blacktop' }, { id: 'practice', title: 'Practice' },
  { id: 'rosters', title: 'Rosters' }, { id: 'settings', title: 'Settings' },
];
const descriptions: Record<'franchise' | 'career' | 'online' | 'blacktop', string> = {
  franchise: 'Build a roster, manage the cap, and take your team through the playoffs.',
  career: 'Create a player and play your way from the showcase to the pros.',
  online: 'Open a private room and challenge a friend.',
  blacktop: 'Pick your teams and run a game to 11 or 21.',
};
const difficulties: Difficulty[] = ['Rookie', 'Pro', 'All-Star', 'Superstar', 'Hall of Fame', 'Legendary'];
const titleFor = (page: Page) => menu.find(item => item.id === page)?.title ?? 'Hardwood Dynasty';
export const teamLabel = (team: Team) => team.city + ' ' + team.name;
export const numberLabel = (n: number) => Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
export const heightLabel = (meters: number) => {
  const inches = Math.round(meters / 0.0254);
  return Math.floor(inches / 12) + '′' + inches % 12 + '″';
};
export const weightLabel = (kg?: number) => kg === undefined ? '—' : Math.round(kg / 0.45359237) + ' lb';
export const contractLabel = (n?: number) => n === undefined ? '—' : '$' + (n / 1_000_000).toFixed(1) + 'M';

export function readLocal<T>(key: string): T | undefined {
  try { return JSON.parse(localStorage.getItem('hd-' + key) ?? 'null') as T | null ?? undefined; }
  catch { return undefined; }
}
export function writeLocal(key: string, data: unknown) {
  try {
    if (data === undefined) localStorage.removeItem('hd-' + key);
    else localStorage.setItem('hd-' + key, JSON.stringify(data));
  } catch { /* Storage can be disabled by the browser. */ }
}

type MatchLaunch = {
  setup: MatchSetup; origin: Page; onResult?(state: GameState): void; save?: boolean;
};

function CourtPreview() {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const previewEngine = createEngine([demoTeams[0], demoTeams[1]], { mode: 'regulation' });
    let renderer: ReturnType<typeof createRenderer> | undefined;
    try {
      renderer = createRenderer(element.current, { camera: 'courtside', quality: 'low' });
      renderer.draw(previewEngine.state);
    } catch { return; }
    const observer = new ResizeObserver(() => renderer?.draw(previewEngine.state));
    observer.observe(element.current);
    return () => { observer.disconnect(); renderer?.dispose(); };
  }, []);
  return <div className="hero-preview" ref={element} aria-hidden="true" />;
}

function Basketball({ className }: { className?: string }) {
  return <span className={'basketball ' + (className ?? '')} aria-hidden="true"><i /><b /><em /></span>;
}

export function App() {
  const roomParam = new URLSearchParams(location.search).get('room') ?? '';
  const [page, setPage] = useState<Page>(roomParam ? 'online' : 'home');
  const [settings, setSettings] = useState<Settings>(() => ({ ...defaults, ...readLocal<Settings>('settings') }));
  const [roster, setRoster] = useState<RosterPack | undefined>(() => readLocal('rosters'));
  const [match, setMatch] = useState<MatchLaunch | null>(null);
  const [suspended, setSuspended] = useState<GameState | undefined>(() => readLocal('match'));
  const sourceTeams = roster?.teams ?? demoTeams;
  const teams = settings.novelty && !sourceTeams.some(team => team.id === bobovTeam.id) ? [...sourceTeams, bobovTeam] : sourceTeams;
  const launch = (setup: MatchSetup, onResult?: MatchLaunch['onResult'], save = false) => {
    setMatch({ setup, origin: page, onResult, save });
  };
  const go = (next: Page) => {
    setPage(next);
    window.scrollTo({ top: 0 });
  };
  const updateSettings = (next: Settings) => { setSettings(next); writeLocal('settings', next); };
  const updateRoster = (pack: RosterPack | undefined) => { setRoster(pack); writeLocal('rosters', pack); };
  if (match) {
    return <Match setup={match.setup} camera={settings.camera} quality={settings.quality} bindings={settings.keyboard}
      onExit={() => { setMatch(null); setPage(match.origin); setSuspended(readLocal('match')); }} onResult={match.onResult}
      onSnapshot={match.save ? state => writeLocal('match', state.phase === 'final' ? undefined : state) : undefined} />;
  }
  return <div className="app-shell">
    <header className="app-header">
      <button className="wordmark" onClick={() => go('home')} aria-label="Hardwood Dynasty home"><Basketball /><span>HARDWOOD <b>DYNASTY</b></span></button>
      <nav aria-label="Main navigation">
        {menu.map(item => <button key={item.id} className={page === item.id ? 'nav-active' : ''} onClick={() => go(item.id)}>{item.title}</button>)}
      </nav>
    </header>
    <main className={page === 'home' ? 'home-page' : 'inner-page'}>
      {page === 'home' && <>
        <section className="home-hero">
          <CourtPreview />
          <div className="hero-caption">
            <p className="eyebrow">5-ON-5 BASKETBALL</p>
            <h1>Hardwood<br /><em>Dynasty</em></h1>
            <p>Take the court, build a franchise, or make your name in the league.</p>
            <div className="actions"><button className="button primary" onClick={() => go('play')}>Set up a game <span>↗</span></button>
              {suspended && <button className="button" onClick={() => launch({ teams: suspended.teams, config: suspended.config, initial: suspended }, undefined, true)}>Resume game</button>}</div>
          </div>
          <div className="hero-rail" aria-hidden="true"><span>H</span><span>D</span></div>
        </section>
        <div className="section-heading"><h2>Choose a mode</h2><span>{roster ? roster.teams.length + ' imported teams' : 'Fictional starting league'}</span></div>
        <div className="mode-grid">
          {(['franchise', 'career', 'online', 'blacktop'] as const).map(id => <button className={'mode-card mode-' + id} key={id} onClick={() => go(id)}>
            <div className="mode-glyph" aria-hidden="true">{id === 'franchise' ? '◫' : id === 'career' ? '◎' : id === 'online' ? '⋈' : '◈'}</div>
            <h3>{titleFor(id)}</h3><p>{descriptions[id]}</p><span className="mode-arrow" aria-hidden="true">↗</span>
          </button>)}
        </div>
      </>}
      {['play', 'blacktop', 'practice'].includes(page) && <Setup key={page} mode={page as 'play' | 'blacktop' | 'practice'} teams={teams} settings={settings} onStart={setup => launch(setup, undefined, page !== 'practice')} />}
      {page === 'franchise' && <FranchiseHub teams={teams} start={(setup, done) => launch(setup, done)} difficulty={settings.difficulty} />}
      {page === 'career' && <CareerHub teams={teams} start={(setup, done) => launch(setup, done)} difficulty={settings.difficulty} />}
      {page === 'online' && <Online teams={teams} preset={roomParam} settings={settings} onStart={launch} />}
      {page === 'rosters' && <Rosters teams={teams} pack={roster} change={updateRoster} />}
      {page === 'settings' && <SettingsView value={settings} change={updateSettings} />}
    </main>
    <footer className="app-footer"><span>Hardwood Dynasty</span><span>Desktop · Gamepad · Touch</span></footer>
  </div>;
}

export function PageHeading({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{actions && <div className="actions">{actions}</div>}</div>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
export function TeamChip({ team }: { team: Team }) {
  return <span className="team-chip" style={{ background: team.color, color: '#fff' }}>{team.abbreviation}</span>;
}

function Setup({ mode, teams, settings, onStart }: { mode: 'play' | 'blacktop' | 'practice'; teams: Team[]; settings: Settings; onStart(setup: MatchSetup): void }) {
  const [homeId, setHome] = useState(teams[0].id);
  const [awayId, setAway] = useState(teams[1].id);
  const [period, setPeriod] = useState(60);
  const [periods, setPeriods] = useState(4);
  const [target, setTarget] = useState(11);
  const [players, setPlayers] = useState(3);
  const [half, setHalf] = useState(true);
  const [stays, setStays] = useState(false);
  const [scoring, setScoring] = useState(1);
  const [difficulty, setDifficulty] = useState(settings.difficulty);
  const home = teams.find(team => team.id === homeId) ?? teams[0];
  const away = teams.find(team => team.id === awayId) ?? teams[1];
  return <>
    <PageHeading title={titleFor(mode)} subtitle={mode === 'play' ? 'Choose your matchup and quarter length.' : mode === 'blacktop' ? 'Set the lineup, court, and scoring rules.' : 'Get shots up and find your release timing.'} />
    <form className="panel setup-panel" onSubmit={event => {
      event.preventDefault();
      onStart({ teams: [home, away], config: {
        mode: mode === 'play' ? 'regulation' : mode, difficulty, periodSeconds: period, periods,
        ...(mode === 'blacktop' ? { targetScore: target, playersPerTeam: players, halfCourt: half, makeItTakeIt: stays, scoring: { inside: scoring, outside: scoring + 1 } } : {}),
      } });
    }}>
      <div className="matchup">
        <div className="team-choice" style={{ '--team': home.color } as React.CSSProperties}><TeamChip team={home} /><h2>{home.name}</h2>
          <Field label="Your team"><select value={home.id} onChange={event => setHome(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id} disabled={team.id === away.id}>{teamLabel(team)}</option>)}</select></Field>
        </div>
        <span className="versus">VS</span>
        <div className="team-choice away" style={{ '--team': away.color } as React.CSSProperties}><TeamChip team={away} /><h2>{away.name}</h2>
          <Field label="Opponent"><select value={away.id} onChange={event => setAway(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id} disabled={team.id === home.id}>{teamLabel(team)}</option>)}</select></Field>
        </div>
      </div>
      <div className="settings-row">
        <Field label="Difficulty"><select value={difficulty} onChange={event => setDifficulty(event.target.value as Difficulty)}>{difficulties.map(value => <option key={value}>{value}</option>)}</select></Field>
        {mode === 'play' && <><Field label="Period length"><select value={period} onChange={event => setPeriod(Number(event.target.value))}><option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={120}>2 minutes</option><option value={300}>5 minutes</option><option value={720}>12 minutes</option></select></Field>
          <Field label="Periods"><select value={periods} onChange={event => setPeriods(Number(event.target.value))}><option value={2}>2 periods</option><option value={4}>4 quarters</option></select></Field></>}
        {mode === 'blacktop' && <>
          <Field label="Players per team"><select value={players} onChange={event => setPlayers(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(count => <option key={count}>{count}</option>)}</select></Field>
          <Field label="Play to"><select value={target} onChange={event => setTarget(Number(event.target.value))}><option>11</option><option>21</option></select></Field>
          <Field label="Court"><select value={half ? 'half' : 'full'} onChange={event => setHalf(event.target.value === 'half')}><option value="half">Half court</option><option value="full">Full court</option></select></Field>
          <Field label="Scoring"><select value={scoring} onChange={event => setScoring(Number(event.target.value))}><option value={1}>1s and 2s</option><option value={2}>2s and 3s</option></select></Field>
          <label className="toggle-line"><input type="checkbox" checked={stays} onChange={event => setStays(event.target.checked)} />Make it, take it</label>
        </>}
        <button className="button primary" type="submit">Start game <span>↗</span></button>
      </div>
    </form>
  </>;
}

function Online({ teams, preset, settings, onStart }: { teams: Team[]; preset: string; settings: Settings; onStart(setup: MatchSetup): void }) {
  const [code, setCode] = useState(preset);
  const [home, setHome] = useState(teams[0].id);
  const [away, setAway] = useState(teams[1].id);
  const env = (import.meta as ImportMeta & { env?: { VITE_MULTIPLAYER_URL?: string } }).env;
  const implied = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'ws://' + location.hostname + ':8787/room' : '';
  const endpoint = settings.server || env?.VITE_MULTIPLAYER_URL || implied;
  const connect = (options: { code?: string; resume?: boolean } = {}) => {
    if (!endpoint) return;
    onStart({ teams: [teams.find(team => team.id === home) ?? teams[0], teams.find(team => team.id === away) ?? teams[1]],
      config: { mode: 'regulation', periodSeconds: 90, periods: 4, difficulty: settings.difficulty }, online: { url: endpoint, ...options } });
  };
  return <>
    <PageHeading title="Online" subtitle="Start a private 5-on-5 room or join a friend with their code." />
    {!endpoint && <div className="status-line">Online play needs a multiplayer server address. Enter a WebSocket address in Settings.</div>}
    <div className="columns">
      <section className="panel form-panel"><h2>Create a room</h2>
        <Field label="Home"><select value={home} onChange={event => setHome(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id} disabled={team.id === away}>{teamLabel(team)}</option>)}</select></Field>
        <Field label="Away"><select value={away} onChange={event => setAway(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id} disabled={team.id === home}>{teamLabel(team)}</option>)}</select></Field>
        <button className="button primary" disabled={!endpoint} onClick={() => connect()}>Create room</button>
      </section>
      <form className="panel form-panel" onSubmit={event => { event.preventDefault(); connect({ code: code.trim().toUpperCase() }); }}>
        <h2>Join a room</h2>
        <Field label="Room code"><input value={code} maxLength={10} pattern="[A-Za-z0-9]+"
          autoComplete="off" autoCapitalize="characters" onChange={event => setCode(event.target.value.toUpperCase())} placeholder="Enter code" /></Field>
        <div className="actions"><button className="button primary" disabled={!endpoint || !code.trim()}>Join room</button>
          <button type="button" className="button" disabled={!endpoint} onClick={() => connect({ resume: true })}>Rejoin last room</button></div>
      </form>
    </div>
  </>;
}

function Rosters({ teams, pack, change }: { teams: Team[]; pack?: RosterPack; change(pack: RosterPack | undefined): void }) {
  const [teamId, setTeam] = useState(teams[0].id);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedPlayer] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'));
  const team = teams.find(value => value.id === teamId) ?? teams[0];
  const foundPlayers = (query.trim() ? teams.flatMap(item => item.roster) : team.roster)
    .filter(player => player.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.overall - a.overall || a.name.localeCompare(b.name));
  const selectedPlayer = teams.flatMap(item => item.roster).find(player => player.id === selectedId);
  const load = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const raw = await file.text();
      const imported = file.name.toLowerCase().endsWith('.csv') ? parseRosterCsv(raw, source, date) : validateRoster(JSON.parse(raw));
      change(imported);
      setTeam(imported.teams[0].id);
      setStatus('Imported ' + imported.teams.length + ' teams.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not import the roster.'); }
    finally { setBusy(false); }
  };
  const fetchReal = async () => {
    setBusy(true);
    setStatus('Loading team rosters and player data…');
    try {
      const { loadNbaRosters } = await import('../../../packages/roster-data/nba.ts');
      const imported = await loadNbaRosters();
      change(imported);
      setTeam(imported.teams[0].id);
      const omissions = imported.omissions?.length ?? 0;
      setStatus('Imported ' + imported.teams.length + ' NBA teams. Skill and potential ratings are game estimates.' + (omissions ? ' ' + omissions + ' incomplete player records omitted.' : ''));
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not load NBA rosters. Try a roster file instead.'); }
    finally { setBusy(false); }
  };
  function downloadRoster(current?: RosterPack) {
    const sample: RosterPack = current ?? { version: 1, source: 'Hardwood Dynasty fictional league', updatedAt: new Date().toISOString(), teams: demoTeams };
    const url = URL.createObjectURL(new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = current ? 'hardwood-roster-snapshot.json' : 'hardwood-roster-example.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
  return <>
    <PageHeading title="Rosters" subtitle={pack ? pack.source + ' · ' + new Date(pack.updatedAt).toLocaleDateString() : 'Fictional starting league. Load NBA data or import your own roster pack.'} />
    <div className="columns roster-layout">
      <section className="panel form-panel">
        <h2>Roster source</h2>
        <button className="button primary" onClick={fetchReal} disabled={busy}>Load NBA rosters</button>
        <div className="rule" />
        <h3>Import a file</h3>
        <Field label="Source for CSV imports"><input value={source} onChange={event => setSource(event.target.value)} placeholder="CSV source" /></Field>
        <Field label="Date for CSV imports"><input type="date" value={date} onChange={event => setDate(event.target.value)} /></Field>
        <Field label="CSV or JSON roster"><input type="file" accept=".json,.csv" disabled={busy} onChange={event => { void load(event.target.files?.[0]); event.target.value = ''; }} /></Field>
        <div className="actions"><button className="button" onClick={() => downloadRoster()}>Download example</button>{pack && <button className="button" onClick={() => downloadRoster(pack)}>Export active roster</button>}{pack && <button className="button" onClick={() => change(undefined)}>Use fictional teams</button>}</div>
        {status && <p className="status-line" role="status">{status}</p>}
      </section>
      <section className="panel">
        <div className="panel-head"><div className="inline-team"><TeamChip team={team} /><h2>{teamLabel(team)}</h2></div></div>
        <div className="settings-row">
          <Field label="Team"><select value={team.id} onChange={event => setTeam(event.target.value)}>{teams.map(value => <option key={value.id} value={value.id}>{teamLabel(value)}</option>)}</select></Field>
          <Field label="Search players"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Player name" /></Field>
        </div>
        <div className="scroll-table"><table><thead><tr><th>Player</th><th>POS</th><th>Age</th><th>OVR</th><th>POT</th><th>Height</th><th>Weight</th><th>Strength</th><th>Salary</th></tr></thead>
          <tbody>{foundPlayers.map(player => <tr key={player.id}>
            <td><button className="table-link" onClick={() => setSelectedPlayer(player.id)}>{player.name}</button></td><td>{player.position}</td><td>{player.age}</td>
            <td><strong>{player.overall}</strong></td><td>{player.potential}</td><td>{heightLabel(player.height)}</td><td>{weightLabel(player.weight)}</td>
            <td>{player.ratings.strength ?? '—'}</td><td>{contractLabel(player.salary)}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </div>
    {selectedPlayer && <PlayerCard player={selectedPlayer} close={() => setSelectedPlayer('')} />}
  </>;
}

const ratingsLabels: Record<keyof Player['ratings'], string> = {
  shooting: 'Shooting', finishing: 'Finishing', passing: 'Passing', handling: 'Ball handling',
  rebounding: 'Rebounding', speed: 'Mobility', perimeter: 'Perimeter defense', interior: 'Interior defense',
  iq: 'Decision-making', durability: 'Availability', strength: 'Strength',
};
function PlayerCard({ player, close }: { player: Player; close(): void }) {
  const evidence = player.gradeEvidence === 'established' ? 'Stats-based rating' : player.gradeEvidence === 'limited' ? 'Limited NBA sample' : player.gradeEvidence === 'estimated' ? 'Provisional rating' : undefined;
  return <div className="player-card-overlay" onClick={close}>
    <section className="panel player-card" role="dialog" aria-modal="true" aria-label={player.name + ' ratings'} onClick={event => event.stopPropagation()}>
      <div className="panel-head"><div><h2>{player.name}</h2><p>#{player.number} · {player.position} · {heightLabel(player.height)} · {weightLabel(player.weight)}</p></div>
        <button className="button" onClick={close} autoFocus>Close</button></div>
      <div className="form-panel">
        <div className="metric-strip mini"><div className="metric"><span>Overall</span><strong>{player.overall}</strong></div><div className="metric"><span>Potential</span><strong>{player.potential}</strong></div><div className="metric"><span>Est. strength</span><strong>{player.ratings.strength ?? '—'}</strong></div></div>
        {evidence && <p>{evidence}. Potential and strength are gameplay estimates.</p>}
        <div className="player-ratings">{(Object.keys(ratingsLabels) as (keyof Player['ratings'])[]).filter(key => player.ratings[key] != null).map(key =>
          <div key={key}><span>{ratingsLabels[key]}</span><meter min="25" max="99" value={player.ratings[key]!} /><strong>{player.ratings[key]}</strong></div>)}</div>
      </div>
    </section>
  </div>;
}

const keyboardLabels: Record<keyof KeyboardBindings, string> = {
  up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right',
  shoot: 'Shoot', pass: 'Pass', bouncePass: 'Bounce pass', lobPass: 'Lob pass', sprint: 'Sprint',
  contest: 'Contest', steal: 'Steal', screen: 'Screen', dribble: 'Dribble move', switchPlayer: 'Switch player',
};
export const keyName = (key: string) => key.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, 'Arrow ');

function KeyboardSettings({ value, change }: { value: Settings; change(settings: Settings): void }) {
  const [pending, setPending] = useState<keyof KeyboardBindings>();
  const [message, setMessage] = useState('');
  const keyboard = value.keyboard ?? DEFAULT_KEYBOARD_BINDINGS;
  return <section className="panel form-panel compact-form keyboard-settings">
    <h2>Keyboard controls</h2>
    <p>Choose a control, then press a letter, number, arrow, Space, or Shift.</p>
    <div className="key-grid">{(Object.keys(keyboardLabels) as (keyof KeyboardBindings)[]).map(action => <button
      key={action} type="button" className={'button' + (pending === action ? ' primary' : '')}
      onClick={() => { setPending(action); setMessage(''); }}
      onBlur={() => setPending(current => current === action ? undefined : current)}
      onKeyDown={event => {
        if (pending !== action) return;
        if (event.code === 'Escape') { setPending(undefined); return; }
        if (!/^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|ShiftLeft|ShiftRight)$/.test(event.code)) return;
        event.preventDefault();
        if (Object.entries(keyboard).some(([name, keys]) => name !== action && keys.includes(event.code))) {
          setMessage('That key is already assigned. Choose another key.');
          return;
        }
        change({ ...value, keyboard: { ...keyboard, [action]: [event.code] } });
        setPending(undefined);
        setMessage(keyboardLabels[action] + ' updated.');
      }}>{keyboardLabels[action]} <kbd>{pending === action ? 'Press a key…' : keyboard[action].map(keyName).join(' / ')}</kbd></button>)}</div>
    <button className="button" onClick={() => { change({ ...value, keyboard: undefined }); setMessage('Default controls restored.'); }}>Restore defaults</button>
    {message && <p role="status">{message}</p>}
  </section>;
}

function SettingsView({ value, change }: { value: Settings; change(settings: Settings): void }) {
  const [address, setAddress] = useState(value.server);
  const [status, setStatus] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) {
      try {
        const url = new URL(address);
        if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error();
        if (location.protocol === 'https:' && url.protocol !== 'wss:') throw new Error();
      } catch { setStatus('Enter a valid WebSocket URL. HTTPS pages require wss://.'); return; }
    }
    change({ ...value, server: address.trim() });
    setStatus('Server address saved.');
  };
  return <>
    <PageHeading title="Settings" subtitle="Set your defaults for the court and multiplayer." />
    <div className="columns">
      <section className="panel form-panel"><h2>Game settings</h2>
        <Field label="Difficulty"><select value={value.difficulty} onChange={event => change({ ...value, difficulty: event.target.value as Difficulty })}>{difficulties.map(difficulty => <option key={difficulty}>{difficulty}</option>)}</select></Field>
        <Field label="Graphics"><select value={value.quality} onChange={event => change({ ...value, quality: event.target.value as Settings['quality'] })}><option value="low">Performance</option><option value="high">High quality</option></select></Field>
        <Field label="Default camera"><select value={value.camera} onChange={event => change({ ...value, camera: event.target.value as Camera })}><option value="broadcast">Broadcast</option><option value="baseline">Baseline</option><option value="courtside">Courtside</option><option value="player">Player lock</option><option value="cinematic">Cinematic</option></select></Field>
        <label className="toggle-line"><input type="checkbox" checked={value.novelty} onChange={event => change({ ...value, novelty: event.target.checked })} />Enable Bobov Ballerz</label>
      </section>
      <form className="panel form-panel" onSubmit={save}><h2>Multiplayer connection</h2>
        <Field label="Server WebSocket URL"><input value={address} onChange={event => setAddress(event.target.value)} placeholder="wss://your-server.example/room" /></Field>
        <button className="button primary">Save server address</button>
        {status && <p role="status">{status}</p>}
      </form>
    </div>
    <KeyboardSettings value={value} change={change} />
  </>;
}
