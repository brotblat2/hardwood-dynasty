import type { Position, Ratings } from '../contracts/index.ts';

/** Regular-season totals, one combined row per player and season. Season is the ending year. */
export interface SeasonLine {
  season: number; games: number; minutes: number; points: number; fgm: number; fga: number;
  threeMade: number; threeAttempted: number; ftm: number; fta: number; rebounds: number;
  assists: number; steals: number; blocks: number; turnovers: number;
  bpm?: number; dbpm?: number; possibleGames?: number; ts?: number; usg?: number;
  offRebounds?: number; defRebounds?: number; source?: string;
}

export type GradeRow = { label: string; value: number; detail: string };
export type NbaGrade = {
  overall: number; potential: number; ratings: Ratings; evidence: 'established' | 'limited' | 'estimated';
  seasons: number[]; minutes: number; breakdown: GradeRow[];
};

const keys = ['shooting','finishing','passing','handling','rebounding','speed','perimeter','interior','iq','durability'] as const;
const priors: Record<Position, number[]> = {
  PG: [70,60,73,76,40,77,63,37,62,69], SG: [71,62,60,68,45,74,65,41,62,69],
  SF: [66,65,57,61,55,69,65,53,62,69], PF: [59,70,54,54,66,61,57,66,62,69],
  C: [44,73,51,46,74,55,47,73,62,69],
};
const counts = ['games','minutes','points','fgm','fga','threeMade','threeAttempted','ftm','fta',
  'rebounds','assists','steals','blocks','turnovers'] as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const grade = (n: number) => Math.round(clamp(n, 25, 99));
const smooth = (total: number, volume: number, prior: number, pseudo: number) => (total + prior * pseudo) / (volume + pseudo);
const one = (n: number) => n.toFixed(1);
const pct = (n: number) => one(n * 100) + '%';

function usable(s: SeasonLine) {
  return Number.isInteger(s.season) && counts.every(key => Number.isFinite(s[key]) && s[key] >= 0)
    && s.games > 0 && s.minutes > 0 && s.threeMade <= s.threeAttempted && s.threeAttempted <= s.fga
    && s.fgm >= s.threeMade && s.fgm - s.threeMade <= s.fga - s.threeAttempted && s.ftm <= s.fta;
}

/** Game-scale anchors. BPM = 0 approximates an average NBA rotation player. */
function impactGrade(impact: number) {
  const anchors = [[-7,55],[-4,65],[-2,72],[0,78],[2,84],[4,89],[6,93],[9,97],[13,99]];
  for (let i = 1; i < anchors.length; i++) {
    const [x,y] = anchors[i], [px,py] = anchors[i-1];
    if (impact <= x) return clamp(py + (impact-px) * (y-py) / (x-px), 50, 99);
  }
  return 99;
}

/** Ratings describe observed output, with explicit box-score proxies for untracked abilities.
 * Up to three seasons contribute at 1, .62 and .38 times their actual opportunities.
 * Overall uses impact and role, independently of position, body size or the arithmetic mean of skills.
 * Potential is a speculative age-based ceiling, not a forecast from a trained model.
 */
