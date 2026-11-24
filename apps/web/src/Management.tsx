import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Difficulty, GameState, Position, Ratings, Team } from '../../../packages/contracts/index.ts';
import { summarizeGame } from '../../../packages/analytics/index.ts';
import { createFictionalTeam } from '../../../packages/roster-data/index.ts';
import { advanceOffseason, addExpansionTeam, createFranchise, draftProspect, getCapSheet,
  getNextUserGame, getStandings, getTeamForGame, getInjuryReport, getSeasonLeaders,
  createPlayedBoxScore, extendContract, findTradeTargets, getRotation, setTeamRotation, recordGameResult, scoutProspect, signFreeAgent,
  simulateDays, simulateNextDay, simulateToEnd, tradePlayers } from '../../../packages/franchise/index.ts';
import type { FranchiseState } from '../../../packages/franchise/index.ts';
import { careerLineup, completeCombine, createCareer, draftPlayer, recordCareerGame, trainPlayer, trainingCost } from '../../../packages/career/index.ts';
import type { Archetype, Career, CareerPath, Interview } from '../../../packages/career/index.ts';
import type { FacialHair, Hairstyle, SleeveSide } from '../../../packages/contracts/index.ts';
import { FACIAL_HAIR_STYLES, HAIR_STYLES, HAIR_TONES, SKIN_TONES } from '../../../packages/rendering/appearance.ts';
import { contractLabel, Field, numberLabel, PageHeading, readLocal, TeamChip, teamLabel, writeLocal } from './App.tsx';
import type { MatchSetup } from './Match.tsx';

type HubProps = {
  teams: Team[]; difficulty: Difficulty;
  start(setup: MatchSetup, done: (state: GameState) => void): void;
};

const phases = { regular: 'Regular season', playoffs: 'Playoffs', offseason: 'Offseason' };
const sectionNames = ['Overview', 'Roster', 'Schedule', 'Standings', 'Transactions', 'Draft', 'Expansion', 'History'] as const;
type FranchiseSection = typeof sectionNames[number];
const markets = [
  ['Las Vegas', 'Vipers', 'LVV', '#b3423e', 'West'], ['Seattle', 'Summit', 'SUM', '#25604a', 'West'],
  ['Vancouver', 'Orcas', 'ORC', '#0974a0', 'West'], ['Montréal', 'Rooks', 'ROK', '#306cd3', 'East'],
  ['Mexico City', 'Sol', 'SOL', '#d65d2d', 'West'], ['London', 'Lionhearts', 'LON', '#9b244d', 'East'],
  ['Paris', 'Lumière', 'PAR', '#3463ad', 'East'], ['Madrid', 'Toros', 'MAD', '#a23376', 'East'],
  ['Berlin', 'Bears', 'BER', '#536871', 'East'], ['Rome', 'Gladiators', 'ROM', '#9a3e35', 'East'],
  ['Athens', 'Owls', 'ATH', '#43528c', 'East'], ['Istanbul', 'Spires', 'IST', '#9a2e3e', 'East'],
  ['Tel Aviv', 'Waves', 'TLV', '#2366cb', 'East'], ['Dubai', 'Falcons', 'DXB', '#8a722a', 'East'],
  ['Tokyo', 'Crane', 'TYO', '#d4544d', 'West'], ['Manila', 'Torch', 'MNL', '#b53f2c', 'West'],
  ['Sydney', 'Surf', 'SUR', '#087d8b', 'West'], ['Lagos', 'Lions', 'LOS', '#1e7769', 'West'],
  ['Accra', 'Stars', 'ACC', '#ba6334', 'East'], ['Johannesburg', 'Gold', 'JHB', '#705663', 'East'],
] as const;

