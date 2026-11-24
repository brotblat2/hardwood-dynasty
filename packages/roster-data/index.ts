import type { Player, Position, Ratings, Team } from '../contracts/index.ts';
import { estimateStrength } from './body.ts';

const positions: Position[] = ['PG', 'SG', 'SF', 'PF', 'C'];
const fictionalNames = [
  'Cole Rivers', 'Malik Stone', 'Eli Banks', 'Zion Miles', 'Amir Bell', 'Isaac Hayes', 'Rio Carter',
  'Dante Cole', 'Theo Brooks', 'Miles Okafor', 'Devin King', 'Andre Sharp', 'Julian Ellis', 'Nico West',
  'Cameron Ross', 'Marcus Neal', 'Jaylin Wade', 'Caleb Ortiz', 'Noah North', 'Asa Knox', 'Josiah Reed',
  'Felix Cruz', 'Jamal Reed', 'Luca Nasser', 'Arlo Cole', 'Aaron Quinn', 'Kendrick Lane', 'Avery Wright',
  'Orion Moss', 'Darius Reese', 'Solomon Pike', 'Gabe Simmons', 'Mason Rhodes', 'Micah Slate', 'Jalen Shore',
  'AJ Evans', 'Jon Bloom', 'Sam Owusu', 'Keenan Lowe', 'KJ Hughes', 'Daniel Kim', 'Liam Flynn',
  'Phoenix Ray', 'Dominic Clark', 'Casey Fox', 'Kofi Mensah', 'Adrian Wynn', 'Rafael Silva', 'Kai Hollis',
  'Austin Lee', 'Isaiah Young', 'Tariq Green', 'Seb Rivers', 'Drew Hill', 'Matt Sparks', 'Alex Noble',
  'Cam Ayala', 'Vince Rowe', 'Amari Blake', 'Alex Soto', 'Nick Graham', 'Kieran Hart', 'Deon Ash',
  'Tyrone Young', 'Jasper Law', 'Joey Clarke', 'Tyler Chen', 'Diego Ruiz', 'Kenny Fields', 'Quincy Howe',
  'Reggie March', 'Tyrese Holt', 'Anthony Wells', 'Rory Walsh', 'Simi Adeniyi', 'Alex Turner', 'Derrick Hunt',
  'Seth Murray', 'Malcolm Baker', 'Nate Grant',
];
const ratingKeys = ['shooting', 'finishing', 'passing', 'handling', 'rebounding', 'speed', 'perimeter', 'interior', 'iq', 'durability'] as const;
function unit(seed: number) {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}
const clampRating = (value: number) => Math.max(25, Math.min(99, Math.round(value)));
function generatedRatings(base: number, index: number, position: Position): Ratings {
  const strengths: Record<Position, number[]> = {
    PG: [6, 0, 11, 13, -15, 10, 4, -13, 1, 0],
    SG: [11, 5, 1, 6, -10, 8, 7, -8, 1, 0],
    SF: [5, 6, 0, 2, 0, 3, 8, 1, 1, 0],
    PF: [-5, 7, -4, -5, 9, -3, 0, 11, 1, 0],
    C: [-16, 10, -6, -10, 15, -8, -8, 15, 1, 0],
  };
  return Object.fromEntries(ratingKeys.map((key, skill) => [key, clampRating(base + strengths[position][skill] + (unit(1 + index * 17 + skill) - 0.5) * 12)])) as Ratings;
}

export function createFictionalTeam(id: string, city: string, name: string, abbreviation: string, color: string, accent: string, conference: Team['conference'], index: number): Team {
  return {
    id, city, name, abbreviation, color, accent, conference,
    roster: Array.from({ length: 10 }, (_, slot) => {
      const position = positions[slot % 5];
      const ordinal = index * 10 + slot;
      const overall = Math.round((slot < 5 ? 78 : 67) + unit(ordinal) * 12);
      const height = 1.82 + 0.065 * (slot % 5) + unit(ordinal + 203) * 0.075;
      const weight = Math.round(76 + (slot % 5) * 9 + unit(ordinal + 229) * 15);
      return {
        id: id + '-' + (slot + 1), name: fictionalNames[ordinal % fictionalNames.length], position,
        number: [4, 11, 23, 32, 55, 7, 13, 18, 24, 2][slot],
        height, weight,
        age: 20 + Math.floor(unit(ordinal + 125) * 15),
        overall, potential: Math.min(99, overall + Math.floor(unit(ordinal + 99) * 10)),
        ratings: { ...generatedRatings(overall, ordinal, position), strength: estimateStrength(height, weight) },
        salary: Math.round((overall - 60) ** 2 * 25000), years: 1 + Math.floor(unit(ordinal + 3) * 3),
      };
    }),
  };
}

