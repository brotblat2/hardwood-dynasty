import type {
  FacialHair, Hairstyle, JerseyPattern, PlayerAppearance, Position, SleeveSide,
} from '../contracts/index.ts';

export const SKIN_TONES = [
  '#4a2c20', // 0 Deep espresso
  '#633a28', // 1 Rich dark brown
  '#7d4d36', // 2 Deep bronze
  '#9b6647', // 3 Warm chestnut
  '#b98462', // 4 Medium tan / olive
  '#d1a17f', // 5 Warm golden light
  '#e2b99b', // 6 Fair peach
  '#edd0b8', // 7 Very fair
] as const;

export const HAIR_TONES = [
  '#171413', // 0 Jet black
  '#2b211b', // 1 Dark brown
  '#4d3625', // 2 Chestnut
  '#8c6d46', // 3 Sandy brown
  '#bfa068', // 4 Blonde
  '#8f4424', // 5 Ginger / auburn
  '#5d5a58', // 6 Salt & pepper
] as const;

export type TeamBranding = {
  primary: string;
  accent: string;
  tertiary: string;
  pattern: JerseyPattern;
  wordmark: string;
  cityColors: [string, string, string];
  parquet?: boolean;
};

export const NBA_TEAM_BRANDING: Record<string, TeamBranding> = {
  ATL: { primary: '#c8102e', accent: '#fdb927', tertiary: '#26282a', pattern: 'sidePanel', wordmark: 'HAWKS', cityColors: ['#18181a', '#fdb927', '#e03a3e'] },
  BOS: { primary: '#008348', accent: '#ba9653', tertiary: '#0e2219', pattern: 'classic', wordmark: 'CELTICS', cityColors: ['#f4efe2', '#007a33', '#ba9653'], parquet: true },
  BKN: { primary: '#121214', accent: '#ffffff', tertiary: '#595d62', pattern: 'herringbone', wordmark: 'BROOKLYN', cityColors: ['#19191d', '#7ee8fa', '#ff4d9e'] },
  CHA: { primary: '#00788c', accent: '#1d1160', tertiary: '#a1a1a4', pattern: 'pinstripe', wordmark: 'HORNETS', cityColors: ['#13292d', '#d6b36a', '#00a3ba'] },
  CHI: { primary: '#ce1141', accent: '#111111', tertiary: '#ffffff', pattern: 'pinstripe', wordmark: 'BULLS', cityColors: ['#141416', '#f2e8cf', '#ce1141'] },
  CLE: { primary: '#860038', accent: '#fdbb30', tertiary: '#041e42', pattern: 'sash', wordmark: 'CAVS', cityColors: ['#121622', '#fdbb30', '#860038'] },
  DET: { primary: '#1d428a', accent: '#c8102e', tertiary: '#bec0c2', pattern: 'sidePanel', wordmark: 'PISTONS', cityColors: ['#101829', '#c8102e', '#dfe3ea'] },
  IND: { primary: '#002d62', accent: '#fdbb30', tertiary: '#bec0c2', pattern: 'pinstripe', wordmark: 'PACERS', cityColors: ['#0d1e38', '#fdbb30', '#48a4d4'] },
  MIA: { primary: '#98002e', accent: '#f9a01b', tertiary: '#111111', pattern: 'sidePanel', wordmark: 'HEAT', cityColors: ['#111115', '#42e0f5', '#ff4fa3'] },
  MIL: { primary: '#00471b', accent: '#eee1c6', tertiary: '#0077c0', pattern: 'hoopBand', wordmark: 'BUCKS', cityColors: ['#0e2418', '#5ec2ff', '#eee1c6'] },
  NY:  { primary: '#006bb6', accent: '#f58426', tertiary: '#bec0c2', pattern: 'sidePanel', wordmark: 'NEW YORK', cityColors: ['#141824', '#f58426', '#469be8'] },
  ORL: { primary: '#0077c0', accent: '#c4ced4', tertiary: '#111111', pattern: 'pinstripe', wordmark: 'MAGIC', cityColors: ['#11131a', '#ff7b29', '#c4ced4'] },
  PHI: { primary: '#006bb6', accent: '#ed174c', tertiary: '#002b5c', pattern: 'chevron', wordmark: 'SIXERS', cityColors: ['#f4efe4', '#006bb6', '#ed174c'] },
  TOR: { primary: '#ce1141', accent: '#111111', tertiary: '#b4975a', pattern: 'chevron', wordmark: 'RAPTORS', cityColors: ['#111113', '#d4af37', '#ce1141'] },
  WSH: { primary: '#002b5c', accent: '#e31837', tertiary: '#c4ced4', pattern: 'hoopBand', wordmark: 'WIZARDS', cityColors: ['#1d2432', '#64b8d6', '#e31837'] },
  DAL: { primary: '#00538c', accent: '#b8c4ca', tertiary: '#002b5e', pattern: 'sidePanel', wordmark: 'MAVS', cityColors: ['#141a24', '#d4b468', '#00538c'] },
  DEN: { primary: '#0e2240', accent: '#fec524', tertiary: '#8b2131', pattern: 'hoopBand', wordmark: 'NUGGETS', cityColors: ['#161218', '#fec524', '#e04f3a'] },
  GS:  { primary: '#1d428a', accent: '#ffc72c', tertiary: '#26282a', pattern: 'sunburst', wordmark: 'WARRIORS', cityColors: ['#131722', '#ffc72c', '#3d7be6'] },
  HOU: { primary: '#ce1141', accent: '#111111', tertiary: '#c4ced4', pattern: 'sidePanel', wordmark: 'ROCKETS', cityColors: ['#141820', '#5eb6f2', '#ce1141'] },
  LAC: { primary: '#12173f', accent: '#c8102e', tertiary: '#1d428a', pattern: 'sash', wordmark: 'CLIPPERS', cityColors: ['#18212b', '#e87835', '#76b9e0'] },
  LAL: { primary: '#552583', accent: '#fdb927', tertiary: '#111111', pattern: 'sidePanel', wordmark: 'LAKERS', cityColors: ['#161221', '#fdb927', '#9c6ade'] },
  MEM: { primary: '#5d76a9', accent: '#12173f', tertiary: '#f5b112', pattern: 'herringbone', wordmark: 'GRIZZLIES', cityColors: ['#131722', '#5ee0e8', '#f5b112'] },
  MIN: { primary: '#0c2340', accent: '#78be20', tertiary: '#236192', pattern: 'hoopBand', wordmark: 'WOLVES', cityColors: ['#f4f7f9', '#0c2340', '#48a8de'] },
  NO:  { primary: '#0c2340', accent: '#c8102e', tertiary: '#85714d', pattern: 'sidePanel', wordmark: 'PELICANS', cityColors: ['#14121c', '#7bf564', '#9e5ef2'] },
  OKC: { primary: '#007ac1', accent: '#ef3b24', tertiary: '#fdbb30', pattern: 'sash', wordmark: 'THUNDER', cityColors: ['#141a24', '#fdbb30', '#007ac1'] },
  PHX: { primary: '#1d1160', accent: '#e56020', tertiary: '#f9ad1b', pattern: 'sunburst', wordmark: 'SUNS', cityColors: ['#241338', '#f9ad1b', '#e56020'] },
  POR: { primary: '#e03a3e', accent: '#111111', tertiary: '#ffffff', pattern: 'sash', wordmark: 'BLAZERS', cityColors: ['#121214', '#e03a3e', '#d6c39c'] },
  SAC: { primary: '#5a2d81', accent: '#63727a', tertiary: '#111111', pattern: 'sidePanel', wordmark: 'KINGS', cityColors: ['#15141c', '#73a9f5', '#9c6ade'] },
  SA:  { primary: '#111113', accent: '#c4ced4', tertiary: '#00b2a9', pattern: 'sash', wordmark: 'SPURS', cityColors: ['#121417', '#ff549f', '#00c4bd'] },
  UTAH:{ primary: '#4e008e', accent: '#72c7e7', tertiary: '#002b5c', pattern: 'chevron', wordmark: 'JAZZ', cityColors: ['#241122', '#ff8c2e', '#f5c23b'] },
};

