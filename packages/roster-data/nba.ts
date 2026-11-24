import type { Player, Position, Ratings, Team } from '../contracts/index.ts';
import { validateRoster, type RosterPack } from './index.ts';

const ESPN_TEAMS = [
  ['atl', 'East'], ['bos', 'East'], ['bkn', 'East'], ['cha', 'East'], ['chi', 'East'],
  ['cle', 'East'], ['det', 'East'], ['ind', 'East'], ['mia', 'East'], ['mil', 'East'],
  ['ny', 'East'], ['orl', 'East'], ['phi', 'East'], ['tor', 'East'], ['wsh', 'East'],
  ['dal', 'West'], ['den', 'West'], ['gs', 'West'], ['hou', 'West'], ['lac', 'West'],
  ['lal', 'West'], ['mem', 'West'], ['min', 'West'], ['no', 'West'], ['okc', 'West'],
  ['phx', 'West'], ['por', 'West'], ['sac', 'West'], ['sa', 'West'], ['utah', 'West'],
] as const;
const SOURCE = 'ESPN public NBA roster JSON (https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/roster)';

type EspnAthlete = {
  id: string;
  displayName?: string;
  jersey?: string;
  height?: number;
  age?: number;
  position?: { abbreviation?: string };
  experience?: { years?: number };
};
type EspnRoster = {
  timestamp: string;
  team: { abbreviation: string; location: string; name: string; color?: string };
  athletes: EspnAthlete[];
};
const omissions: string[] = [];

function playerPosition(value: string | undefined): Position {
  if (value === 'PG' || value === 'SG' || value === 'SF' || value === 'PF' || value === 'C') return value;
  if (value === 'G') return 'SG';
  if (value === 'F') return 'SF';
  return 'C';
}

function estimatedRatings(position: Position, index: number): Ratings {
  const positional: Record<Position, number[]> = {
    PG: [72, 68, 82, 82, 45, 76, 68, 40, 70, 70],
    SG: [76, 72, 68, 74, 48, 76, 74, 44, 68, 70],
    SF: [70, 74, 66, 68, 58, 70, 72, 58, 68, 70],
    PF: [58, 74, 58, 56, 72, 62, 58, 74, 68, 70],
    C: [44, 76, 54, 52, 80, 56, 44, 82, 68, 70],
  };
  const scale = index < 3 ? 1.12 : index < 8 ? 1 : 0.88;
  const [shooting, finishing, passing, handling, rebounding, speed, perimeter, interior, iq, durability] = positional[position].map(value => Math.max(25, Math.min(99, Math.round(50 + (value - 50) * scale))));
  return { shooting, finishing, passing, handling, rebounding, speed, perimeter, interior, iq, durability };
}

function convertRoster(roster: EspnRoster, conference: Team['conference']): Team {
  const color = roster.team.color && /^[0-9a-f]{6}$/i.test(roster.team.color) ? `#${roster.team.color}` : '#17408b';
  const players: Player[] = roster.athletes.filter(athlete => typeof athlete.height === 'number' && typeof athlete.age === 'number').map((athlete, index) => {
    const position = playerPosition(athlete.position?.abbreviation);
    const overall = Math.round(Object.values(estimatedRatings(position, index)).reduce((sum, rating) => sum + rating, 0) / 10);
    return {
      id: `${roster.team.abbreviation.toLowerCase()}-${athlete.id}`,
      name: athlete.displayName ?? `Player ${athlete.id}`,
      number: Number.isFinite(Number(athlete.jersey)) ? Math.max(0, Math.min(99, Number(athlete.jersey))) : 0,
      position,
      height: athlete.height! * 0.0254,
      age: athlete.age!,
      overall,
      potential: overall,
      ratings: estimatedRatings(position, index),
      years: typeof athlete.experience?.years === 'number' ? Math.min(15, athlete.experience.years) : undefined,
    };
  });
  return {
    id: roster.team.abbreviation.toLowerCase(), city: roster.team.location, name: roster.team.name,
    abbreviation: roster.team.abbreviation, color, accent: '#f5f5f5', conference, roster: players,
  };
}

/** Fetches current public ESPN roster data. Player bio gaps are left absent. Ratings are positional gameplay estimates. */
export async function loadNbaRosters(): Promise<RosterPack> {
  const fetched = await Promise.all(ESPN_TEAMS.map(async ([id, conference]) => {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/roster`);
    if (!response.ok) throw new Error(`ESPN roster request for ${id} failed with HTTP ${response.status}.`);
    return { data: await response.json() as EspnRoster, conference };
  }));
  omissions.length = 0;
  for (const { data } of fetched) {
    for (const athlete of data.athletes) {
      const missing = [typeof athlete.height === 'number' ? '' : 'height', typeof athlete.age === 'number' ? '' : 'age'].filter(Boolean);
      if (missing.length) omissions.push(`${data.team.abbreviation} ${athlete.displayName ?? athlete.id}: missing ${missing.join(', ')}`);
    }
  }
  const teams = fetched.map(({ data, conference }) => convertRoster(data, conference));
  const updatedAt = fetched.map(({ data }) => Date.parse(data.timestamp)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return { ...validateRoster({ version: 1, source: SOURCE, updatedAt: new Date(updatedAt ?? Date.now()).toISOString(), teams }), omissions: [...omissions] };
}