export const demoTeams: Team[] = [
  createFictionalTeam('bkn', 'Brooklyn', 'Foundry', 'BKF', '#ff570d', '#f8eee6', 'East', 0),
  createFictionalTeam('sea', 'Seattle', 'Cascades', 'SEA', '#176f55', '#e7f3b9', 'West', 1),
  createFictionalTeam('bal', 'Baltimore', 'Breakers', 'BAL', '#6142c8', '#f3bc65', 'East', 2),
  createFictionalTeam('lv', 'Las Vegas', 'Scorpions', 'LVS', '#a84128', '#fff4b8', 'West', 3),
  createFictionalTeam('mtl', 'Montréal', 'North', 'MTL', '#1c64d5', '#eeeeff', 'East', 4),
  createFictionalTeam('van', 'Vancouver', 'Tides', 'VAN', '#127d9a', '#f3f7eb', 'West', 5),
  createFictionalTeam('ldn', 'London', 'Royals', 'LDN', '#ae2f56', '#fff1d2', 'East', 6),
  createFictionalTeam('syd', 'Sydney', 'Kites', 'SYD', '#63428c', '#f8ba46', 'West', 7),
];
const bobovNames = ['Mendy Gottlieb', 'Yossi Rubin', 'Shmuli Halberstam', 'Ari Weiss', 'Dovid Klein', 'Nussi Stein', 'Binyamin Landau', 'Zalman Gold', 'Moishy Braun', 'Yehuda Rosen'];
export const bobovTeam = createFictionalTeam('bob', 'Brooklyn', 'Bobov Ballerz', 'BOB', '#302f3d', '#c9a86a', 'East', 10);
bobovTeam.roster.forEach((player, i) => { player.name = bobovNames[i]; });

export type RosterPack = { version: 1; source: string; updatedAt: string; teams: Team[]; omissions?: string[]; modelVersion?: number };
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const within = (value: unknown, lo: number, hi: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
const hex = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export function validateRoster(input: unknown): RosterPack {
  if (!input || typeof input !== 'object') throw new Error('A roster must include source, updatedAt and teams.');
  const pack = input as RosterPack;
  if (!text(pack.source) || !text(pack.updatedAt) || !Number.isFinite(Date.parse(pack.updatedAt))) throw new Error('Include a source and a valid updatedAt date.');
  if (!Array.isArray(pack.teams) || pack.teams.length < 2 || pack.teams.length > 40) throw new Error('Include 2 to 40 teams.');
  const playerIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const team of pack.teams) {
    if (!team || !text(team.id) || teamIds.has(team.id) || !text(team.city) || !text(team.name) || !text(team.abbreviation) ||
        !hex(team.color) || !hex(team.accent) || !['East', 'West'].includes(team.conference)) throw new Error('Each team needs a unique ID, city, name, abbreviation, conference and two hex colors.');
    teamIds.add(team.id);
    if (!Array.isArray(team.roster) || team.roster.length < 5 || team.roster.length > 25) throw new Error(team.name + ' must have 5 to 25 players.');
    for (const player of team.roster) {
      if (!player || !text(player.id) || playerIds.has(player.id) || !text(player.name) || !positions.includes(player.position) ||
          !within(player.number, 0, 99) || !within(player.age, 16, 60) || !within(player.height, 1.35, 2.55) ||
          !within(player.overall, 25, 99) || !within(player.potential, 25, 99) ||
          !player.ratings || !ratingKeys.every(key => within(player.ratings[key], 25, 99)) ||
          (player.wingspan !== undefined && !within(player.wingspan, 1.4, 2.8)) ||
          (player.weight !== undefined && !within(player.weight, 45, 190)) ||
          (player.ratings.strength !== undefined && !within(player.ratings.strength, 25, 99)) ||
          (player.salary !== undefined && !within(player.salary, 0, 200_000_000)) ||
          (player.years !== undefined && (!within(player.years, 0, 15) || !Number.isInteger(player.years)))) {
        throw new Error('Invalid or duplicate player on ' + team.name + '. Check bio fields and the ten ratings.');
      }
      playerIds.add(player.id);
    }
  }
  if (pack.teams.every(team => team.conference === pack.teams[0].conference)) throw new Error('Include at least one team in each conference.');
  return { version: 1, source: pack.source, updatedAt: pack.updatedAt, teams: pack.teams,
    ...(Array.isArray(pack.omissions) ? { omissions: pack.omissions.filter(text) } : {}),
    ...(Number.isInteger(pack.modelVersion) ? { modelVersion: pack.modelVersion } : {}),
  };
}

export function parseRosterCsv(csv: string, source: string, updatedAt: string): RosterPack {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Unclosed quoted field.');
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  const headers = (rows.shift() ?? []).map(header => header.trim().replace(/^\uFEFF/, ''));
  const teams = new Map<string, Team>();
  for (const values of rows) {
    if (values.length !== headers.length) throw new Error('Every CSV row must have the same number of fields as the header.');
    const fields = Object.fromEntries(headers.map((key, index) => [key, values[index].trim()]));
    const number = (key: string) => fields[key] ? Number(fields[key]) : NaN;
    const team = teams.get(fields.teamId) ?? {
      id: fields.teamId, city: fields.city, name: fields.teamName, abbreviation: fields.abbreviation,
      color: fields.color, accent: fields.accent, conference: fields.conference as Team['conference'], roster: [],
    };
    if (team.name !== fields.teamName || team.conference !== fields.conference) throw new Error('Conflicting metadata for team ' + team.id);
    const player: Player = {
      id: fields.playerId, name: fields.playerName, number: number('number'), position: fields.position as Position,
      height: number('height'), weight: fields.weight ? number('weight') : undefined, wingspan: fields.wingspan ? number('wingspan') : undefined, age: number('age'), overall: number('overall'), potential: number('potential'),
      salary: fields.salary ? number('salary') : undefined, years: fields.years ? number('years') : undefined,
      ratings: { ...Object.fromEntries(ratingKeys.map(key => [key, number(key)])), ...(fields.strength ? { strength: number('strength') } : {}) } as Ratings,
    };
    team.roster.push(player);
    teams.set(team.id, team);
  }
  return validateRoster({ source, updatedAt, teams: [...teams.values()] });
}
