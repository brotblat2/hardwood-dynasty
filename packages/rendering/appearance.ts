import type { Player } from '../contracts/index.ts';

type AppearanceProfile = Player & { weight?: number; appearance?: { skinTone?: string; hairTone?: string; hairstyle?: string } };

const skinColors = ['#714535', '#955f47', '#b77f60', '#cc9a79', '#d7ab8e', '#9d6b50', '#5e4034'];
const hairstyles = ['buzz', 'fade', 'curls', 'braids', 'shaved'] as const;

export function appearanceFor(profile: Player) {
  const { height, weight, appearance } = profile as AppearanceProfile;
  const meters = height > 50 && height < 100 ? height * 0.0254 : height >= 150 && height < 260 ? height / 100 : height;
  const stature = meters >= 1.5 && meters <= 2.6 ? meters : 1.98;
  let hash = 0;
  for (const char of profile.id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const mass = weight && weight >= 53 && weight <= 190 ? weight : stature * stature * (23.8 + (hash % 7) * 0.72);
  const thickness = Math.max(0.79, Math.min(1.32, Math.sqrt((mass / (stature * stature)) / 25.5)));
  const tone = appearance?.skinTone;
  const skin = tone && /^#[\da-f]{6}$/i.test(tone) ? tone : skinColors[hash % skinColors.length];
  const requestedHair = appearance?.hairstyle;
  const hair = hairstyles.find((style) => style === requestedHair) ?? hairstyles[hash % hairstyles.length];
  const requestedColor = appearance?.hairTone;
  const hairColor = requestedColor && /^#[\da-f]{6}$/i.test(requestedColor) ? requestedColor : hash % 17 === 0 ? '#57402d' : '#251d1b';
  return { stature, thickness, skin, hair, hairColor, hash };
}