export function gradeNbaPlayer(position: Position, seasons: readonly SeasonLine[], age?: number): NbaGrade {
  const valid = seasons.filter(usable).sort((a,b) => b.season-a.season);
  const latest = valid[0]?.season ?? 0;
  const rows = valid.filter(s => latest - s.season <= 2);
  const weight = (s: SeasonLine) => .62 ** (latest - s.season);
  const sum = (k: typeof counts[number]) => rows.reduce((n,s) => n + s[k]*weight(s), 0);
  const min = sum('minutes'), games = sum('games');
  const certainty = min / (min+260);
  const rate = (k: typeof counts[number]) => min ? sum(k)*36/min : 0;
  const mpg = games ? min/games : 0;
  const threeA = sum('threeAttempted'), twoA = sum('fga')-threeA, ftA = sum('fta');
  const three = smooth(sum('threeMade'), threeA, .36, 100);
  const two = smooth(sum('fgm')-sum('threeMade'), twoA, .54, 100);
  const ft = smooth(sum('ftm'), ftA, .78, 65);
  const ts = smooth(sum('points')/2, sum('fga')+.44*ftA, .576, 100);
  const pts = rate('points'), ast = rate('assists'), tov = rate('turnovers'), reb = rate('rebounds');
  const stl = rate('steals'), blk = rate('blocks'), ft36 = rate('fta'), three36 = rate('threeAttempted');
  const astTo = smooth(sum('assists'), sum('turnovers'), 1.6, 35);
  const possessions = rate('fga')+.44*ft36+tov;
  const turnoverShare = smooth(sum('turnovers'),sum('fga')+.44*ftA+sum('assists')+sum('turnovers'),.10,80);
  function advanced(key: 'bpm'|'dbpm') {
    const measured = rows.filter(s => Number.isFinite(s[key]));
    const volume = measured.reduce((total,s) => total+s.minutes*weight(s),0);
    return { value: measured.reduce((total,s) => total+s[key]!*s.minutes*weight(s),0)/(volume || 1),
      coverage: volume/(min || 1) };
  }
  const bpm = advanced('bpm'), dbpm = advanced('dbpm');
  const defense = clamp(dbpm.value * dbpm.coverage, -3, 5);
  // Role and per-36 performance relative to contemporary league-average baselines.
  const boxImpact = .36*(pts-16) + 16*(ts-.576) + .52*(ast-3.8) + .24*(reb-6.5)
    + 1.05*(stl-1.2) + 1.05*(blk-.7) - .65*(tov-2.0) + .10*(mpg-24);
  const bpmShare = .65*bpm.coverage;
  const impact = (1-bpmShare)*boxImpact + bpmShare*bpm.value;
  const actualMinutes = rows.reduce((total, row) => total + row.minutes, 0);
  const overallConfidence = actualMinutes / (actualMinutes + 130);
  const overall = grade(64 + overallConfidence * (impactGrade(impact) - 64));
  const projection = age && Number.isFinite(age) ? clamp((29-age)*.95,0,10) : 0;
  const potential = grade(overall + projection);
  const prior = priors[position];
  const ratings = {} as Ratings;
  const breakdown: GradeRow[] = [];
  const add = (i: number, observed: number, detail: string) => {
    const key = keys[i];
    ratings[key] = grade(prior[i] + certainty*(clamp(observed,25,102)-prior[i]));
    breakdown.push({label: key[0].toUpperCase()+key.slice(1),value: ratings[key],
      detail: min ? detail : 'Position-based gameplay estimate. No usable regular-season sample.'});
  };
  const availabilityRows = rows.filter(s => s.possibleGames && s.possibleGames > 0);
  const opportunities = availabilityRows.reduce((a,s) => a + s.possibleGames!*weight(s),0);
  const availability = opportunities ? clamp(availabilityRows.reduce((a,s) => a+s.games*weight(s),0)/opportunities,0,1) : null;
  add(0, 46 + 3.6*Math.min(three36,10) + 145*(three-.30) + 39*(ft-.70),
    pct(three)+' adjusted 3P on '+one(three36)+' attempts/36, '+pct(ft)+' adjusted FT. Accuracy shrinks by 100 three-point and 65 free-throw attempts.');
  add(1, 70 + 105*(two-.50) + 2.6*(ft36-3) + .52*(rate('fga')-three36-7),
    pct(two)+' adjusted 2P, '+one(ft36)+' FTA/36. Two-point shots include midrange and use a 100-attempt prior.');
  add(2, 47 + 4.35*ast + 4.4*clamp(astTo,0,4),
    one(ast)+' AST/36 and '+one(astTo)+' adjusted assists per turnover.');
  add(3, 52 + 1.12*possessions + 1.65*ast + 72*(.11-turnoverShare),
    one(possessions)+' shooting/turnover possessions per 36 and '+pct(turnoverShare)+' turnovers per involved possession. Creation proxy.');
  add(4, 38 + 4.75*reb, one(reb)+' rebounds per 36 minutes.');
  add(5, prior[5] + 3.7*(stl-1) + .65*(possessions-16),
    'Movement proxy from position, possession load and steals. No tracking speed measurement.');
  add(6, prior[6] + 6 + 12*(stl-1) + 2.8*defense, one(stl)+' STL/36. Position and available defensive BPM inform this coverage proxy.');
  add(7, prior[7] + 4 + 8*(blk-.6) + 1.3*(reb-5) + 2.8*defense, one(blk)+' BLK/36 and '+one(reb)+' REB/36. Interior defense proxy.');
  add(8, 68 + 1.4*(ast-3) + 55*(ts-.576) + 3*clamp(astTo-1.6,-1.6,3) + 95*(.11-turnoverShare) + .32*(mpg-23),
    'Decision-making proxy from assists, turnover share, scoring efficiency and rotation minutes.');
  add(9, availability === null ? prior[9] : 50 + 47*availability, availability === null
    ? 'Games available unknown. Neutral availability estimate.' : pct(availability)+' of observed team games played. Availability proxy, including absences for any reason.');
  breakdown.unshift({label:'Overall',value:overall,detail: min
    ? 'Per-36 scoring, true shooting, creation, defense and minutes: '+one(boxImpact)+' box impact. '+(bpm.coverage ? one(bpm.value)+' BPM at '+pct(bpmShare)+' weight. ' : '')+pct(overallConfidence)+' overall-grade confidence.'
    : 'Neutral developmental baseline. No usable regular-season sample.'});
  breakdown.push({label:'Potential',value:potential,detail:'Speculative age-based projection from current overall, capped at 99.'});
  return { overall, potential, ratings, seasons: rows.map(s=>s.season), minutes: Math.round(rows.reduce((m,s)=>m+s.minutes,0)),
    evidence: min === 0 ? 'estimated' : min < 700 ? 'limited' : 'established', breakdown };
}