export function FranchiseHub({ teams, difficulty, start }: HubProps) {
  const [state, setState] = useState(() => readLocal<FranchiseState>('franchise'));
  const [selectedTeam, setSelectedTeam] = useState(teams[0].id);
  const [length, setLength] = useState(teams.length >= 30 ? 82 : 14);
  const [fantasy, setFantasy] = useState(false);
  const [section, setSection] = useState<FranchiseSection>('Overview');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const save = (next: FranchiseState) => { setState(next); writeLocal('franchise', next); };
  const run = (action: () => FranchiseState) => {
    try { const updated = action(); save(updated); setNotice(updated.news[0] ?? 'Franchise updated.'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'The transaction could not be completed.'); }
  };
  if (!state || creating) return <>
    <PageHeading title="Franchise" subtitle="Lead a team through the schedule, postseason, and offseason." actions={creating && <button className="button" onClick={() => setCreating(false)}>Back to save</button>} />
    <form className="panel form-panel compact-form" onSubmit={event => {
      event.preventDefault();
      try {
        save(createFranchise(teams, { userTeamId: selectedTeam, seasonLength: length, playoffBestOf: length <= 20 ? 3 : 7, fantasyDraft: fantasy }));
        setSection('Overview');
        setCreating(false);
        setNotice('');
      } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to start the franchise.'); }
    }}>
      <h2>{state ? 'Replace franchise save' : 'New franchise'}</h2>
      {state && <p>Starting a new franchise will replace the franchise on this browser.</p>}
      <Field label="Your team"><select value={selectedTeam} onChange={event => setSelectedTeam(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{teamLabel(team)}</option>)}</select></Field>
      <Field label="Games per team"><select value={length} onChange={event => setLength(Number(event.target.value))}><option value={14}>14 games</option><option value={28}>28 games</option><option value={58}>58 games</option><option value={82}>82 games</option></select></Field>
      <label className="toggle-line"><input type="checkbox" checked={fantasy} onChange={event => setFantasy(event.target.checked)} />Start with a fantasy draft</label>
      <button className="button primary">Start franchise</button>
      {notice && <p role="status">{notice}</p>}
    </form>
  </>;

  const team = state.teams.find(value => value.id === state.userTeamId)!;
  const next = getNextUserGame(state);
  const record = state.standings.find(value => value.teamId === team.id)!;
  const lookup = (id: string | undefined) => state.teams.find(value => value.id === id);
  const label = (id: string | undefined) => lookup(id)?.name ?? 'TBD';
  const playoffGames = state.playoffs.length;
  const sheet = getCapSheet(state, team.id);
  const play = () => {
    if (!next) return;
    const home = getTeamForGame(state, next.homeId);
    const away = getTeamForGame(state, next.awayId);
    if (!home || !away) return;
    start({ teams: [home, away], side: home.id === team.id ? 0 : 1, config: { difficulty, periodSeconds: 90, periods: 4 } },
      outcome => run(() => recordGameResult(state, next.id, outcome.score[0], outcome.score[1], createPlayedBoxScore(outcome, summarizeGame(outcome).players))));
  };
  return <>
    <PageHeading title={teamLabel(team)} subtitle={state.year + ' season · ' + phases[state.phase] + ' · Day ' + state.day}
      actions={<button className="button" onClick={() => setCreating(true)}>New franchise</button>} />
    <nav className="section-tabs" aria-label="Franchise sections">{sectionNames.map(value => <button key={value} className={value === section ? 'selected' : ''} onClick={() => setSection(value)}>{value}</button>)}</nav>
    {notice && <p className="status-line" role="status">{notice}</p>}
    {section === 'Overview' && <>
      <div className="metric-strip"><Metric title="Record" value={record.wins + '–' + record.losses} /><Metric title="Teams" value={state.teams.length} /><Metric title="Payroll" value={contractLabel(sheet.payroll)} /><Metric title="Cap room" value={contractLabel(sheet.capSpace)} /></div>
      <div className="columns">
        <section className="panel form-panel"><h2>{state.phase === 'offseason' ? 'Offseason' : 'Next game'}</h2>
          {next && <div className="fixture"><span>{label(next.awayId)}</span><small>AT</small><span>{label(next.homeId)}</span></div>}
          {!next && state.phase !== 'offseason' && <p>Your team has no scheduled games. Simulate the next league day to continue.</p>}
          {state.phase === 'offseason' ? <>
            <p>Scout or select a prospect, make roster moves, and open the next season.</p>
            <button className="button primary" onClick={() => run(() => advanceOffseason(state))}>Start next season</button>
          </> : <div className="actions">
            <button className="button primary" disabled={!next} onClick={play}>Play next game</button>
            <button className="button" onClick={() => run(() => simulateNextDay(state))}>Simulate day</button>
            <button className="button" onClick={() => run(() => simulateDays(state, 7))}>Simulate week</button>
            <button className="button" onClick={() => run(() => simulateToEnd(state))}>Simulate season</button>
          </div>}
        </section>
        <section className="panel"><div className="panel-head"><h2>League wire</h2></div><ul className="news-list">{state.news.slice(0, 8).map((news, index) => <li key={index}>{news}</li>)}</ul></section>
      </div>
    </>}
    {section === 'Roster' && <div className="columns">
      <section className="panel"><div className="panel-head"><div className="inline-team"><TeamChip team={team} /><h2>Roster and payroll</h2></div></div>
        <PlayerTable players={sheet.players} />
      </section>
      <RosterManagement state={state} team={team} run={run} />
    </div>}
    {section === 'Standings' && <div className="columns">
      {(['East', 'West'] as const).map(conference => <section className="panel" key={conference}><div className="panel-head"><h2>{conference}</h2></div><div className="scroll-table">
        <table><thead><tr><th>Team</th><th>W</th><th>L</th><th>PCT</th><th>DIFF</th></tr></thead><tbody>
          {getStandings(state, conference).map(row => <tr key={row.teamId} className={row.teamId === team.id ? 'user-row' : ''}>
            <td>{label(row.teamId)}</td><td>{row.wins}</td><td>{row.losses}</td><td>{(row.wins / Math.max(1, row.wins + row.losses)).toFixed(3)}</td><td>{row.pointsFor - row.pointsAgainst}</td>
          </tr>)}
        </tbody></table>
      </div></section>)}
    </div>}
    {section === 'Schedule' && <div className="columns">
      <section className="panel"><div className="panel-head"><h2>Team schedule</h2></div><div className="scroll-table"><table>
        <thead><tr><th>Day</th><th>Opponent</th><th>Venue</th><th>Result</th></tr></thead><tbody>
          {state.schedule.filter(game => game.homeId === team.id || game.awayId === team.id).map(game => <tr key={game.id}>
            <td>{game.day}</td><td>{label(game.homeId === team.id ? game.awayId : game.homeId)}</td><td>{game.homeId === team.id ? 'Home' : 'Away'}</td>
            <td>{game.homeScore === undefined ? 'Upcoming' : game.awayScore + ' @ ' + game.homeScore}</td>
          </tr>)}
        </tbody>
      </table></div></section>
      <section className="panel"><div className="panel-head"><h2>Playoff bracket</h2></div>
        {playoffGames ? <ul className="news-list">{state.playoffs.map(series => <li key={series.id}><small>{series.conference} · Round {series.round}</small><br />{label(series.homeId)} {series.homeWins} – {series.awayWins} {label(series.awayId)} {series.winnerId && '· ' + label(series.winnerId) + ' advance'}</li>)}</ul> : <p className="panel-copy">The bracket opens after the regular season.</p>}
      </section>
    </div>}
    {section === 'Transactions' && <Transactions state={state} run={run} />}
    {section === 'Draft' && <section className="panel"><div className="panel-head"><div><h2>Prospect big board</h2><p>Scout prospects throughout the season. Make your pick in the offseason.</p></div>
      <span className="status-chip">{state.draftPicks.filter(pick => pick.teamId === team.id && !pick.prospectId).length} open picks</span></div>
      <div className="scroll-table"><table><thead><tr><th>Prospect</th><th>POS</th><th>Age</th><th>Grade</th><th>Potential</th><th>Scouting</th><th>Action</th></tr></thead><tbody>
        {[...state.prospects].sort((a, b) => b.projectedOverall - a.projectedOverall).slice(0, 75).map(player => <tr key={player.id}>
          <td>{player.name}</td><td>{player.position}</td><td>{player.age}</td><td>{player.scouted ? player.overall : '~' + player.projectedOverall}</td><td>{player.report ? player.report.potentialLow + '–' + player.report.potentialHigh : '—'}</td><td>{player.report ? player.report.strengths.join(', ') : (player.origin ?? '—')}</td>
          <td><div className="actions">{!player.scouted && <button className="button small" onClick={() => run(() => scoutProspect(state, player.id))}>Scout</button>}
            {state.phase === 'offseason' && state.draftPicks.some(pick => pick.teamId === team.id && !pick.prospectId) && <button className="button small" onClick={() => run(() => draftProspect(state, player.id))}>Draft</button>}</div></td>
        </tr>)}
      </tbody></table></div>
    </section>}
    {section === 'Expansion' && <Expansion state={state} run={run} />}
    {section === 'History' && <section className="panel"><div className="panel-head"><h2>Championship history</h2></div>
      {state.history.length ? <div className="scroll-table"><table><thead><tr><th>Season</th><th>Champion</th><th>Runner-up</th><th>MVP</th></tr></thead><tbody>
        {[...state.history].reverse().map(season => <tr key={season.year}><td>{season.year}</td><td>{label(season.championId)}</td><td>{label(season.runnerUpId)}</td><td>{season.awards?.find(award => award.title.includes('Valuable'))?.playerName ?? '—'}</td></tr>)}
      </tbody></table></div> : <p className="panel-copy">Play through a season to crown your first champion.</p>}
    </section>}
  </>;
}