const ABBR_ALIASES: Record<string, string> = {
  NYK: 'NY', WAS: 'WSH', GSW: 'GS', NOP: 'NO', SAS: 'SA', UTA: 'UTAH', BRK: 'BKN', PHO: 'PHX',
};

export function lookupTeamBranding(abbr: string, fallbackColor = '#17408b'): TeamBranding {
  const key = ABBR_ALIASES[abbr.toUpperCase()] ?? abbr.toUpperCase();
  const brand = NBA_TEAM_BRANDING[key];
  if (brand) return brand;
  return {
    primary: fallbackColor,
    accent: '#efeadf',
    tertiary: '#181a1c',
    pattern: 'sidePanel',
    wordmark: abbr.toUpperCase(),
    cityColors: ['#14161a', fallbackColor, '#efeadf'],
  };
}

export type CuratedLikeness = {
  skin: number; // index into SKIN_TONES
  hair: Hairstyle;
  hairTone?: number; // index into HAIR_TONES
  facial?: FacialHair;
  headband?: boolean;
  armSleeve?: SleeveSide;
  legSleeve?: SleeveSide;
  wingspan?: number; // meters
  shoeColor?: string;
};

const normalizeName = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');

export const NBA_PLAYER_LIKENESS: Record<string, CuratedLikeness> = {
  // Superstars & marquee international/diverse players across all 30 clubs
  victorwembanyama: { skin: 2, hair: 'fade', hairTone: 0, facial: 'none', wingspan: 2.44 },
  nikolajokic: { skin: 6, hair: 'buzz', hairTone: 2, facial: 'stubble', wingspan: 2.21 },
  lukadoncic: { skin: 6, hair: 'taper', hairTone: 2, facial: 'stubble', headband: false, armSleeve: 'right', wingspan: 2.13 },
  giannisantetokounmpo: { skin: 1, hair: 'fade', hairTone: 0, facial: 'goatee', wingspan: 2.21 },
  shaigilgeousalexander: { skin: 3, hair: 'braids', hairTone: 0, facial: 'goatee', legSleeve: 'both', wingspan: 2.12 },
  stephencurry: { skin: 4, hair: 'fade', hairTone: 1, facial: 'goatee', armSleeve: 'right', legSleeve: 'both', wingspan: 1.92 },
  lebronjames: { skin: 2, hair: 'buzz', hairTone: 0, facial: 'fullBeard', armSleeve: 'left', legSleeve: 'left', wingspan: 2.14 },
  kevindurant: { skin: 1, hair: 'buzz', hairTone: 0, facial: 'beard', wingspan: 2.26 },
  jaysontatum: { skin: 3, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'right', wingspan: 2.11 },
  jaylenbrown: { skin: 2, hair: 'taper', hairTone: 0, facial: 'fullBeard', legSleeve: 'left', wingspan: 2.14 },
  joelembiid: { skin: 1, hair: 'fade', hairTone: 0, facial: 'fullBeard', wingspan: 2.28 },
  anthonyedwards: { skin: 2, hair: 'taper', hairTone: 0, facial: 'goatee', armSleeve: 'left', wingspan: 2.06 },
  devinbooker: { skin: 4, hair: 'taper', hairTone: 1, facial: 'stubble', legSleeve: 'right', wingspan: 2.04 },
  jamesharden: { skin: 2, hair: 'braids', hairTone: 0, facial: 'fullBeard', armSleeve: 'left', wingspan: 2.10 },
  kawhileonard: { skin: 2, hair: 'braids', hairTone: 0, facial: 'goatee', wingspan: 2.21 },
  anthonydavis: { skin: 2, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'both', wingspan: 2.27 },
  kyrieirving: { skin: 3, hair: 'afro', hairTone: 0, facial: 'fullBeard', armSleeve: 'right', wingspan: 1.93 },
  jimmybutleriii: { skin: 2, hair: 'locs', hairTone: 0, facial: 'goatee', headband: true, wingspan: 2.03 },
  bamadebayo: { skin: 1, hair: 'taper', hairTone: 0, facial: 'beard', armSleeve: 'right', wingspan: 2.20 },
  donovanmitchell: { skin: 2, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'left', wingspan: 2.08 },
  jalenbrunson: { skin: 3, hair: 'braids', hairTone: 0, facial: 'beard', wingspan: 1.93 },
  karlanthonytowns: { skin: 3, hair: 'fade', hairTone: 0, facial: 'beard', wingspan: 2.22 },
  paolobanchero: { skin: 4, hair: 'taper', hairTone: 1, facial: 'goatee', headband: false, wingspan: 2.15 },
  franzwagner: { skin: 7, hair: 'medium', hairTone: 2, facial: 'stubble', wingspan: 2.13 },
  moritzwagner: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 2.16 },
  tyresehaliburton: { skin: 3, hair: 'braids', hairTone: 0, facial: 'stubble', armSleeve: 'right', wingspan: 2.03 },
  pascalsiakam: { skin: 1, hair: 'locs', hairTone: 0, facial: 'beard', wingspan: 2.22 },
  tyresemaxey: { skin: 2, hair: 'braids', hairTone: 0, facial: 'none', wingspan: 2.03 },
  traeyoung: { skin: 4, hair: 'curls', hairTone: 1, facial: 'goatee', legSleeve: 'both', wingspan: 1.91 },
  deaaronfox: { skin: 2, hair: 'taper', hairTone: 0, facial: 'goatee', armSleeve: 'left', legSleeve: 'both', wingspan: 1.99 },
  domantassabonis: { skin: 6, hair: 'taper', hairTone: 2, facial: 'beard', wingspan: 2.11 },
  laurimarkkanen: { skin: 7, hair: 'medium', hairTone: 3, facial: 'stubble', wingspan: 2.14 },
  alperensengun: { skin: 5, hair: 'taper', hairTone: 1, facial: 'stubble', wingspan: 2.14 },
  deniavdija: { skin: 5, hair: 'curls', hairTone: 1, facial: 'beard', wingspan: 2.06 },
  ruihachimura: { skin: 3, hair: 'fade', hairTone: 0, facial: 'goatee', armSleeve: 'left', wingspan: 2.18 },
  yanghansen: { skin: 5, hair: 'taper', hairTone: 0, facial: 'none', wingspan: 2.24 },
  chetholmgren: { skin: 6, hair: 'taper', hairTone: 2, facial: 'beard', wingspan: 2.29 },
  jalenwilliams: { skin: 3, hair: 'locs', hairTone: 0, facial: 'goatee', armSleeve: 'right', wingspan: 2.18 },
  alexcaruso: { skin: 6, hair: 'shaved', hairTone: 1, facial: 'stubble', headband: true, wingspan: 1.97 },
  austinreaves: { skin: 7, hair: 'medium', hairTone: 2, facial: 'none', wingspan: 1.98 },
  dlo: { skin: 4, hair: 'braids', hairTone: 0, facial: 'goatee', legSleeve: 'both' },
  lameloball: { skin: 4, hair: 'curls', hairTone: 0, facial: 'none', legSleeve: 'both', wingspan: 2.08 },
  jamorant: { skin: 3, hair: 'locs', hairTone: 0, facial: 'goatee', armSleeve: 'right', wingspan: 2.01 },
  zionwilliamson: { skin: 2, hair: 'fade', hairTone: 0, facial: 'goatee', wingspan: 2.09 },
  cadecunningham: { skin: 2, hair: 'taper', hairTone: 0, facial: 'beard', armSleeve: 'left', wingspan: 2.13 },
  scottiebarnes: { skin: 2, hair: 'locs', hairTone: 0, facial: 'none', wingspan: 2.20 },
  evanmobley: { skin: 2, hair: 'taper', hairTone: 0, facial: 'goatee', wingspan: 2.24 },
  jarrettallen: { skin: 2, hair: 'afro', hairTone: 0, facial: 'beard', headband: true, wingspan: 2.27 },
  rudygobert: { skin: 3, hair: 'buzz', hairTone: 0, facial: 'beard', armSleeve: 'both', wingspan: 2.36 },
  kristapsporzingis: { skin: 7, hair: 'buzz', hairTone: 3, facial: 'stubble', wingspan: 2.29 },
  cooperflagg: { skin: 7, hair: 'medium', hairTone: 2, facial: 'none', wingspan: 2.13 },
  zachedey: { skin: 5, hair: 'taper', hairTone: 1, facial: 'none', wingspan: 2.39 },
  tackofall: { skin: 0, hair: 'buzz', hairTone: 0, facial: 'stubble', wingspan: 2.49 },
  stevenadams: { skin: 4, hair: 'long', hairTone: 1, facial: 'fullBeard', wingspan: 2.25 },
  klaythompson: { skin: 4, hair: 'taper', hairTone: 1, facial: 'beard', headband: true, legSleeve: 'both', wingspan: 2.06 },
  draymondgreen: { skin: 2, hair: 'buzz', hairTone: 0, facial: 'beard', wingspan: 2.17 },
  damianlillard: { skin: 2, hair: 'taper', hairTone: 0, facial: 'beard', legSleeve: 'both', wingspan: 2.03 },
  paulgeorge: { skin: 3, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'right', wingspan: 2.11 },
  paulreed: { skin: 1, hair: 'locs', hairTone: 0, facial: 'goatee' },
  derrickwhite: { skin: 4, hair: 'shaved', hairTone: 0, facial: 'beard', headband: true, wingspan: 2.02 },
  jrueholiday: { skin: 3, hair: 'locs', hairTone: 0, facial: 'beard', headband: true, wingspan: 2.01 },
  paytonpritchard: { skin: 6, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 1.91 },
  samhauser: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 2.03 },
  lukagarza: { skin: 6, hair: 'buzz', hairTone: 2, facial: 'stubble', wingspan: 2.17 },
  graysonallen: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.01 },
  coreykispert: { skin: 7, hair: 'medium', hairTone: 3, facial: 'none', wingspan: 2.01 },
  jocklandale: { skin: 7, hair: 'taper', hairTone: 2, facial: 'fullBeard', wingspan: 2.18 },
  kevinhuerter: { skin: 7, hair: 'taper', hairTone: 5, facial: 'stubble', wingspan: 2.02 },
  duncanrobinson: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 2.04 },
  tylerherro: { skin: 6, hair: 'taper', hairTone: 1, facial: 'stubble', wingspan: 1.91 },
  jaimejaquezjr: { skin: 5, hair: 'long', hairTone: 0, facial: 'beard', wingspan: 2.07 },
  josealvarado: { skin: 5, hair: 'braids', hairTone: 0, facial: 'goatee', headband: true },
  tjmcconnell: { skin: 6, hair: 'taper', hairTone: 2, facial: 'none' },
  joshgiddey: { skin: 6, hair: 'long', hairTone: 2, facial: 'none', wingspan: 2.03 },
  matasbuzelis: { skin: 6, hair: 'medium', hairTone: 2, facial: 'none', wingspan: 2.11 },
  daltonknecht: { skin: 6, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.06 },
  brandinpodziemski: { skin: 6, hair: 'curls', hairTone: 2, facial: 'none' },
  reedsheppard: { skin: 6, hair: 'taper', hairTone: 2, facial: 'stubble' },
  gradeydick: { skin: 7, hair: 'curls', hairTone: 3, facial: 'none', headband: false, wingspan: 2.05 },
  walkerkessler: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 2.24 },
  ivicazubac: { skin: 6, hair: 'buzz', hairTone: 1, facial: 'fullBeard', wingspan: 2.24 },
  jakobpoeltl: { skin: 7, hair: 'taper', hairTone: 2, facial: 'beard', wingspan: 2.20 },
  nikolavucevic: { skin: 6, hair: 'buzz', hairTone: 1, facial: 'beard', wingspan: 2.24 },
  jusufnurkic: { skin: 6, hair: 'buzz', hairTone: 1, facial: 'fullBeard', wingspan: 2.18 },
  bogdanbogdanovic: { skin: 6, hair: 'taper', hairTone: 1, facial: 'stubble', wingspan: 2.11 },
  nikolajovic: { skin: 6, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.14 },
  dontedivincenzo: { skin: 6, hair: 'taper', hairTone: 5, facial: 'fullBeard', wingspan: 1.98 },
  maxstrus: { skin: 6, hair: 'taper', hairTone: 2, facial: 'beard', armSleeve: 'left' },
  lukekennard: { skin: 7, hair: 'taper', hairTone: 2, facial: 'beard' },
  masonplumlee: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.11 },
  kylefilipowski: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.11 },
  donovanclingan: { skin: 6, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 2.31 },
  lukekornet: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble', wingspan: 2.18 },
  brooklopez: { skin: 5, hair: 'taper', hairTone: 1, facial: 'fullBeard', wingspan: 2.27 },
  alexsarr: { skin: 2, hair: 'locs', hairTone: 0, facial: 'none', wingspan: 2.25 },
  yvesmissi: { skin: 1, hair: 'fade', hairTone: 0, facial: 'none', wingspan: 2.26 },
  clintcapela: { skin: 1, hair: 'fade', hairTone: 0, facial: 'beard', wingspan: 2.25 },
  mitchellrobinson: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard', wingspan: 2.24 },
  mobamba: { skin: 0, hair: 'fade', hairTone: 0, facial: 'stubble', wingspan: 2.39 },
  isaiahhartenstein: { skin: 4, hair: 'curls', hairTone: 1, facial: 'beard', wingspan: 2.19 },
  aarongordon: { skin: 4, hair: 'braids', hairTone: 0, facial: 'beard', headband: true, wingspan: 2.13 },
  christianbraun: { skin: 6, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.00 },
  jamalmurray: { skin: 3, hair: 'taper', hairTone: 0, facial: 'beard', legSleeve: 'both', wingspan: 1.99 },
  michaelporterjr: { skin: 4, hair: 'curls', hairTone: 1, facial: 'stubble', legSleeve: 'right', wingspan: 2.14 },
  juliusrandle: { skin: 2, hair: 'fade', hairTone: 0, facial: 'fullBeard', wingspan: 2.13 },
  mikalbridges: { skin: 2, hair: 'fade', hairTone: 0, facial: 'goatee', armSleeve: 'right', wingspan: 2.16 },
  oganunoby: { skin: 1, hair: 'taper', hairTone: 0, facial: 'goatee', wingspan: 2.19 },
  joshhart: { skin: 3, hair: 'taper', hairTone: 0, facial: 'beard', legSleeve: 'both', headband: true },
  dariusgarland: { skin: 3, hair: 'braids', hairTone: 0, facial: 'none' },
  brandoningram: { skin: 2, hair: 'braids', hairTone: 0, facial: 'beard', wingspan: 2.21 },
  zachlavine: { skin: 4, hair: 'fade', hairTone: 0, facial: 'goatee', armSleeve: 'right', wingspan: 2.04 },
  demarderozan: { skin: 2, hair: 'braids', hairTone: 0, facial: 'beard', armSleeve: 'right', wingspan: 2.06 },
  devinbooker_: { skin: 4, hair: 'taper', hairTone: 1, facial: 'stubble' },
  bradleybeal: { skin: 3, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'left', wingspan: 2.03 },
  dejountemurray: { skin: 3, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'left', wingspan: 2.08 },
  fredvanvleet: { skin: 3, hair: 'fade', hairTone: 0, facial: 'fullBeard', armSleeve: 'right' },
  amenthompson: { skin: 3, hair: 'locs', hairTone: 0, facial: 'none', wingspan: 2.13 },
  ausarthompson: { skin: 3, hair: 'locs', hairTone: 0, facial: 'none', wingspan: 2.13 },
  jalengreen: { skin: 4, hair: 'locs', hairTone: 0, facial: 'stubble', armSleeve: 'right' },
  jalensuggs: { skin: 4, hair: 'taper', hairTone: 0, facial: 'beard', headband: true },
  desmondbane: { skin: 3, hair: 'fade', hairTone: 0, facial: 'goatee', wingspan: 1.93 },
  jarenjacksonjr: { skin: 2, hair: 'fade', hairTone: 0, facial: 'beard', wingspan: 2.27 },
  cobywhite: { skin: 2, hair: 'afro', hairTone: 0, facial: 'goatee', legSleeve: 'both' },
  normanpowell: { skin: 2, hair: 'fade', hairTone: 0, facial: 'beard', armSleeve: 'left', wingspan: 2.11 },
  luguentzdort: { skin: 1, hair: 'fade', hairTone: 0, facial: 'beard', wingspan: 2.05 },
  dysondaniels: { skin: 4, hair: 'curls', hairTone: 1, facial: 'none', wingspan: 2.10 },
  jalenjohnson: { skin: 3, hair: 'locs', hairTone: 0, facial: 'goatee', armSleeve: 'right', wingspan: 2.13 },
  onyekaokongwu: { skin: 1, hair: 'fade', hairTone: 0, facial: 'none', wingspan: 2.16 },
  cjmccollum: { skin: 3, hair: 'taper', hairTone: 0, facial: 'beard' },
  derecklivelyii: { skin: 3, hair: 'locs', hairTone: 0, facial: 'goatee', wingspan: 2.31 },
  danielgafford: { skin: 1, hair: 'taper', hairTone: 0, facial: 'beard', wingspan: 2.19 },
  pjashington: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard', armSleeve: 'right' },
  konknueppel: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 1.99 },
  ajdybantsa: { skin: 2, hair: 'braids', hairTone: 0, facial: 'none', wingspan: 2.14 },
  darrynpeterson: { skin: 3, hair: 'fade', hairTone: 0, facial: 'none', wingspan: 2.08 },
  cameronboozer: { skin: 4, hair: 'taper', hairTone: 1, facial: 'stubble', wingspan: 2.14 },
  benseraf: { skin: 6, hair: 'curls', hairTone: 2, facial: 'none' },
  bensaraf: { skin: 6, hair: 'curls', hairTone: 2, facial: 'none' },
  egordemin: { skin: 7, hair: 'medium', hairTone: 2, facial: 'none', wingspan: 2.09 },
  khamanmaluach: { skin: 0, hair: 'buzz', hairTone: 0, facial: 'none', wingspan: 2.30 },
  vladislavgoldin: { skin: 7, hair: 'taper', hairTone: 2, facial: 'beard', wingspan: 2.26 },
  kasparasjakucionis: { skin: 7, hair: 'medium', hairTone: 2, facial: 'none' },
  zachcollins: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none', wingspan: 2.16 },
  drewtimme: { skin: 7, hair: 'medium', hairTone: 2, facial: 'fullBeard' },
  alexkaraban: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none' },
  sammerrill: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none' },
  ajgreen: { skin: 6, hair: 'taper', hairTone: 2, facial: 'stubble' },
  camspencer: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble' },
  baylorscheierman: { skin: 7, hair: 'taper', hairTone: 2, facial: 'stubble' },
  bradensmith: { skin: 7, hair: 'taper', hairTone: 2, facial: 'none' },
  ryannembhard: { skin: 5, hair: 'taper', hairTone: 1, facial: 'none' },
  andrewnembhard: { skin: 5, hair: 'taper', hairTone: 1, facial: 'goatee' },
  jordanclarkson: { skin: 4, hair: 'braids', hairTone: 0, facial: 'beard', headband: true },
  jalengreen_: { skin: 4, hair: 'locs', hairTone: 0, facial: 'stubble' },
  myles_turner: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard', wingspan: 2.24 },
  mylesturner: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard', wingspan: 2.24 },
  kelelware: { skin: 2, hair: 'taper', hairTone: 0, facial: 'none', wingspan: 2.25 },
  andre_drummond: { skin: 2, hair: 'buzz', hairTone: 0, facial: 'fullBeard', wingspan: 2.29 },
  andredrummond: { skin: 2, hair: 'buzz', hairTone: 0, facial: 'fullBeard', wingspan: 2.29 },
  neemiasqueta: { skin: 1, hair: 'fade', hairTone: 0, facial: 'fullBeard', wingspan: 2.24 },
  kevonlooney: { skin: 1, hair: 'fade', hairTone: 0, facial: 'beard', wingspan: 2.22 },
  dejountemurray_: { skin: 3, hair: 'fade', hairTone: 0, facial: 'beard' },
  nazreid: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard', headband: true, wingspan: 2.21 },
  jonathankuminga: { skin: 0, hair: 'locs', hairTone: 0, facial: 'none', wingspan: 2.13 },
  dillonbrooks: { skin: 3, hair: 'braids', hairTone: 0, facial: 'beard', armSleeve: 'left' },
  scottiepippensr: { skin: 3, hair: 'fade', hairTone: 0, facial: 'goatee' },
  scottypippenjr: { skin: 4, hair: 'fade', hairTone: 0, facial: 'goatee' },
  bronnyjames: { skin: 3, hair: 'taper', hairTone: 0, facial: 'beard', legSleeve: 'both' },
  garypaytonii: { skin: 3, hair: 'fade', hairTone: 0, facial: 'stubble', headband: true },
  marcusmart: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard' },
  marcussmart: { skin: 2, hair: 'locs', hairTone: 0, facial: 'beard' },
  timhardawayjr: { skin: 3, hair: 'taper', hairTone: 0, facial: 'beard' },
  bobbyportis: { skin: 1, hair: 'fade', hairTone: 0, facial: 'beard', headband: true },
  kellyoubrejr: { skin: 4, hair: 'curls', hairTone: 0, facial: 'goatee', headband: true, legSleeve: 'both', wingspan: 2.19 },
  stevenadams_: { skin: 4, hair: 'long', hairTone: 1, facial: 'fullBeard' },
};

