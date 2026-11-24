import type { Player, Position, Team } from '../contracts/index.ts';
import { estimateStrength } from './body.ts';
import { validateRoster } from './index.ts';
import type { RosterPack } from './index.ts';
import { gradeNbaPlayer } from './ratings.ts';
import type { NbaGrade, SeasonLine } from './ratings.ts';
import bios from './data/nba-rosters.json' with { type: 'json' };
import stats from './data/nba-season-stats.json' with { type: 'json' };

export const NBA_MODEL_VERSION = 2;
const source = 'ESPN player bios · BoxScore Lab season data';
const seasonLines = stats.players as Record<string, SeasonLine[]>;
const espnIds = stats.espnIds as Record<string, string>;
const nameKey = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');

type Athlete = { id: string; displayName?: string; jersey?: string; height?: number; weight?: number; age?: number;
  position?: string | null; salary?: number; yearsRemaining?: number; };
type BioTeam = { updatedAt: string; conference: Team['conference'];
  team: { abbreviation: string; location: string; name: string; color?: string | null };
  athletes: Athlete[]; };
const teamsData = bios as BioTeam[];

function linesFor(id: string, name: string): SeasonLine[] {
  return seasonLines[espnIds[id] ?? nameKey(name)] ?? [];
}

function playerPosition(position: string | undefined | null, height: number, seasons: SeasonLine[]): Position {
  if (position === 'PG' || position === 'SG' || position === 'SF' || position === 'PF' || position === 'C') return position;
  if (position === 'G') {
    const games = seasons.reduce((total, row) => total + row.games, 0);
    const assists = seasons.reduce((total, row) => total + row.assists, 0);
    return height < 1.91 || (games > 0 && assists / games > 4.4) ? 'PG' : 'SG';
  }
  if (position === 'F') return height > 2.025 ? 'PF' : 'SF';
  return height >= 2.06 ? 'C' : 'SF';
}

function startersFirst(players: Player[]) {
  const positions: Position[] = ['PG', 'SG', 'SF', 'PF', 'C'];
  const byAbility = [...players].sort((a, b) => b.overall - a.overall || b.ratings.iq - a.ratings.iq || a.id.localeCompare(b.id));
  const lineups = new Map<number, { score: number; slots: (Player | undefined)[] }>([[0, { score: 0, slots: Array(5).fill(undefined) }]]);
  for (const player of byAbility) {
    for (const [mask, lineup] of [...lineups]) {
      positions.forEach((position, slot) => {
        const next = mask | (1 << slot);
        if (next === mask) return;
        const distance = Math.abs(positions.indexOf(position) - positions.indexOf(player.position));
        const score = lineup.score + player.overall - distance * 5;
        if ((lineups.get(next)?.score ?? -Infinity) >= score) return;
        const slots = [...lineup.slots];
        slots[slot] = player;
        lineups.set(next, { score, slots });
      });
    }
  }
  const starters = lineups.get(31)?.slots.filter((player): player is Player => !!player) ?? [];
  return [...starters, ...byAbility.filter(player => !starters.includes(player))];
}

export function getPlayerGrade(player: Player): NbaGrade {
  return gradeNbaPlayer(player.position, linesFor(player.id.split('-').at(-1) ?? '', player.name), player.age);
}

function convertRoster(data: BioTeam, ids: Set<string>, omissions: string[]): Team {
  const { team, conference } = data;
  const roster: Player[] = [];
  for (const athlete of data.athletes) {
    const { id, displayName: name, age, height: inches } = athlete;
    if (!name || !id || typeof age !== 'number' || typeof inches !== 'number' ||
      !Number.isFinite(age) || !Number.isFinite(inches) || ids.has(id)) {
      omissions.push(team.abbreviation + ' ' + (name ?? id) + ' · incomplete or duplicate record');
      continue;
    }
    ids.add(id);
    const weight = typeof athlete.weight === 'number' && athlete.weight > 0 ? athlete.weight * 0.45359237 : undefined;
    const height = inches * 0.0254;
    const season = linesFor(id, name);
    const position = playerPosition(athlete.position, height, season);
    const playerGrade = gradeNbaPlayer(position, season, age);
    const number = Number(athlete.jersey);
    roster.push({
      id: 'nba-' + id, name, number: Number.isInteger(number) && number >= 0 && number <= 99 ? number : 0,
      age, height, weight, position, overall: playerGrade.overall, potential: playerGrade.potential,
      ratings: { ...playerGrade.ratings, strength: estimateStrength(height, weight) }, gradeEvidence: playerGrade.evidence,
      salary: athlete.salary, years: athlete.yearsRemaining,
    });
  }
  const color = team.color && /^[0-9a-f]{6}$/i.test(team.color) ? '#' + team.color : '#17408b';
  return { id: team.abbreviation.toLowerCase(), city: team.location, name: team.name, abbreviation: team.abbreviation,
    conference, color, accent: '#efeadf', roster: startersFirst(roster) };
}

/** The checked-in snapshot makes all teams selectable in a fresh browser without external fetches. */
export async function loadNbaRosters(): Promise<RosterPack> {
  const ids = new Set<string>();
  const omissions: string[] = [];
  const teams = teamsData.map(team => convertRoster(team, ids, omissions));
  return validateRoster({ version: 1, source, updatedAt: stats.snapshotDate, modelVersion: NBA_MODEL_VERSION, teams, omissions });
}