function Metric({ title, value }: { title: string; value: string | number }) {
  return <div className="metric"><span>{title}</span><strong>{value}</strong></div>;
}

function PlayerTable({ players }: { players: Team['roster'] }) {
  return <div className="scroll-table"><table><thead><tr><th>Player</th><th>POS</th><th>Age</th><th>OVR</th><th>POT</th><th>Salary</th><th>Years</th></tr></thead>
    <tbody>{players.map(player => <tr key={player.id}><td>{player.name}</td><td>{player.position}</td><td>{player.age}</td><td>{player.overall}</td><td>{player.potential}</td><td>{contractLabel(player.salary)}</td><td>{player.years ?? '—'}</td></tr>)}</tbody>
  </table></div>;
}

function RosterManagement({ state, team, run }: { state: FranchiseState; team: Team; run(action: () => FranchiseState): void }) {
  const [extensionId, setExtension] = useState('');
  const [extensionSalary, setExtensionSalary] = useState(5);
  const currentRotation = getRotation(team, state.rotations?.[team.id]);
  const injuries = getInjuryReport(state, team.id);
  const leaders = getSeasonLeaders(state, 'points', 5);
  const move = (id: string, direction: -1 | 1) => {
    const ids = currentRotation.map(player => player.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    run(() => setTeamRotation(state, team.id, ids));
  };
  return <section className="panel form-panel">
    <h2>Rotation</h2>
    <div className="scroll-table"><table><thead><tr><th>Player</th><th>Role</th><th>Move</th></tr></thead><tbody>
      {currentRotation.map((player, i) => <tr key={player.id}><td>{player.name}</td><td>{i < 5 ? 'Starter' : 'Bench'}</td><td><div className="actions">
        <button className="button small" disabled={i === 0} aria-label={'Move ' + player.name + ' up'} onClick={() => move(player.id, -1)}>↑</button>
        <button className="button small" disabled={i === currentRotation.length - 1} aria-label={'Move ' + player.name + ' down'} onClick={() => move(player.id, 1)}>↓</button>
      </div></td></tr>)}
    </tbody></table></div>
    <h3>Injury report</h3>
    <p>{injuries.length ? injuries.map(injury => (team.roster.find(player => player.id === injury.playerId)?.name ?? 'Player') + ' · ' + injury.description + ' (return day ' + injury.returnDay + ')').join(', ') : 'No active injuries.'}</p>
    <h3>League scoring leaders</h3>
    {leaders.length ? <ol>{leaders.map(player => <li key={player.playerId}>{player.name} · {numberLabel(player.points / player.games)} PPG</li>)}</ol> : <p>Season totals appear after the first game.</p>}
    <h3>Extend a contract</h3>
    <Field label="Player"><select value={extensionId} onChange={event => setExtension(event.target.value)}><option value="">Choose a player</option>{team.roster.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></Field>
    <Field label="Extension salary ($M)"><input type="number" min="1.25" step="0.01" value={extensionSalary} onChange={event => setExtensionSalary(Number(event.target.value))} /></Field>
    <button className="button" disabled={!extensionId} onClick={() => run(() => extendContract(state, team.id, extensionId, Math.round(extensionSalary * 1e6), 2))}>Offer two-year extension</button>
  </section>;
}

function Transactions({ state, run }: { state: FranchiseState; run(action: () => FranchiseState): void }) {
  const team = state.teams.find(item => item.id === state.userTeamId)!;
  const others = state.teams.filter(item => item.id !== team.id);
  const [partnerId, setPartner] = useState(others[0].id);
  const [outgoing, setOutgoing] = useState('');
  const [incoming, setIncoming] = useState('');
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('');
  const [signing, setSigning] = useState('');
  const [salary, setSalary] = useState(2);
  const [years, setYears] = useState(2);
  const partner = others.find(item => item.id === partnerId) ?? others[0];
  const tradeTargets = outgoing ? findTradeTargets(state, team.id, outgoing) : [];
  const sheets = getCapSheet(state, team.id);
  const agents = [...state.freeAgents].filter(a => a.name.toLowerCase().includes(search.toLowerCase()) && (!position || position === a.position)).sort((a, b) => b.overall - a.overall);
  return <div className="columns">
    <section className="panel form-panel"><h2>Trade finder</h2><p>Tax {contractLabel(sheets.luxuryTax)} · First apron {contractLabel(sheets.firstApron)} · Second apron {contractLabel(sheets.secondApron)}</p>
      <Field label="Trading partner"><select value={partner.id} onChange={event => { setPartner(event.target.value); setIncoming(''); }}>{others.map(item => <option key={item.id} value={item.id}>{teamLabel(item)}</option>)}</select></Field>
      <Field label="Send player"><select value={outgoing} onChange={event => setOutgoing(event.target.value)}><option value="">Choose a player</option>{team.roster.map(player => <option key={player.id} value={player.id}>{player.name} · {player.position} · {player.overall} OVR · {contractLabel(player.salary)}</option>)}</select></Field>
      <Field label="Receive player"><select value={incoming} onChange={event => setIncoming(event.target.value)}><option value="">Choose a player</option>{partner.roster.map(player => <option key={player.id} value={player.id}>{player.name} · {player.position} · {player.overall} OVR · {contractLabel(player.salary)}</option>)}</select></Field>
      <button className="button primary" disabled={!team.roster.some(player => player.id === outgoing) || !partner.roster.some(player => player.id === incoming)}
        onClick={() => run(() => tradePlayers(state, team.id, [outgoing], partner.id, [incoming]))}>Submit trade</button>
      {tradeTargets.length > 0 && <div className="scroll-table"><table><thead><tr><th>Cap-valid matches</th><th>Team</th><th>OVR</th></tr></thead><tbody>
        {tradeTargets.slice(0, 8).map(({ player, teamId }) => <tr key={player.id}><td><button className="button small" onClick={() => { setPartner(teamId); setIncoming(player.id); }}>{player.name}</button></td><td>{state.teams.find(value => value.id === teamId)?.abbreviation}</td><td>{player.overall}</td></tr>)}
      </tbody></table></div>}
    </section>
    <section className="panel form-panel"><h2>Free agency</h2>
      <div className="settings-row">
        <Field label="Search"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Player name" /></Field>
        <Field label="Position"><select value={position} onChange={event => setPosition(event.target.value)}><option value="">All</option>{['PG', 'SG', 'SF', 'PF', 'C'].map(value => <option key={value}>{value}</option>)}</select></Field>
      </div>
      <Field label="Free agent"><select value={signing} onChange={event => { setSigning(event.target.value); const player = agents.find(item => item.id === event.target.value); if (player) setSalary(Math.max(1.25, (player.salary ?? 2e6) / 1e6)); }}><option value="">Choose a player</option>
        {agents.map(player => <option key={player.id} value={player.id}>{player.name} · {player.position} · {player.overall} OVR</option>)}</select></Field>
      <div className="settings-row">
        <Field label="Annual salary ($M)"><input type="number" min="1.25" max="100" step="0.01" value={salary} onChange={event => setSalary(Number(event.target.value))} /></Field>
        <Field label="Contract years"><input type="number" min="1" max="4" step="1" value={years} onChange={event => setYears(Number(event.target.value))} /></Field>
      </div>
      <button className="button primary" disabled={!state.freeAgents.some(player => player.id === signing)} onClick={() => run(() => signFreeAgent(state, team.id, signing, Math.round(salary * 1e6), years))}>Sign free agent</button>
    </section>
  </div>;
}

function Expansion({ state, run }: { state: FranchiseState; run(action: () => FranchiseState): void }) {
  const [marketIndex, setMarketIndex] = useState(0);
  const market = markets[marketIndex];
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(market[3]);
  const [conference, setConference] = useState<Team['conference']>(market[4]);
  const [target, setTarget] = useState(state.teams.length >= 30 ? [32, 36, 40].find(count => count > state.teams.length) ?? 40 : state.teams.length + 1);
  const add = (event: FormEvent) => {
    event.preventDefault();
    run(() => {
      if (target - state.teams.length < 1) throw new Error('Choose a league size above the current team count.');
      let updated = state;
      for (let i = 0; i < target - state.teams.length; i++) {
        const [city, defaultName, abbreviation, defaultColor, defaultConference] = markets[(marketIndex + i) % markets.length];
        const id = 'exp-' + (state.teams.length + i) + '-' + abbreviation.toLowerCase();
        const uniqueCode = updated.teams.some(team => team.abbreviation === abbreviation) ? 'X' + (state.teams.length + i) : abbreviation;
        const expansion = createFictionalTeam(id, city, i === 0 && name.trim() ? name.trim() : defaultName,
          uniqueCode, i === 0 ? color : defaultColor, '#f9ece2', i === 0 ? conference : defaultConference, state.teams.length + i + 40);
        updated = addExpansionTeam(updated, { ...expansion, roster: [] });
      }
      return updated;
    });
  };
  return <form className="panel form-panel compact-form" onSubmit={add}>
    <h2>League expansion</h2><p>{state.teams.length} active teams. Expansion opens in the offseason.</p>
    <Field label="New league size"><select value={target} onChange={event => setTarget(Number(event.target.value))}>
      {[...new Set([Math.min(40, state.teams.length + 1), 32, 36, 40])].filter(value => value >= state.teams.length).sort((a, b) => a - b).map(value => <option key={value}>{value}</option>)}
    </select></Field>
    <Field label="First expansion market"><select value={marketIndex} onChange={event => {
      const index = Number(event.target.value); setMarketIndex(index); setColor(markets[index][3]); setConference(markets[index][4]); setName('');
    }}>{markets.map(([city], index) => <option key={city} value={index}>{city}</option>)}</select></Field>
    <Field label="Team name"><input value={name} maxLength={30} onChange={event => setName(event.target.value)} placeholder={market[1]} /></Field>
    <Field label="Team color"><input type="color" value={color} onChange={event => setColor(event.target.value)} /></Field>
    <Field label="Conference"><select value={conference} onChange={event => setConference(event.target.value as Team['conference'])}><option>East</option><option>West</option></select></Field>
    <button className="button primary" disabled={state.phase !== 'offseason' || target <= state.teams.length}>Add expansion teams</button>
  </form>;
}

const formatLabel = (value: string) => value.replace(/([A-Z])/g, ' $1').replace(/^./, ch => ch.toUpperCase());
const toImperialHeight = (cm: number) => {
  const totalIn = Math.round(cm / 2.54);
  return `${Math.floor(totalIn / 12)}'${totalIn % 12}"`;
};

function PlayerAvatarPreview({ skinTone, hairstyle, hairTone, facialHair, headband, armSleeve, height, wingspanCm, weight }: {
  skinTone: string; hairstyle: Hairstyle; hairTone: string; facialHair: FacialHair; headband: boolean; armSleeve: SleeveSide;
  height: number; wingspanCm: number; weight: number;
}) {
  const h = hairstyle.toLowerCase();
  const f = facialHair.toLowerCase();
  return <div className="myplayer-preview" aria-label="MyPlayer preview">
    <svg viewBox="0 0 96 108" width="96" height="108">
      <rect width="96" height="108" rx="10" fill="#131926" />
      <path d="M22 96 C22 76 34 70 48 70 C62 70 74 76 74 96 Z" fill="#2563eb" />
      <path d="M39 70 L48 80 L57 70" fill="#f8fafc" stroke="#f59e0b" strokeWidth="2" />
      {(armSleeve === 'left' || armSleeve === 'both') && <rect x="19" y="80" width="9" height="22" rx="4" fill="#0f172a" stroke="#e2e8f0" strokeWidth="1" />}
      {(armSleeve === 'right' || armSleeve === 'both') && <rect x="68" y="80" width="9" height="22" rx="4" fill="#0f172a" stroke="#e2e8f0" strokeWidth="1" />}
      <rect x="42" y="56" width="12" height="16" rx="4" fill={skinTone} />
      {h.includes('afro') && <circle cx="48" cy="34" r="24" fill={hairTone} />}
      {(h.includes('loc') || h.includes('braid') || h.includes('long')) && <>
        <circle cx="48" cy="34" r="21" fill={hairTone} />
        {[29, 34, 62, 67].map(x => <rect key={x} x={x - 2} y="34" width="4" height="26" rx="2" fill={hairTone} />)}
      </>}
      <ellipse cx="48" cy="40" rx="16" ry="19" fill={skinTone} />
      {(h.includes('fade') || h.includes('taper') || h.includes('buzz') || h.includes('medium') || h.includes('curl')) && !h.includes('shaved') && (
        <path d="M32 35 C32 19 64 19 64 35 C58 28 38 28 32 35 Z" fill={hairTone} />
      )}
      {headband && <rect x="31.5" y="25" width="33" height="5" rx="2" fill="#f8fafc" />}
      <circle cx="42" cy="39" r="1.7" fill="#111827" />
      <circle cx="54" cy="39" r="1.7" fill="#111827" />
      {f === 'stubble' && <path d="M35 45 C36 56 60 56 61 45" fill="none" stroke={hairTone} strokeOpacity="0.45" strokeWidth="4" />}
      {f === 'goatee' && <path d="M42 46 L54 46 L52 57 L44 57 Z" fill={hairTone} />}
      {f.includes('beard') && <path d="M33 41 C33 58 63 58 63 41 C58 50 38 50 33 41 Z" fill={hairTone} />}
    </svg>
    <small>{height} cm ({toImperialHeight(height)}) · Span {toImperialHeight(wingspanCm)} · {Math.round(weight * 2.20462)} lb</small>
  </div>;
}

export function CareerHub({ teams, difficulty, start }: HubProps) {
  const [career, setCareer] = useState(() => readLocal<Career>('career'));
  const [name, setName] = useState('');
  const [position, setPosition] = useState<Position>('SG');
  const [height, setHeight] = useState(196);
  const [weight, setWeight] = useState(92);
  const [spanMult, setSpanMult] = useState(1.045);
  const [skinTone, setSkinTone] = useState<string>(SKIN_TONES[3]);
  const [hairstyle, setHairstyle] = useState<Hairstyle>(() => HAIR_STYLES[0]);
  const [hairTone, setHairTone] = useState<string>(HAIR_TONES[0]);
  const [facialHair, setFacialHair] = useState<FacialHair>(() => FACIAL_HAIR_STYLES[0]);
  const [headband, setHeadband] = useState(false);
  const [armSleeve, setArmSleeve] = useState<SleeveSide>('none');
  const [legSleeve, setLegSleeve] = useState<SleeveSide>('none');
  const [archetype, setArchetype] = useState<Archetype>('Sharpshooter');
  const [path, setPath] = useState<CareerPath>('College');
  const [interview, setInterview] = useState<Interview>('Craft');
  const [started, setStarted] = useState<number | null>(null);
  const [combine, setCombine] = useState<number | null>(null);
  const [teamControl, setTeamControl] = useState(false);
  const save = (next: Career) => { setCareer(next); writeLocal('career', next); };
  const clampedHeight = Math.max(168, Math.min(224, Number.isFinite(height) ? height : 196));
  const clampedWeight = Math.max(60, Math.min(145, Number.isFinite(weight) ? weight : 92));
  const wingspanCm = Math.round(clampedHeight * spanMult);
  if (!career) return <>
    <PageHeading title="MyPlayer" subtitle="Create a prospect and earn your spot in the league." />
    <form className="panel form-panel compact-form" onSubmit={event => {
      event.preventDefault();
      save(createCareer({
        name, position, height: clampedHeight / 100, weight: clampedWeight,
        wingspan: Math.round((clampedHeight / 100) * spanMult * 100) / 100,
        appearance: { skinTone, hairstyle, hairTone, facialHair, headband, armSleeve, legSleeve },
        archetype, path, seed: Date.now(),
      }));
    }}>
      <h2>Create your player</h2>
      <Field label="Player name"><input value={name} maxLength={32} required onChange={event => setName(event.target.value)} placeholder="First and last name" /></Field>
      <div className="settings-row">
        <Field label="Position"><select value={position} onChange={event => setPosition(event.target.value as Position)}>{['PG', 'SG', 'SF', 'PF', 'C'].map(value => <option key={value}>{value}</option>)}</select></Field>
        <Field label={`Height (${toImperialHeight(clampedHeight)})`}><input type="number" min="168" max="224" value={height} onChange={event => setHeight(Number(event.target.value))} /></Field>
        <Field label={`Weight (${Math.round(clampedWeight * 2.20462)} lb)`}><input type="number" min="60" max="145" value={weight} onChange={event => setWeight(Number(event.target.value))} /></Field>
      </div>
      <div className="myplayer-studio">
        <PlayerAvatarPreview skinTone={skinTone} hairstyle={hairstyle} hairTone={hairTone} facialHair={facialHair} headband={headband} armSleeve={armSleeve} height={clampedHeight} wingspanCm={wingspanCm} weight={clampedWeight} />
        <div>
          <Field label={`Wingspan (${wingspanCm} cm · ${toImperialHeight(wingspanCm)})`}>
            <select value={String(spanMult)} onChange={event => setSpanMult(Number(event.target.value))}>
              <option value="1">Short (1.00x height)</option>
              <option value="1.045">Standard (1.045x height)</option>
              <option value="1.08">Long (1.08x height)</option>
              <option value="1.12">Max (1.12x height)</option>
            </select>
          </Field>
          <Field label="Skin tone">
            <div className="swatch-grid">
              {SKIN_TONES.map((tone, idx) => <button type="button" key={tone} aria-label={`Skin tone ${idx + 1}`} className={'swatch-btn' + (skinTone === tone ? ' active' : '')} style={{ background: tone }} onClick={() => setSkinTone(tone)} />)}
            </div>
          </Field>
          <div className="settings-row">
            <Field label="Hairstyle">
              <select value={hairstyle} onChange={event => setHairstyle(event.target.value as Hairstyle)}>
                {HAIR_STYLES.map(style => <option key={style} value={style}>{formatLabel(style)}</option>)}
              </select>
            </Field>
            <Field label="Facial hair">
              <select value={facialHair} onChange={event => setFacialHair(event.target.value as FacialHair)}>
                {FACIAL_HAIR_STYLES.map(style => <option key={style} value={style}>{formatLabel(style)}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Hair color">
            <div className="swatch-grid">
              {HAIR_TONES.map((tone, idx) => <button type="button" key={tone} aria-label={`Hair color ${idx + 1}`} className={'swatch-btn' + (hairTone === tone ? ' active' : '')} style={{ background: tone }} onClick={() => setHairTone(tone)} />)}
            </div>
          </Field>
          <div className="settings-row">
            <Field label="Arm sleeve">
              <select value={armSleeve} onChange={event => setArmSleeve(event.target.value as SleeveSide)}>
                {(['none', 'left', 'right', 'both'] as SleeveSide[]).map(side => <option key={side} value={side}>{formatLabel(side)}</option>)}
              </select>
            </Field>
            <Field label="Leg sleeve">
              <select value={legSleeve} onChange={event => setLegSleeve(event.target.value as SleeveSide)}>
                {(['none', 'left', 'right', 'both'] as SleeveSide[]).map(side => <option key={side} value={side}>{formatLabel(side)}</option>)}
              </select>
            </Field>
            <label className="check-inline"><input type="checkbox" checked={headband} onChange={event => setHeadband(event.target.checked)} /> Headband</label>
          </div>
        </div>
      </div>
      <Field label="Archetype"><select value={archetype} onChange={event => setArchetype(event.target.value as Archetype)}>{['Sharpshooter', 'Slasher', 'Playmaker', 'Two-way wing', 'Stretch big', 'Anchor', 'Post scorer', 'Three-level scorer'].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Background"><select value={path} onChange={event => setPath(event.target.value as CareerPath)}><option>College</option><option>International</option></select></Field>
      <button className="button primary">Create player</button>
    </form>
  </>;
  const current = teams.find(team => team.id === career.teamId) ?? teams[0];
  const opponent = teams.filter(team => team.id !== current.id)[career.games % (teams.length - 1)];
  const stageName = career.stage === 'showcase' ? career.path === 'College' ? 'College championship' : 'International showcase' : career.stage === 'combine' ? 'Combine and interview' : career.stage === 'draft' ? 'Draft night' : 'Pro season ' + career.season;
  const play = () => {
    const team = career.stage === 'showcase' ? { ...current, name: career.path === 'College' ? 'College All-Stars' : 'International Select', abbreviation: 'PROS' } : current;
    start({ teams: [careerLineup(career, team), opponent], playerLock: teamControl ? undefined : career.player.id, config: { difficulty, periodSeconds: 75, periods: 2 } }, state => {
      const stats = summarizeGame(state).players.find(player => player.id === career.player.id);
      if (stats) save(recordCareerGame(career, { ...stats, won: state.score[0] > state.score[1] }));
    });
  };
  return <>
    <PageHeading title={career.player.name} subtitle={career.archetype + ' · ' + career.player.position + ' · ' + stageName} />
    <div className="metric-strip"><Metric title="Overall" value={career.player.overall} /><Metric title="Coach trust" value={career.trust} /><Metric title="Chemistry" value={career.chemistry} /><Metric title="Training XP" value={career.xp} /></div>
    <div className="columns">
      <section className="panel form-panel"><h2>{stageName}</h2>
        {career.stage === 'showcase' && <p>Play your showcase to improve your draft stock before the combine.</p>}
        {career.draftPick && <p>Drafted at pick {career.draftPick} by the {teamLabel(current)}.</p>}
        {career.lastGame && <div className="fixture"><span>{career.lastGame.points} PTS</span><span>{career.lastGame.assists} AST</span><span>{career.lastGame.rebounds} REB</span></div>}
        {(career.stage === 'showcase' || career.stage === 'rookie' || career.stage === 'season') && <>
          <label className="toggle-line"><input type="checkbox" checked={teamControl} onChange={event => setTeamControl(event.target.checked)} />Control the full team</label>
          <button className="button primary" onClick={play}>{career.stage === 'showcase' ? 'Play showcase' : 'Play next game'}</button>
        </>}
        {career.stage === 'combine' && <>
          <p>Release near 620 ms for a higher timing grade.</p>
          <button className="button" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setStarted(performance.now()); }}
            onPointerUp={() => { if (started !== null) setCombine(Math.max(0, Math.round(100 - Math.abs(performance.now() - started - 620) / 6))); setStarted(null); }}
            onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) setStarted(performance.now()); }}
            onKeyUp={event => { if ((event.key === ' ' || event.key === 'Enter') && started !== null) { setCombine(Math.max(0, Math.round(100 - Math.abs(performance.now() - started - 620) / 6))); setStarted(null); } }}>{started === null ? 'Hold to start release drill' : 'Release'}</button>
          {combine !== null && <div role="status">Combine grade: {combine}/100</div>}
          <Field label="Interview focus"><select value={interview} onChange={event => setInterview(event.target.value as Interview)}><option value="Craft">Develop my game</option><option value="Team">Help the team</option><option value="Ambition">Make my mark</option></select></Field>
          <button className="button primary" disabled={combine === null} onClick={() => save(completeCombine(career, combine ?? 0, interview))}>Finish combine</button>
        </>}
        {career.stage === 'draft' && <><p>Scouting grade {Math.round(career.draftStock)}/100</p><button className="button primary" onClick={() => save(draftPlayer(career, teams))}>Enter the draft</button></>}
        {career.games > 0 && <div className="metric-strip mini"><Metric title="Games" value={career.games} /><Metric title="Points per game" value={numberLabel(career.totals.points / career.games)} /><Metric title="Wins" value={career.totals.wins} /></div>}
      </section>
      <section className="panel"><div className="panel-head"><h2>Training</h2></div><div className="scroll-table"><table><thead><tr><th>Skill</th><th>Rating</th><th>Upgrade</th></tr></thead>
        <tbody>{Object.entries(career.player.ratings).map(([rating, value]) => {
          const key = rating as keyof Ratings;
          const cost = trainingCost(career, key);
          return <tr key={rating}><td className="capitalized">{rating}</td><td>{value}</td><td><button className="button small" disabled={career.xp < cost || value >= 99} onClick={() => save(trainPlayer(career, key))}>{cost} XP</button></td></tr>;
        })}</tbody>
      </table></div></section>
    </div>
  </>;
}
