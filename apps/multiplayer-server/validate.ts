import type { Control, GameConfig, RoomConfig, Team } from '../../packages/contracts/index.ts';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v: unknown, max = 80): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const id = (v: unknown): v is string => str(v) && /^[a-z0-9_-]+$/i.test(v) && !(v in Object.prototype);
const ratings = ['shooting', 'finishing', 'passing', 'handling', 'rebounding', 'speed', 'perimeter', 'interior', 'iq', 'durability'];
function team(v: unknown): v is Team {
  if (!record(v) || !id(v.id) || ![v.name, v.city, v.abbreviation].every(s => str(s)) || ![v.color, v.accent].every(c => typeof c === 'string' && /^#[a-f0-9]{6}$/i.test(c)) || !['East','West'].includes(String(v.conference))) return false;
  if (!Array.isArray(v.roster) || v.roster.length < 1 || v.roster.length > 30) return false;
  return v.roster.every(p => record(p) && id(p.id) && str(p.name) && ['PG','SG','SF','PF','C'].includes(String(p.position)) &&
    num(p.number, 0, 99) && num(p.height, 1, 3) && num(p.age, 15, 60) && num(p.overall, 0, 100) && num(p.potential, 0, 100) &&
    record(p.ratings) && ratings.every(k => num((p.ratings as Record<string, unknown>)[k], 0, 100)));
}
export function roomConfig(v: unknown): v is RoomConfig {
  if (!record(v) || !Array.isArray(v.teams) || v.teams.length !== 2 || !v.teams.every(team)) return false;
  const people = v.teams.flatMap(t => t.roster.map(p => p.id));
  if (new Set(people).size !== people.length) return false;
  const g = v.game ?? {};
  if (!record(g)) return false;
  const ranges: Partial<Record<keyof GameConfig, [number, number]>> = {
    playersPerTeam: [1, 5], periods: [1, 12], periodSeconds: [1, 3600], targetScore: [1, 300], seed: [-2147483648, 4294967295],
  };
  for (const [key, val] of Object.entries(g)) {
    const range = Object.hasOwn(ranges, key) ? ranges[key as keyof GameConfig] : undefined;
    if (range && (!num(val, ...range) || !Number.isInteger(val))) return false;
    if (key === 'difficulty' && !['Rookie','Pro','All-Star','Superstar','Hall of Fame','Legendary'].includes(String(val))) return false;
    if (key === 'mode' && !['regulation','blacktop','practice'].includes(String(val))) return false;
    if (['halfCourt','makeItTakeIt'].includes(key) && typeof val !== 'boolean') return false;
    if (key === 'kits' && (!Array.isArray(val) || val.length !== 2 || !val.every(k => ['home','away','statement','city'].includes(String(k))))) return false;
    if (!range && !['mode','difficulty','halfCourt','makeItTakeIt','kits'].includes(key)) return false;
  }
  return v.teams.every(t => t.roster.length >= Number(g.playersPerTeam ?? 5));
}
export function control(v: unknown): v is Control {
  if (!record(v) || !record(v.move) || !num(v.move.x,-1,1) || !num(v.move.z,-1,1)) return false;
  for (const [key, value] of Object.entries(v)) {
    if (key === 'move') continue;
    if (key === 'passType' && ['chest','bounce','lob'].includes(String(value))) continue;
    if (key === 'shotType' && ['jump','layup','dunk','floater','hook','fadeaway','stepBack','euro'].includes(String(value))) continue;
    if (key === 'offensePlay' && ['motion','pickAndRoll','iso','fiveOut'].includes(String(value))) continue;
    if (key === 'defenseScheme' && ['man','zone23','switch','press'].includes(String(value))) continue;
    if (key === 'targetId' && id(value)) continue;
    if (key === 'dribbleDir' && record(value) && num(value.x, -1, 1) && num(value.z, -1, 1)) continue;
    if (['sprint','shoot','pass','contest','steal','screen','dribble','pumpFake','callScreen','callPass','intenseD','postUp'].includes(key) && typeof value === 'boolean') continue;
    return false;
  }
  return true;
}
