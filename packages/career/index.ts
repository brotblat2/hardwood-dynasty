import type { Player, PlayerAppearance, Position, Ratings, Team } from '../contracts/index.ts';
import { estimateStrength } from '../roster-data/body.ts';

export type Archetype = 'Sharpshooter' | 'Slasher' | 'Playmaker' | 'Anchor' | 'Two-way wing' | 'Stretch big' | 'Post scorer' | 'Three-level scorer';
export type CareerPath = 'College' | 'International';
export type Interview = 'Team' | 'Ambition' | 'Craft';
export type CareerGame = {
  points: number; assists: number; rebounds: number; steals?: number; blocks?: number;
  turnovers?: number; won: boolean;
};
export type Career = {
  version: 1; player: Player; stage: 'showcase' | 'combine' | 'draft' | 'rookie' | 'season';
  archetype: Archetype; path: CareerPath; seed: number; teamId: string | null; draftPick: number | null;
  xp: number; trust: number; chemistry: number; games: number; season: number;
  draftStock: number; showcase: CareerGame | null; lastGame: CareerGame | null;
  combine: { performance: number; interview: Interview } | null;
  totals: { points: number; assists: number; rebounds: number; wins: number };
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const overall = (r: Ratings) => Math.round(Object.entries(r).filter(([key]) => key !== 'strength').reduce((s,[,v]) => s + v, 0) / 10);
const boosts: Record<Archetype, Partial<Ratings>> = {
  Sharpshooter: { shooting: 18, iq: 4, finishing: -4, interior: -5 },
  Slasher: { finishing: 16, speed: 7, handling: 4, shooting: -6 },
  Playmaker: { passing: 17, handling: 10, iq: 6, rebounding: -5 },
  Anchor: { interior: 17, rebounding: 13, speed: -6, handling: -7 },
  'Two-way wing': { perimeter: 15, finishing: 8, interior: 6, shooting: -3 },
  'Stretch big': { shooting: 17, rebounding: 9, finishing: -4, speed: -7 },
  'Post scorer': { finishing: 16, interior: 8, rebounding: 5, perimeter: -5 },
  'Three-level scorer': { shooting: 11, finishing: 12, handling: 5, passing: -3 }
};
export function createCareer(input: { name: string; position: Position; height: number; weight?: number; wingspan?: number; appearance?: PlayerAppearance; archetype: Archetype; path: CareerPath; seed?: number }): Career {
  const seed = input.seed ?? 1;
  const height = clamp(input.height, 1.68, 2.24);
  const weight = clamp(input.weight ?? (88 + (height - 1.9) * 65), 60, 145);
  const wingspan = typeof input.wingspan === 'number' && Number.isFinite(input.wingspan) ? clamp(input.wingspan, 1.55, 2.5) : undefined;
  const size = Math.round((height - 1.95) * 25);
  const role = ['PG','SG','SF','PF','C'].indexOf(input.position) - 2;
  const ratings: Ratings = {
    shooting: 66 - role * 2, finishing: 65 + role, passing: 66 - role * 3, handling: 66 - role * 3 - size,
    rebounding: 63 + role * 3 + size, speed: 70 - role * 2 - size - Math.round((weight - 87) * 0.10), perimeter: 65 - role * 2,
    interior: 63 + role * 3 + size, iq: 66, durability: 72, strength: estimateStrength(height, weight)
  };
  for (const [key,value] of Object.entries(boosts[input.archetype])) ratings[key as keyof Ratings] = (ratings[key as keyof Ratings] ?? 65) + value;
  if (input.path === 'International') ratings.passing += 3;
  else ratings.perimeter += 3;
  const player: Player = { id: 'career-' + (seed >>> 0), name: input.name.trim() || 'Jordan Ellis', number: 12,
    position: input.position, height, weight,
    ...(wingspan !== undefined ? { wingspan } : {}),
    ...(input.appearance ? { appearance: input.appearance } : {}),
    age: input.path === 'College' ? 20 : 19, overall: overall(ratings), potential: 92, ratings };
  return { version: 1, player, archetype: input.archetype, path: input.path, seed, stage: 'showcase',
    teamId: null, draftPick: null, xp: 0, trust: 35, chemistry: 40, games: 0, season: 1, draftStock: 36,
    showcase: null, lastGame: null, combine: null, totals: { points: 0, assists: 0, rebounds: 0, wins: 0 } };
}

export function recordCareerGame(c: Career, result: CareerGame): Career {
  if (!['showcase','rookie','season'].includes(c.stage)) return c;
  const count = (n: number | undefined) => Math.round(clamp(n ?? 0, 0, 200));
  const stats = { points: count(result.points), assists: count(result.assists), rebounds: count(result.rebounds),
    steals: count(result.steals), blocks: count(result.blocks), turnovers: count(result.turnovers), won: !!result.won };
  const impact = stats.points + stats.assists * 2 + stats.rebounds + (stats.steals + stats.blocks) * 2 - stats.turnovers * 2;
  const trust = clamp(c.trust + Math.round(impact / 8) + (stats.won ? 3 : -1), 0, 100);
  const chemistry = clamp(c.chemistry + Math.min(5,stats.assists) + Number(stats.won) - Math.min(4,stats.turnovers), 0, 100);
  const xp = c.xp + Math.round(clamp(20 + impact * 3 + Number(stats.won) * 18, 10, 300));
  if (c.stage === 'showcase') return { ...c, stage: 'combine', showcase: stats, lastGame: stats, trust, chemistry, xp,
    draftStock: clamp(c.draftStock + impact * 0.9 + Number(stats.won) * 4, 15, 95) };
  const games = c.games + 1;
  return { ...c, stage: 'season', trust, chemistry, xp, games, season: 1 + Math.floor(games / 82), lastGame: stats,
    totals: { points: c.totals.points + stats.points, assists: c.totals.assists + stats.assists,
      rebounds: c.totals.rebounds + stats.rebounds, wins: c.totals.wins + Number(stats.won) } };
}

export function completeCombine(c: Career, performance: number, interview: Interview): Career {
  if (c.stage !== 'combine') return c;
  const grade = Math.round(clamp(performance, 0, 100));
  return { ...c, stage: 'draft', combine: { performance: grade, interview },
    draftStock: clamp(c.draftStock * 0.65 + grade * 0.35 + (interview === 'Ambition' ? 4 : 0), 1, 100),
    chemistry: clamp(c.chemistry + (interview === 'Team' ? 6 : 1), 0, 100),
    xp: c.xp + (interview === 'Craft' ? 30 : 12) };
}

export function draftPlayer(c: Career, teams: Team[]): Career {
  if (c.stage !== 'draft' || teams.length === 0) return c;
  const pick = Math.round(clamp(60 - c.draftStock * 0.60, 1, 60));
  const start = ((c.seed >>> 0) + pick - 1) % teams.length;
  const choices = Array.from({length: Math.min(3, teams.length)}, (_,i) => teams[(start + i) % teams.length]);
  const depth = (t: Team) => t.roster.filter(p => p.position === c.player.position).reduce((sum,p) => sum + p.overall, 0);
  const team = choices.reduce((best,t) => depth(t) < depth(best) ? t : best);
  return { ...c, stage: 'rookie', draftPick: pick, teamId: team.id, player: { ...c.player, years: 2, salary: Math.round(1250000 + (60 - pick) * 95000) } };
}

export const trainingCost = (c: Career, rating: keyof Ratings) => Math.max(25, Math.round(((c.player.ratings[rating] ?? 65) - 40) * 1.5));

export function trainPlayer(c: Career, rating: keyof Ratings): Career {
  const cost = trainingCost(c, rating);
  const value = c.player.ratings[rating] ?? 65;
  if (c.xp < cost || value >= 99) return c;
  const ratings = { ...c.player.ratings, [rating]: value + 1 };
  return { ...c, xp: c.xp - cost, player: { ...c.player, ratings, overall: overall(ratings) } };
}

/** Start the created player in their position while retaining the team's full roster. */
export function careerLineup(c: Career, team: Team): Team {
  const roster = [...team.roster];
  const existing = roster.findIndex(p => p.id === c.player.id);
  if (existing >= 0 && existing < 5) {
    roster[existing] = c.player;
    return { ...team, roster };
  }
  if (existing >= 0) roster.splice(existing, 1);
  const starter = roster.findIndex((p, i) => i < 5 && p.position === c.player.position);
  roster.splice(starter < 0 ? 0 : starter, 0, c.player);
  if (starter >= 0 && roster.length > 5) {
    const displaced = roster.splice(starter + 1, 1)[0];
    roster.push(displaced);
  }
  return { ...team, roster };
}