function hashId(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const FALLBACK_HAIR: readonly Hairstyle[] = ['fade', 'taper', 'buzz', 'curls', 'braids', 'locs', 'medium', 'shaved', 'afro', 'long'];
const FALLBACK_FACIAL: readonly FacialHair[] = ['none', 'stubble', 'goatee', 'beard', 'fullBeard'];

export function lookupNbaLikeness(
  name: string,
  position: Position,
  heightMeters: number,
  id: string,
): { appearance: PlayerAppearance; wingspan: number } {
  const key = normalizeName(name);
  const curated = NBA_PLAYER_LIKENESS[key];
  const h = hashId(key + ':' + id);

  if (curated) {
    const skinTone = SKIN_TONES[Math.max(0, Math.min(SKIN_TONES.length - 1, curated.skin))];
    const hairToneIdx = curated.hairTone ?? (curated.skin >= 6 ? 2 : curated.skin >= 5 ? 1 : 0);
    const hairTone = HAIR_TONES[Math.max(0, Math.min(HAIR_TONES.length - 1, hairToneIdx))];
    const defaultSpan = heightMeters * (position === 'C' || position === 'PF' ? 1.055 : 1.042);
    return {
      wingspan: curated.wingspan ?? Math.round(defaultSpan * 100) / 100,
      appearance: {
        skinTone,
        hairTone,
        hairstyle: curated.hair,
        facialHair: curated.facial ?? 'none',
        ...(curated.headband ? { headband: true } : {}),
        ...(curated.armSleeve && curated.armSleeve !== 'none' ? { armSleeve: curated.armSleeve } : {}),
        ...(curated.legSleeve && curated.legSleeve !== 'none' ? { legSleeve: curated.legSleeve } : {}),
        ...(curated.shoeColor ? { shoeColor: curated.shoeColor } : {}),
      },
    };
  }

  // Fallback across the full 8-tone spectrum and diverse natural hair/facial traits
  const skinIdx = h % SKIN_TONES.length;
  const skinTone = SKIN_TONES[skinIdx];
  const fairSkin = skinIdx >= 6;
  const hairTone = fairSkin
    ? HAIR_TONES[1 + ((h >>> 3) % 4)]
    : SKIN_TONES[skinIdx] === '#d1a17f'
      ? HAIR_TONES[(h >>> 3) % 3]
      : HAIR_TONES[(h >>> 3) % 2];
  const hairPool: readonly Hairstyle[] = fairSkin
    ? ['taper', 'buzz', 'medium', 'shaved', 'curls', 'long']
    : FALLBACK_HAIR;
  const hairstyle = hairPool[(h >>> 6) % hairPool.length];
  const facialHair = FALLBACK_FACIAL[(h >>> 10) % FALLBACK_FACIAL.length];
  const wingRatio = position === 'C' ? 1.058 : position === 'PF' ? 1.052 : position === 'SF' ? 1.046 : 1.036;
  const wingspan = Math.round(heightMeters * (wingRatio + (((h >>> 14) % 5) - 2) * 0.008) * 100) / 100;
  return {
    wingspan,
    appearance: {
      skinTone,
      hairTone,
      hairstyle,
      facialHair,
      ...(((h >>> 18) % 9) === 0 ? { headband: true } : {}),
      ...(((h >>> 21) % 7) === 0 ? { armSleeve: (h >>> 24) % 2 === 0 ? 'right' : 'left' } : {}),
    },
  };
}
