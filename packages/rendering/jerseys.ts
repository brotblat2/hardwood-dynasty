import * as THREE from 'three';
import type { GamePlayer, JerseyKit, JerseyPattern, Side, Team } from '../contracts/index.ts';
import { NBA_TEAM_BRANDING, lookupTeamBranding } from '../roster-data/likeness.ts';

export type KitPalette = {
  kit: JerseyKit;
  base: string;
  accent: string;
  trim: string;
  ink: string;
  outline: string;
  shortsBase: string;
  pattern: JerseyPattern;
  wordmark: string;
};

function parseHex(hex: string): [number, number, number] {
  const c = /^#[\da-f]{6}$/i.test(hex) ? hex.slice(1) : '17408b';
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function colorDistance(a: string, b: string) {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const rmean = (ar + br) * 0.5;
  return Math.sqrt(
    (2 + rmean / 256) * (ar - br) ** 2 +
    4 * (ag - bg) ** 2 +
    (2 + (255 - rmean) / 256) * (ab - bb) ** 2,
  );
}

function luminance(hex: string) {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function shadeHex(hex: string, factor: number): string {
  const [r, g, b] = parseHex(hex);
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clampByte(r * factor).toString(16).padStart(2, '0')}${clampByte(g * factor).toString(16).padStart(2, '0')}${clampByte(b * factor).toString(16).padStart(2, '0')}`;
}

function pickContrastInk(bg: string, preferred: string): { ink: string; outline: string } {
  const bgLum = luminance(bg);
  if (bgLum > 0.65) {
    const dark = luminance(preferred) < 0.42 ? preferred : '#161b22';
    return { ink: dark, outline: '#ffffff' };
  }
  const light = luminance(preferred) > 0.45 ? preferred : '#f7f3e8';
  return { ink: light, outline: bgLum < 0.08 ? '#4c525c' : '#0f1216' };
}

function buildKit(team: Team, kit: JerseyKit): KitPalette {
  const abbr = team.abbreviation.toUpperCase();
  const known = NBA_TEAM_BRANDING[abbr] ?? lookupTeamBranding(abbr, team.color);
  const isKnown = Boolean(NBA_TEAM_BRANDING[abbr]);
  const primary = /^#[\da-f]{6}$/i.test(team.color) ? team.color : known.primary;
  const accent = isKnown ? known.accent : (/^#[\da-f]{6}$/i.test(team.accent) ? team.accent : '#efeadf');
  const tertiary = team.tertiaryColor && /^#[\da-f]{6}$/i.test(team.tertiaryColor)
    ? team.tertiaryColor
    : known.tertiary;
  const pattern: JerseyPattern = team.jerseyPattern ?? known.pattern;
  const wordmark = isKnown ? known.wordmark : team.name.toUpperCase();

  if (kit === 'home') {
    if (abbr === 'LAL') {
      return {
        kit, base: '#fdb927', accent: '#552583', trim: '#ffffff',
        ink: '#552583', outline: '#ffffff', shortsBase: '#fdb927', pattern, wordmark,
      };
    }
    const base = '#f4f1ea';
    const ink = luminance(primary) > 0.68 ? '#182230' : primary;
    const outline = luminance(accent) > 0.72 ? '#161b22' : accent;
    return { kit, base, accent: primary, trim: accent, ink, outline, shortsBase: base, pattern, wordmark };
  }

  if (kit === 'away') {
    const { ink, outline } = pickContrastInk(primary, accent);
    const bright = luminance(primary) > 0.72;
    return {
      kit, base: primary, accent, trim: tertiary, ink: bright ? '#141923' : '#f7f3e8', outline: bright ? '#ffffff' : accent,
      shortsBase: primary, pattern, wordmark,
    };
  }

  if (kit === 'statement') {
    const darkBase = colorDistance(tertiary, primary) > 48 ? tertiary : shadeHex(primary, 0.42);
    const { ink, outline } = pickContrastInk(darkBase, accent);
    return { kit, base: darkBase, accent: primary, trim: accent, ink, outline, shortsBase: darkBase, pattern, wordmark };
  }

  // 'city'
  const [cityBg, cityInk, cityTrim] = known.cityColors;
  const outline = luminance(cityBg) > 0.55 ? '#ffffff' : cityTrim;
  return { kit, base: cityBg, accent: cityTrim, trim: cityInk, ink: cityInk, outline, shortsBase: cityBg, pattern, wordmark };
}

export function resolveKitPalette(team: Team, side: Side, requested?: JerseyKit, avoidBase?: string): KitPalette {
  const defaultKit: JerseyKit = side === 0 ? 'home' : 'away';
  const order: JerseyKit[] = requested
    ? [requested, ...(['home', 'away', 'statement', 'city'] as const).filter(k => k !== requested)]
    : [defaultKit, 'away', 'home', 'statement', 'city'];
  const primary = buildKit(team, order[0]);
  if (!avoidBase || colorDistance(primary.base, avoidBase) >= 95) return primary;

  let best = primary;
  let bestDist = colorDistance(primary.base, avoidBase);
  for (const candidateKit of order.slice(1)) {
    const candidate = buildKit(team, candidateKit);
    const dist = colorDistance(candidate.base, avoidBase);
    if (dist > bestDist) {
      best = candidate;
      bestDist = dist;
    }
    if (dist >= 120) break;
  }
  return best;
}

export function makeClothMaps() {
  const bumpCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  bumpCanvas.width = bumpCanvas.height = 128;
  roughCanvas.width = roughCanvas.height = 128;
  const bCtx = bumpCanvas.getContext('2d')!;
  const rCtx = roughCanvas.getContext('2d')!;
  bCtx.fillStyle = '#cfcfcf';
  bCtx.fillRect(0, 0, 128, 128);
  rCtx.fillStyle = '#d4d4d4';
  rCtx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 4) {
    const shift = (y / 4) % 2 === 0 ? 0 : 2;
    for (let x = shift; x < 128; x += 4) {
      bCtx.fillStyle = '#787878';
      bCtx.fillRect(x, y, 2, 2);
      rCtx.fillStyle = '#f2f2f2';
      rCtx.fillRect(x, y, 2, 2);
    }
  }
  const setup = (canvas: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  };
  return { bumpMap: setup(bumpCanvas), roughnessMap: setup(roughCanvas) };
}

function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  fill: string,
  outline: string,
  lineWidth: number,
  maxWidth?: number,
) {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = outline;
  ctx.lineWidth = lineWidth;
  if (lineWidth > 0) ctx.strokeText(text, x, y, maxWidth);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y, maxWidth);
}

function drawArchedWord(
  ctx: CanvasRenderingContext2D,
  word: string,
  cx: number,
  cy: number,
  arcRise: number,
  fontPx: number,
  fill: string,
  outline: string,
) {
  const letters = [...word];
  if (letters.length <= 1) {
    drawOutlinedText(ctx, word, cx, cy, `900 ${fontPx}px sans-serif`, fill, outline, Math.max(2, fontPx * 0.14), 190);
    return;
  }
  const maxSpan = 165;
  const step = Math.min(fontPx * 0.72, maxSpan / letters.length);
  const scaleX = step < fontPx * 0.56 ? (step / (fontPx * 0.56)) : 1;
  ctx.font = `900 ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const mid = (letters.length - 1) / 2;
  letters.forEach((ch, idx) => {
    const rel = mid > 0 ? (idx - mid) / mid : 0;
    const lx = cx + rel * (step * mid);
    const ly = cy + rel * rel * arcRise;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(rel * (arcRise * 0.011));
    ctx.scale(scaleX, 1);
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(2.5, fontPx * 0.15);
    ctx.strokeText(ch, 0, 0);
    ctx.fillStyle = fill;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
}

function drawPattern(ctx: CanvasRenderingContext2D, W: number, H: number, p: KitPalette) {
  if (p.pattern === 'pinstripe') {
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.28;
    for (let x = 8; x < W; x += 22) ctx.fillRect(x, 0, 3, H);
    ctx.globalAlpha = 1;
  } else if (p.pattern === 'sidePanel') {
    for (const sx of [0, 232, 488]) {
      ctx.fillStyle = p.accent;
      ctx.fillRect(sx, 70, 24, H - 70);
      ctx.fillStyle = p.trim;
      ctx.fillRect(sx + 8, 70, 8, H - 70);
    }
  } else if (p.pattern === 'sash') {
    ctx.save();
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.moveTo(0, H * 0.76);
    ctx.lineTo(256, H * 0.18);
    ctx.lineTo(256, H * 0.34);
    ctx.lineTo(0, H * 0.92);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = p.trim;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  } else if (p.pattern === 'chevron') {
    for (const cx of [128, 384]) {
      ctx.fillStyle = p.accent;
      ctx.beginPath();
      ctx.moveTo(cx - 105, H * 0.28);
      ctx.lineTo(cx, H * 0.42);
      ctx.lineTo(cx + 105, H * 0.28);
      ctx.lineTo(cx + 105, H * 0.36);
      ctx.lineTo(cx, H * 0.50);
      ctx.lineTo(cx - 105, H * 0.36);
      ctx.closePath();
      ctx.fill();
    }
  } else if (p.pattern === 'hoopBand') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, H * 0.50, W, 38);
    ctx.fillStyle = p.trim;
    ctx.fillRect(0, H * 0.50, W, 6);
    ctx.fillRect(0, H * 0.50 + 32, W, 6);
  } else if (p.pattern === 'sunburst') {
    ctx.save();
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.24;
    ctx.lineWidth = 10;
    for (let a = -0.9; a <= 0.9; a += 0.3) {
      ctx.beginPath();
      ctx.moveTo(128, 310);
      ctx.lineTo(128 + Math.sin(a) * 140, 310 - Math.cos(a) * 190);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  } else if (p.pattern === 'herringbone') {
    ctx.strokeStyle = p.trim;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 3;
    for (let y = 60; y < H; y += 26) {
      for (const sx of [0, 234, 490]) {
        ctx.beginPath();
        ctx.moveTo(sx, y + 12);
        ctx.lineTo(sx + 11, y);
        ctx.lineTo(sx + 22, y + 12);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}

export function makeJerseyTexture(team: Team, player: GamePlayer, palette: KitPalette, anisotropy = 2) {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, shadeHex(palette.base, 1.04));
  grad.addColorStop(0.55, palette.base);
  grad.addColorStop(1, shadeHex(palette.base, 0.90));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  drawPattern(ctx, W, H, palette);

  // Ribbed collar trim along top edge + waist seam
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, 0, W, 22);
  ctx.fillStyle = palette.trim;
  ctx.fillRect(0, 22, W, 6);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, H - 14, W, 14);

  // Subtle side stitching lines at hip seams (x = 0, 256, 512)
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 2;
  for (const sx of [2, 256, W - 2]) {
    ctx.beginPath();
    ctx.moveTo(sx, 36);
    ctx.lineTo(sx, H - 14);
    ctx.stroke();
  }

  // Front chest (centered at x = 128)
  const wordSize = palette.wordmark.length > 7 ? 24 : 29;
  drawArchedWord(ctx, palette.wordmark, 128, 126, 14, wordSize, palette.ink, palette.outline);
  drawOutlinedText(ctx, String(player.profile.number), 128, 252, '900 138px sans-serif', palette.ink, palette.outline, 7, 178);

  // Back collar crest
  ctx.fillStyle = palette.trim;
  ctx.fillRect(378, 34, 12, 16);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(384, 34, 6, 16);

  // Back player surname & large back number (centered at x = 384)
  const parts = player.profile.name.trim().split(/\s+/);
  const lastName = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).toUpperCase();
  const namePx = lastName.length > 9 ? 23 : lastName.length > 6 ? 27 : 31;
  drawArchedWord(ctx, lastName, 384, 114, 11, namePx, palette.ink, palette.outline);
  drawOutlinedText(ctx, String(player.profile.number), 384, 254, '900 162px sans-serif', palette.ink, palette.outline, 8, 194);

  // Authentic waist jock tag on lower-right front
  ctx.fillStyle = '#18191d';
  ctx.fillRect(194, 444, 38, 24);
  ctx.fillStyle = palette.trim;
  ctx.fillRect(196, 446, 34, 4);
  ctx.fillStyle = '#e8e4dc';
  ctx.font = '800 8px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(team.abbreviation.slice(0, 3), 213, 460);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

export function makeShortsTexture(_team: Team, palette: KitPalette, anisotropy = 2) {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = palette.shortsBase;
  ctx.fillRect(0, 0, S, S);

  // Striped waistband
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, 0, S, 36);
  ctx.fillStyle = palette.trim;
  ctx.fillRect(0, 14, S, 8);

  // Side leg stripes/panels aligned along u = 0 / 0.5 / 1 seams
  for (const sx of [0, 116, 244]) {
    ctx.fillStyle = palette.accent;
    ctx.fillRect(sx, 36, 16, S - 52);
    ctx.fillStyle = palette.trim;
    ctx.fillRect(sx + 5, 36, 6, S - 52);
  }
  if (palette.pattern === 'pinstripe') {
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = 0.25;
    for (let x = 14; x < S; x += 18) ctx.fillRect(x, 36, 2, S - 52);
    ctx.globalAlpha = 1;
  }

  // Bottom hem trim
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, S - 16, S, 16);
  ctx.fillStyle = palette.trim;
  ctx.fillRect(0, S - 20, S, 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}
