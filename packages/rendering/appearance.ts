import type { FacialHair, Hairstyle, Player, SleeveSide } from '../contracts/index.ts';
import { HAIR_TONES, SKIN_TONES } from '../roster-data/likeness.ts';

export { HAIR_TONES, SKIN_TONES };
export const HAIR_STYLES: readonly Hairstyle[] = ['shaved', 'buzz', 'fade', 'taper', 'curls', 'afro', 'braids', 'locs', 'medium', 'long'];
export const FACIAL_HAIR_STYLES: readonly FacialHair[] = ['none', 'stubble', 'goatee', 'beard', 'fullBeard'];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

function mixHex(hexA: string, hexB: string, t: number, mult = 1): string {
  const [ar, ag, ab] = parseHex(hexA);
  const [br, bg, bb] = parseHex(hexB);
  const r = clamp(Math.round((ar * (1 - t) + br * t) * mult), 0, 255);
  const g = clamp(Math.round((ag * (1 - t) + bg * t) * mult), 0, 255);
  const b = clamp(Math.round((ab * (1 - t) + bb * t) * mult), 0, 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export type ResolvedAppearance = {
  stature: number;
  wingspan: number;
  armScale: number;
  headScale: number;
  thickness: number;
  shoulderScale: number;
  waistScale: number;
  limbBulk: number;
  skin: string;
  skinShade: string;
  lipTone: string;
  hair: Hairstyle;
  hairColor: string;
  facialHair: FacialHair;
  headband: boolean;
  armSleeve: SleeveSide;
  legSleeve: SleeveSide;
  shoeColor?: string;
  hash: number;
};

export function appearanceFor(profile: Player): ResolvedAppearance {
  const { height, weight, wingspan: rawSpan, appearance, position } = profile;
  const meters = height > 50 && height < 100 ? height * 0.0254 : height >= 150 && height < 260 ? height / 100 : height;
  const stature = Number.isFinite(meters) && meters >= 1.5 && meters <= 2.6 ? clamp(meters, 1.58, 2.36) : 1.98;
  let hash = 0;
  for (const char of profile.id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;

  const spanMeters = rawSpan && rawSpan > 50 && rawSpan < 115 ? rawSpan * 0.0254 : rawSpan;
  const wingspan = Number.isFinite(spanMeters) && spanMeters! >= 1.4 && spanMeters! <= 2.8
    ? spanMeters!
    : stature * 1.045;
  const armScale = clamp((wingspan / stature) / 1.04, 0.90, 1.15);
  const headScale = clamp(Math.pow(2.00 / stature, 0.72), 0.84, 1.14);

  const mass = Number.isFinite(weight) && weight! >= 53 && weight! <= 190
    ? weight!
    : stature * stature * (23.8 + (hash % 7) * 0.72);
  const bmi = mass / (stature * stature);
  const thickness = clamp(Math.sqrt(bmi / 25.5), 0.79, 1.32);
  const shoulderScale = clamp(0.91 + (bmi - 22.5) * 0.022 + (position === 'SF' || position === 'PF' ? 0.025 : 0), 0.85, 1.18);
  const waistScale = clamp(0.88 + (bmi - 22.5) * 0.026, 0.82, 1.22);
  const limbBulk = clamp(0.86 + (bmi - 22.0) * 0.024, 0.80, 1.24);

  const tone = appearance?.skinTone;
  const skin = tone && /^#[\da-f]{6}$/i.test(tone) ? tone : SKIN_TONES[hash % SKIN_TONES.length];
  const skinShade = mixHex(skin, '#6e2c26', 0.14, 0.79);
  const lipTone = mixHex(skin, '#8b413e', 0.28, 0.82);

  const hair = HAIR_STYLES.find((style) => style === appearance?.hairstyle) ?? HAIR_STYLES[hash % HAIR_STYLES.length];
  const requestedColor = appearance?.hairTone;
  const hairColor = requestedColor && /^#[\da-f]{6}$/i.test(requestedColor) ? requestedColor : HAIR_TONES[hash % HAIR_TONES.length];
  const facialHair = FACIAL_HAIR_STYLES.find((style) => style === appearance?.facialHair) ?? FACIAL_HAIR_STYLES[(hash >>> 4) % FACIAL_HAIR_STYLES.length];

  const validSleeve = (s: unknown): SleeveSide => (s === 'left' || s === 'right' || s === 'both') ? s : 'none';
  return {
    stature,
    wingspan,
    armScale,
    headScale,
    thickness,
    shoulderScale,
    waistScale,
    limbBulk,
    skin,
    skinShade,
    lipTone,
    hair,
    hairColor,
    facialHair,
    headband: Boolean(appearance?.headband),
    armSleeve: validSleeve(appearance?.armSleeve),
    legSleeve: validSleeve(appearance?.legSleeve),
    shoeColor: appearance?.shoeColor && /^#[\da-f]{6}$/i.test(appearance.shoeColor) ? appearance.shoeColor : undefined,
    hash,
  };
}
