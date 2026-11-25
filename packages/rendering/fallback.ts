import { PerspectiveCamera, Vector3 } from 'three';
import { COURT, TICK_RATE } from '../contracts/index.ts';
import type { GameEvent, GamePlayer, GameState, Team, Vec3 } from '../contracts/index.ts';
import { makeCourtTexture, seededRandom } from './court.ts';
import { courtMovement } from './input-view.ts';
import { appearanceFor } from './appearance.ts';
import { makeGameCamera } from './camera.ts';
import { resolveKitPalette } from './jerseys.ts';
import { makeMotion, motionEvents } from './motion.ts';
import { netResponse } from './equipment.ts';
import type { Camera, GameRenderer, RenderHints, RendererOptions } from './index.ts';

type Point = { x: number; y: number; depth: number };
type SourcePoint = { x: number; y: number };
const courtLength = COURT.length + 3.3;
const courtWidth = COURT.width + 3.3;
const skinTones = ['#a66d4d', '#6f4638', '#cb9a76', '#87553d', '#b38164'];
const spectatorTops = ['#505958', '#6c6551', '#38474c', '#72584c', '#485c58', '#676d66', '#594640'];

export function createCanvasFallback(container: HTMLElement, options: RendererOptions = {}): GameRenderer {
  const canvas = document.createElement('canvas');
  canvas.style.width = canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.setAttribute('aria-label', 'Hardwood Dynasty perspective basketball court');
  canvas.setAttribute('role', 'img');
  container.append(canvas);
  const ctx = canvas.getContext('2d');
  const backdrop = document.createElement('canvas');
  const background = backdrop.getContext('2d');
  const floorTextures = new Map<string, ReturnType<typeof makeCourtTexture>>();
  const camera = new PerspectiveCamera(39, 1, 0.12, 120);
  const vector = new Vector3();
  const placeCamera = makeGameCamera(camera);
  const actors = new Map<string, { appearance: ReturnType<typeof appearanceFor>; motion: ReturnType<typeof makeMotion> }>();
  const trailPoints: Vec3[] = [];
  let lastFrame = 0;
  let lastBallTick = -1;
  let lastTrailTick = -1;
  let ballRoll = 0;
  let view: Camera = options.camera ?? 'broadcast';
  let quality = options.quality ?? 'high';
  let stateKey = '';
  let picks: { id: string; x: number; y: number; radius: number }[] = [];

  function project(x: number, y: number, z: number): Point {
    vector.set(x, y, z).project(camera);
    return { x: (vector.x + 1) * canvas.width / 2, y: (1 - vector.y) * canvas.height / 2, depth: vector.z };
  }

  function shape(target: CanvasRenderingContext2D, color: string | CanvasGradient, ...points: Point[]) {
    if (points.some((point) => point.depth < -1 || point.depth > 1)) return;
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) target.lineTo(point.x, point.y);
    target.closePath();
    target.fillStyle = color;
    target.fill();
  }

  function line(target: CanvasRenderingContext2D, color: string, width: number, ...points: Point[]) {
    if (points.some((point) => point.depth < -1 || point.depth > 1)) return;
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) target.lineTo(point.x, point.y);
    target.lineJoin = 'round';
    target.lineCap = 'round';
    target.strokeStyle = color;
    target.lineWidth = width;
    target.stroke();
  }

  function disc(target: CanvasRenderingContext2D, center: Point, x: number, y: number, color: string | CanvasGradient, stroke?: string) {
    if (center.depth < -1 || center.depth > 1) return;
    target.beginPath();
    target.ellipse(center.x, center.y, x, y, 0, 0, Math.PI * 2);
    target.fillStyle = color;
    target.fill();
    if (stroke) {
      target.strokeStyle = stroke;
      target.lineWidth = 1.3;
      target.stroke();
    }
  }

  function paintTriangle(target: CanvasRenderingContext2D, image: HTMLCanvasElement, p: Point, q: Point, r: Point, a: SourcePoint, b: SourcePoint, c: SourcePoint) {
    if ([p, q, r].some(({ depth }) => depth < -1 || depth > 1)) return;
    if (Math.max(p.x, q.x, r.x) < 0 || Math.min(p.x, q.x, r.x) > canvas.width ||
        Math.max(p.y, q.y, r.y) < 0 || Math.min(p.y, q.y, r.y) > canvas.height) return;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const ex = r.x - p.x;
    const ey = r.y - p.y;
    const divide = ux * vy - uy * vx;
    const xx = (dx * vy - ex * uy) / divide;
    const xy = (dy * vy - ey * uy) / divide;
    const yx = (ex * ux - dx * vx) / divide;
    const yy = (ey * ux - dy * vx) / divide;
    const center = { x: (p.x + q.x + r.x) / 3, y: (p.y + q.y + r.y) / 3 };
    target.save();
    target.beginPath();
    for (const point of [p, q, r]) {
      const length = Math.max(1, Math.hypot(point.x - center.x, point.y - center.y));
      target.lineTo(point.x + (point.x - center.x) / length, point.y + (point.y - center.y) / length);
    }
    target.closePath();
    target.clip();
    target.transform(xx, xy, yx, yy, p.x - xx * a.x - yx * a.y, p.y - xy * a.x - yy * a.y);
    const left = Math.floor(Math.min(a.x, b.x, c.x));
    const top = Math.floor(Math.min(a.y, b.y, c.y));
    const width = Math.ceil(Math.max(a.x, b.x, c.x)) - left;
    const height = Math.ceil(Math.max(a.y, b.y, c.y)) - top;
    target.drawImage(image, left, top, width, height, left, top, width, height);
    target.restore();
  }

  let spectatorRows: HTMLCanvasElement[] | undefined;

  function crowdRows() {
    if (spectatorRows) return spectatorRows;
    const random = seededRandom(1802);
    spectatorRows = [];
    for (let row = 0; row < 11; row++) {
      const strip = document.createElement('canvas');
      strip.width = 1840;
      strip.height = 77;
      const art = strip.getContext('2d')!;
      const rowLight = art.createLinearGradient(0, 0, 0, strip.height);
      rowLight.addColorStop(0, '#222b2821');
      rowLight.addColorStop(0.43, '#2d3934');
      rowLight.addColorStop(1, '#1c2824');
      art.fillStyle = rowLight;
      art.fillRect(0, 30, strip.width, 47);
      art.fillStyle = '#70827567';
      art.fillRect(0, 63, strip.width, 1);
      art.fillStyle = '#121a17';
      art.fillRect(0, 72, strip.width, 5);
      for (let i = 0; i < 79; i++) {
        const x = 12 + i * 23.4 + (random() - 0.5) * 7;
        if (i % 14 === 0 || i % 14 === 1) {
          art.fillStyle = '#59645a';
          art.fillRect(x - 8, 59, 15, 2);
          continue;
        }
        art.fillStyle = '#16221f';
        art.fillRect(x - 7, 38, 15, 26);
        if (random() < 0.16) continue;
        const y = 13 + random() * 11;
        const broad = 7.1 + random() * 4.2;
        const tone = skinTones[Math.floor(random() * skinTones.length)];
        const top = spectatorTops[Math.floor(random() * spectatorTops.length)];
        art.fillStyle = top;
        art.beginPath();
        art.moveTo(x - 4, y + 15);
        art.quadraticCurveTo(x - broad, y + 16, x - broad - 2.5, y + 27);
        art.lineTo(x - broad - 1, y + 47);
        art.lineTo(x + broad + 1, y + 47);
        art.quadraticCurveTo(x + broad + 3, y + 18, x + 3, y + 15);
        art.fill();
        art.fillStyle = '#10171449';
        art.fillRect(x + 2, y + 22, 2 + broad * 0.28, 25);
        art.fillStyle = tone;
        art.fillRect(x - 2.8, y + 11, 5.6, 8);
        art.beginPath();
        art.ellipse(x, y + 7, 5.7 + random() * 1.1, 8.1, 0, 0, Math.PI * 2);
        art.fill();
        art.fillStyle = '#2d2825';
        art.beginPath();
        art.ellipse(x, y + 2, 6 + random() * 0.9, 3.25 + random() * 1.2, 0, Math.PI, Math.PI * 2);
        art.fill();
        if (i % 5 === 2) {
          art.fillStyle = '#d9cdb063';
          art.fillRect(x - 4, y + 22, 8, 1.5);
        }
      }
      spectatorRows.push(strip);
    }
    return spectatorRows;
  }

  function paintPanel(target: CanvasRenderingContext2D, image: HTMLCanvasElement, left: number, right: number, low: number, high: number, z: number) {
    const a = project(left, high, z);
    const b = project(right, high, z);
    const c = project(left, low, z);
    const d = project(right, low, z);
    const topLeft = { x: 0, y: 0 };
    const topRight = { x: image.width, y: 0 };
    const bottomLeft = { x: 0, y: image.height };
    const bottomRight = { x: image.width, y: image.height };
    paintTriangle(target, image, a, b, c, topLeft, topRight, bottomLeft);
    paintTriangle(target, image, b, d, c, topRight, bottomRight, bottomLeft);
  }

  function paintArena(blacktop: boolean, homeTeam?: Team) {
    if (!background) return;
    const target = background;
    const random = seededRandom(1701);
    const gradient = target.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, blacktop ? '#38525d' : '#27342f');
    gradient.addColorStop(0.45, blacktop ? '#283943' : '#182723');
    gradient.addColorStop(1, blacktop ? '#141d25' : '#0a100e');
    target.fillStyle = gradient;
    target.fillRect(0, 0, canvas.width, canvas.height);
    if (blacktop) {
      for (let x = -33; x < 27; x += 2.2 + random() * 2.6) {
        const rise = 2 + random() * 7;
        const length = 2 + random() * 3;
        const z = -23 - random() * 6;
        shape(target, random() > 0.5 ? '#243842' : '#2a4148', project(x, 0, z), project(x, rise, z), project(x + length, rise, z), project(x + length, 0, z));
      }
      for (let x = -17; x <= 17; x += 0.46) line(target, '#8fa29f45', 0.65, project(x, 0, -9.8), project(x, 3.7, -9.8));
      for (let y = 0; y < 3.7; y += 0.3) line(target, '#8fa29f55', 0.65, project(-17, y, -9.8), project(17, y, -9.8));
    } else {
      const wall = target.createLinearGradient(0, 0, 0, canvas.height * 0.38);
      wall.addColorStop(0, '#172720');
      wall.addColorStop(1, '#313a33');
      target.fillStyle = wall;
      target.fillRect(0, 0, canvas.width, canvas.height * 0.34);
      shape(target, '#26352e', project(-29, 0, -18), project(-29, 9.8, -18), project(29, 9.8, -18), project(29, 0, -18));
      line(target, '#4b5d50', 3.15, project(-29, 5.72, -17.86), project(29, 5.72, -17.86));
      line(target, '#7d8d715f', 1.3, project(-29, 5.82, -17.84), project(29, 5.82, -17.84));
      line(target, '#121f1b', 5.25, project(-29, 8.0, -17.55), project(29, 8.0, -17.55));
      for (const x of [-22, -16.5, -11, -5.5, 0, 5.5, 11, 16.5, 22]) {
        line(target, '#52635657', 1.6, project(x, 5.78, -17.83), project(x, 10.2, -17.83));
        line(target, '#456156', 4.1, project(x - 1.52, 7.55, -17.64), project(x + 1.52, 7.55, -17.64));
        for (const offset of [-1.07, -0.36, 0.36, 1.07]) {
          line(target, '#eae8cce3', 1.6, project(x + offset - 0.22, 7.55, -17.6), project(x + offset + 0.22, 7.55, -17.6));
        }
      }
      const rows = crowdRows();
      for (let row = rows.length - 1; row >= 0; row--) {
        const y = row * 0.43 + (row >= 6 ? 0.3 : 0);
        const z = -9.56 - row * 0.64 - (row >= 6 ? 0.40 : 0);
        paintPanel(target, rows[row], -21.0, 21.0, y - 0.24, y + 0.79, z);
        if (row === 5 || row === 9) line(target, '#778b7f83', 0.94, project(-21, y + 0.4, z + 0.18), project(21, y + 0.4, z + 0.18));
      }
      const left = project(-14.9, 0.2, -9.03);
      const right = project(14.9, 0.2, -9.03);
      shape(target, '#102923', left, project(-14.9, 0.86, -9.03), project(14.9, 0.86, -9.03), right);
      line(target, '#233c2e', 4.0, project(-14.9, 0.22, -9.025), project(14.9, 0.22, -9.025));
      line(target, '#709785', 1.2, project(-14.9, 0.83, -9.025), project(14.9, 0.83, -9.025));
      target.fillStyle = '#b8c7aa';
      target.font = `bold ${Math.max(8, canvas.height * 0.013)}px sans-serif`;
      target.textAlign = 'center';
      const bannerText = homeTeam ? `${homeTeam.city} ${homeTeam.name}`.toUpperCase() : 'HARDWOOD DYNASTY';
      for (const x of [-10.5, -3.5, 3.5, 10.5]) {
        const label = project(x, 0.46, -9.02);
        if (label.depth >= -1 && label.depth <= 1) target.fillText(bannerText, label.x, label.y);
      }
    }
    const floorKey = blacktop ? 'blacktop' : `team:${homeTeam?.id ?? 'default'}`;
    if (!floorTextures.has(floorKey)) floorTextures.set(floorKey, makeCourtTexture(blacktop, 1, homeTeam));
    const image = floorTextures.get(floorKey)!.image as HTMLCanvasElement;
    const columns = quality === 'high' ? 11 : 8;
    const rows = quality === 'high' ? 8 : 6;
    for (let v = 0; v < rows; v++) {
      for (let u = 0; u < columns; u++) {
        const source = (x: number, y: number) => ({ x: image.width * x / columns, y: image.height * y / rows });
        const world = (x: number, z: number) => project(courtLength * (x / columns - 0.5), 0, courtWidth * (z / rows - 0.5));
        const a = world(u, v);
        const b = world(u + 1, v);
        const c = world(u, v + 1);
        const d = world(u + 1, v + 1);
        const s = source(u, v);
        const t = source(u + 1, v);
        const m = source(u, v + 1);
        const n = source(u + 1, v + 1);
        paintTriangle(target, image, a, b, c, s, t, m);
        paintTriangle(target, image, b, d, c, t, n, m);
      }
    }
  }

  function paintHoop(target: CanvasRenderingContext2D, side: number, ratio: number, state: GameState) {
    const rimX = side * COURT.rimX;
    const board = rimX + side * 0.39;
    const pole = side * 15.76;
    const h = COURT.rimHeight;
    const weight = Math.max(1.1, Math.abs(project(pole, 0, 0).y - project(pole, 2.2, 0).y) / 21);
    line(target, '#1b2623', weight * 2.5, project(pole, 0.04, -0.38), project(pole, 0.04, 0.38));
    line(target, '#2b3c37', weight * 1.57, project(pole, 1.62, 0), project(pole, h + 0.32, 0), project(board, h + 0.32, 0));
    line(target, '#9daaa1', weight, project(pole, 1.62, 0), project(pole, h + 0.32, 0), project(board, h + 0.32, 0));
    line(target, '#71817c', weight * 0.78, project(pole, h - 0.22, 0), project(pole - side * 1.55, h + 0.29, 0));
    line(target, '#213d37', weight * 3.1, project(pole, 0.075, 0), project(pole, 2.09, 0));
    line(target, '#426556', weight * 1.28, project(pole, 0.16, -0.09), project(pole, 2.02, -0.09));
    const corners = [project(board, h - 0.07, -0.9), project(board, h + 0.98, -0.9), project(board, h + 0.98, 0.9), project(board, h - 0.07, 0.9)];
    shape(target, '#a6c0b34c', ...corners);
    shape(target, '#e6f7ef40', corners[1], corners[2], project(board, h + 0.63, 0.72), project(board, h + 0.86, -0.9));
    line(target, '#e3e4cc', ratio * 1.15, ...corners, corners[0]);
    const rectangle = [project(board, h + 0.035, -0.279), project(board, h + 0.48, -0.279), project(board, h + 0.48, 0.279), project(board, h + 0.035, 0.279)];
    line(target, '#e7dfc5', ratio * 0.85, ...rectangle, rectangle[0]);
    line(target, '#bd4f2e', weight * 0.75, project(board, h, 0), project(rimX + side * 0.22, h, 0));
    const clockBox = project(board + side * 0.08, h + 1.20, 0);
    if (clockBox.depth >= -1 && clockBox.depth <= 1) {
      const bw = Math.max(18 * ratio, weight * 7);
      const bh = bw * 0.7;
      target.fillStyle = '#0e1112';
      target.fillRect(clockBox.x - bw / 2, clockBox.y - bh / 2, bw, bh);
      target.strokeStyle = state.shotClock <= 0 ? '#ff4a44' : '#3a4240';
      target.lineWidth = Math.max(1, ratio);
      target.strokeRect(clockBox.x - bw / 2, clockBox.y - bh / 2, bw, bh);
      target.fillStyle = state.shotClock <= 5 ? '#ff554c' : '#ffba52';
      target.font = `900 ${Math.max(8, bh * 0.72)}px monospace`;
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      target.fillText(String(Math.max(0, Math.ceil(state.shotClock))).padStart(2, '0'), clockBox.x, clockBox.y + 1);
    }
    const impact = netResponse(state, side);
    const rim: Point[] = [];
    const rows = 5;
    const columns = 12;
    for (let i = 0; i <= 24; i++) {
      const angle = i / 24 * Math.PI * 2;
      rim.push(project(rimX + 0.235 * Math.cos(angle), h, 0.235 * Math.sin(angle)));
    }
    const cord = (row: number, column: number) => {
      const fade = row / rows;
      const angle = column / columns * Math.PI * 2;
      const radius = 0.221 - fade * 0.088 + impact.flare * fade;
      return project(rimX + radius * Math.cos(angle) + impact.x * fade * fade, h - fade * (0.43 + impact.drop),
        radius * Math.sin(angle) + impact.z * fade * fade);
    };
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < columns; i++) {
        for (const offset of [-0.5, 0.5]) {
          line(target, row % 2 ? '#f9f1d999' : '#fff4e2c6', ratio * 0.68,
            cord(row, i + row * 0.5), cord(row + 1, i + row * 0.5 + offset));
        }
      }
    }
    line(target, '#5c2a1b', ratio * 1.65, ...rim);
    line(target, '#ed713e', ratio * 1.1, ...rim);
  }

  const palette = new Map<string, [string, string, string]>();
  function colors(color: string): [string, string, string] {
    const cached = palette.get(color);
    if (cached) return cached;
    const rgb = Number.parseInt(color.slice(1), 16);
    const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
    const tint = (scale: number, warm: number) => `rgb(${channel((rgb >> 16) * scale + warm)},${channel((rgb >> 8 & 255) * scale + warm * 0.91)},${channel((rgb & 255) * scale + warm * 0.74)})`;
    const result: [string, string, string] = [tint(1.15, 11), color, tint(0.61, 3)];
    palette.set(color, result);
    return result;
  }

  function lit(target: CanvasRenderingContext2D, color: string, a: Point, b: Point): string | CanvasGradient {
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.08) return color;
    const [highlight, base, shadow] = colors(color);
    const gradient = target.createLinearGradient(a.x, a.y, b.x, b.y);
    gradient.addColorStop(0, shadow);
    gradient.addColorStop(0.38, highlight);
    gradient.addColorStop(0.71, base);
    gradient.addColorStop(1, shadow);
    return gradient;
  }

  function tapered(target: CanvasRenderingContext2D, color: string, a: Point, b: Point, start: number, middle: number, end: number) {
    if (a.depth < -1 || a.depth > 1 || b.depth < -1 || b.depth > 1) return;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.07) return;
    const dx = (b.y - a.y) / length;
    const dy = (a.x - b.x) / length;
    const cx = a.x + (b.x - a.x) * 0.42;
    const cy = a.y + (b.y - a.y) * 0.42;
    target.beginPath();
    target.moveTo(a.x + dx * start, a.y + dy * start);
    target.quadraticCurveTo(cx + dx * middle, cy + dy * middle, b.x + dx * end, b.y + dy * end);
    target.quadraticCurveTo(b.x + (b.x - a.x) * 0.19, b.y + (b.y - a.y) * 0.19, b.x - dx * end, b.y - dy * end);
    target.quadraticCurveTo(cx - dx * middle, cy - dy * middle, a.x - dx * start, a.y - dy * start);
    target.quadraticCurveTo(a.x - (b.x - a.x) * 0.19, a.y - (b.y - a.y) * 0.19, a.x + dx * start, a.y + dy * start);
    target.closePath();
    target.fillStyle = lit(target, color, { ...a, x: cx - dx * middle, y: cy - dy * middle }, { ...b, x: cx + dx * middle, y: cy + dy * middle });
    target.fill();
  }

  function paintActor(target: CanvasRenderingContext2D, player: GamePlayer, state: GameState, selected: boolean, ratio: number, event: GameEvent | undefined, isPassTarget = false) {
    let actor = actors.get(player.id);
    if (!actor) {
      const appearance = appearanceFor(player.profile);
      actor = { appearance, motion: makeMotion(appearance.stature, appearance.thickness, appearance.hash, appearance.armScale) };
      actors.set(player.id, actor);
    }
    const { x, z } = player.position;
    const ground = project(x, 0, z);
    const { stature, thickness, shoulderScale, limbBulk, armScale, headScale, skin, hair: hairstyle, hairColor, facialHair, headband, armSleeve, legSleeve, hash } = actor.appearance;
    const charge = state.charge[player.id] ?? 0;
    const heldBall = state.ball.ownerId === player.id ? state.ball.position : undefined;
    const pose = actor.motion(player, state.tick, heldBall, charge, event);
    const head = project(x, stature + pose.rise, z);
    if (ground.depth > 1 || ground.depth < -1 || ground.x < -140 || ground.x > canvas.width + 140 || ground.y < -140 || head.y > canvas.height + 140) return;
    const size = Math.max(8, Math.hypot(head.x - ground.x, head.y - ground.y));
    const unit = size / (2.02 + pose.rise);
    const scale = stature / 2.02;
    const fx = Math.cos(pose.facing);
    const fz = Math.sin(pose.facing);
    const team = state.teams[player.side];
    const requestedKit = state.config.kits?.[player.side];
    const avoid = player.side === 1 ? resolveKitPalette(state.teams[0], 0, state.config.kits?.[0]).base : undefined;
    const palette = resolveKitPalette(team, player.side, requestedKit, avoid);
    const jersey = palette.base;
    const strip = palette.accent;
    const shorts = palette.shortsBase;
    const boot = actor.appearance.shoeColor ?? (hash % 3 === 1 ? '#2b2d30' : '#ecebe2');
    const sole = hash % 3 === 1 ? strip : '#353a3d';
    const socks = hash % 5 === 0 ? strip : '#e5e4d9';
    const at = (side: number, y: number, forward: number) => project(x + scale * (side * fz + forward * fx),
      scale * (y + pose.rise), z + scale * (-side * fx + forward * fz));
    const joint = ({ x, y, z }: Vec3) => at(x, y, z);
    const upper = (side: number, y: number, forward: number) => at(side * shoulderScale - (y - 1.29) * pose.roll, y - pose.crouch,
      forward + (y - 1.29) * pose.tilt - side * pose.twist);
    const headPt = (side: number, y: number, forward: number) => upper(side * headScale * (0.9 + 0.1 / Math.max(0.8, shoulderScale)), 1.74 + (y - 1.74) * headScale, forward * headScale);
    const towardCamera = (camera.position.x - x) * fx + (camera.position.z - z) * fz;
    const acrossCamera = (camera.position.x - x) * fz - (camera.position.z - z) * fx;
    const showFront = towardCamera >= 0 ? 1 : -1;
    const detail = size > 44 * ratio;
    const surface = project(x - 0.10 - pose.rise * 0.37, 0.018, z + 0.04);
    const shadowWidth = Math.max(3 * ratio, size * (0.23 + pose.rise * 0.045));
    const shadow = target.createRadialGradient(0, 0, 0, 0, 0, 1);
    shadow.addColorStop(0, '#21190e8a');
    shadow.addColorStop(0.46, '#21190e53');
    shadow.addColorStop(1, '#21190e00');
    target.save();
    target.translate(surface.x, surface.y);
    target.scale(shadowWidth, shadowWidth * 0.42);
    target.fillStyle = shadow;
    target.fillRect(-1, -1, 2, 2);
    target.restore();
    const action = player.action;
    if (action?.intenseD || action?.bodyUp === 'clamp' || action?.bodyUp === 'ride') {
      const arc: Point[] = [];
      const arcSteps = 16;
      for (let i = 0; i <= arcSteps; i++) {
        const theta = pose.facing + (i / arcSteps - 0.5) * Math.PI * 0.84;
        arc.push(project(x + 0.485 * Math.cos(theta), 0.023, z + 0.485 * Math.sin(theta)));
      }
      line(target, action.bodyUp === 'clamp' ? '#2e9dff' : '#5ec8ff', ratio * (action.bodyUp === 'clamp' ? 2.6 : 1.9), ...arc);
    }
    const st = action?.stumble ?? 0;
    const fb = action?.flyBy ?? 0;
    if (st > 0 || fb > 0) {
      const ringPts: Point[] = [];
      const steps = 28;
      for (let i = 0; i <= steps; i++) {
        const arc = i / steps * Math.PI * 2;
        ringPts.push(project(x + 0.50 * Math.cos(arc), 0.024, z + 0.50 * Math.sin(arc)));
      }
      line(target, st > 0 ? '#ffb347' : '#ff7f66', ratio * 2.1, ...ringPts);
    }
    const greenAge = state.shotFeedback?.green && state.shotFeedback.playerId === player.id ? state.tick - state.shotFeedback.tick : -1;
    if (greenAge >= 0 && greenAge < 36) {
      const pulse = 1 - greenAge / 36;
      const radius = 0.48 * (1 + (1 - pulse) * 0.75);
      const ringPts: Point[] = [];
      const steps = 32;
      for (let i = 0; i <= steps; i++) {
        const arc = i / steps * Math.PI * 2;
        ringPts.push(project(x + radius * Math.cos(arc), 0.027, z + radius * Math.sin(arc)));
      }
      line(target, `rgba(140,255,102,${(0.9 * pulse).toFixed(2)})`, ratio * 2.5, ...ringPts);
    }
    if (selected || isPassTarget) {
      const marker: Point[] = [];
      const steps = 36;
      for (let i = 0; i <= steps; i++) {
        const arc = i / steps * Math.PI * 2;
        marker.push(project(x + 0.42 * Math.cos(arc), 0.026, z + 0.42 * Math.sin(arc)));
      }
      if (selected) {
        line(target, '#1725148a', ratio * 3.15, ...marker);
        line(target, '#ddffa2', ratio * 1.8, ...marker);
        if (charge > 0) {
          const meterInfo = state.shotMeter?.playerId === player.id ? state.shotMeter : undefined;
          const ideal = meterInfo?.ideal ?? 0.62;
          const gw = meterInfo?.greenWindow ?? 0.065;
          const maxC = meterInfo?.maxCharge ?? 1.2;
          const meterColor = Math.abs(charge - ideal) <= gw ? '#baff93' : charge > ideal + gw ? '#ff7d7c' : '#ffc763';
          line(target, meterColor, ratio * 2.7, ...marker.slice(0, 2 + Math.floor(Math.min(1, charge / maxC) * (steps - 1))));
        }
      } else {
        line(target, '#0f273088', ratio * 2.8, ...marker);
        line(target, '#62e5ff', ratio * 1.8, ...marker);
      }
    }

    const order = acrossCamera < 0 ? [1, 0] : [0, 1];
    const paintArm = (i: number) => {
      const limb = pose.arms[i];
      const a = joint(limb.start);
      const b = joint(limb.joint);
      const c = joint(limb.end);
      tapered(target, skin, a, b, unit * 0.074 * limbBulk, unit * 0.1 * limbBulk, unit * 0.052 * limbBulk);
      tapered(target, skin, b, c, unit * 0.051 * limbBulk, unit * 0.072 * limbBulk, unit * 0.032 * limbBulk);
      if (armSleeve === 'both' || (i === 0 && armSleeve === 'left') || (i === 1 && armSleeve === 'right')) {
        const sTop = at(limb.joint.x * 0.6 + limb.start.x * 0.4, limb.joint.y * 0.6 + limb.start.y * 0.4, limb.joint.z * 0.6 + limb.start.z * 0.4);
        const sBot = at(limb.end.x * 0.85 + limb.joint.x * 0.15, limb.end.y * 0.85 + limb.joint.y * 0.15, limb.end.z * 0.85 + limb.joint.z * 0.15);
        tapered(target, palette.kit === 'home' ? '#1a1c20' : strip, sTop, sBot, unit * 0.068 * limbBulk, unit * 0.068 * limbBulk, unit * 0.044 * limbBulk);
      }
      if (i === 1 && hash % 5 === 0) {
        const cuff = at(limb.end.x * 0.83 + limb.joint.x * 0.17, limb.end.y * 0.83 + limb.joint.y * 0.17, limb.end.z * 0.83 + limb.joint.z * 0.17);
        tapered(target, strip, cuff, c, unit * 0.04, unit * 0.042, unit * 0.036);
      }
      const hand = at(limb.end.x + (limb.end.x - limb.joint.x) * 0.12 * armScale, limb.end.y + (limb.end.y - limb.joint.y) * 0.12 * armScale + limb.pitch * 0.026,
        limb.end.z + (limb.end.z - limb.joint.z) * 0.12 * armScale);
      tapered(target, skin, c, hand, unit * 0.032, unit * 0.052, unit * 0.041);
    };

    for (const i of order) {
      const limb = pose.legs[i];
      const hip = joint(limb.start);
      const knee = joint(limb.joint);
      const ankle = joint(limb.end);
      const hem = at(limb.joint.x * 0.83 + limb.start.x * 0.17, limb.joint.y * 0.83 + limb.start.y * 0.17, limb.joint.z * 0.83 + limb.start.z * 0.17);
      tapered(target, skin, knee, ankle, unit * 0.057 * limbBulk, unit * 0.105 * limbBulk, unit * 0.034 * limbBulk);
      if (legSleeve === 'both' || (i === 0 && legSleeve === 'left') || (i === 1 && legSleeve === 'right')) {
        const lTop = at(limb.joint.x * 0.85 + limb.start.x * 0.15, limb.joint.y * 0.85 + limb.start.y * 0.15, limb.joint.z * 0.85 + limb.start.z * 0.15);
        const lBot = at(limb.end.x * 0.6 + limb.joint.x * 0.4, limb.end.y * 0.6 + limb.joint.y * 0.4, limb.end.z * 0.6 + limb.joint.z * 0.4);
        tapered(target, palette.kit === 'home' ? '#1a1c20' : strip, lTop, lBot, unit * 0.075 * limbBulk, unit * 0.08 * limbBulk, unit * 0.062 * limbBulk);
      }
      tapered(target, shorts, hip, hem, unit * 0.105 * limbBulk, unit * 0.139 * limbBulk, unit * 0.095 * limbBulk);
      if (detail) {
        const seam = i === 0 ? -0.098 : 0.098;
        line(target, strip, Math.max(0.65, unit * 0.018), at(limb.start.x + seam, limb.start.y, limb.start.z + 0.035),
          at(limb.joint.x * 0.83 + limb.start.x * 0.17 + seam, limb.joint.y * 0.83 + limb.start.y * 0.17, limb.joint.z * 0.83 + limb.start.z * 0.17 + 0.015));
      }
      const top = at(limb.end.x * 0.78 + limb.joint.x * 0.22, limb.end.y * 0.78 + limb.joint.y * 0.22, limb.end.z * 0.78 + limb.joint.z * 0.22);
      tapered(target, socks, top, ankle, unit * 0.045, unit * 0.053, unit * 0.042);
      const heel = at(limb.end.x, limb.end.y - 0.048, limb.end.z - 0.061);
      const toe = at(limb.end.x, limb.end.y - 0.044 + limb.pitch * 0.115, limb.end.z + 0.185);
      tapered(target, sole, { ...heel, y: heel.y + unit * 0.022 }, { ...toe, y: toe.y + unit * 0.022 }, unit * 0.049, unit * 0.057, unit * 0.039);
      tapered(target, boot, heel, toe, unit * 0.063, unit * 0.066, unit * 0.039);
      if (detail) line(target, strip, Math.max(0.65, unit * 0.016), heel, at(limb.end.x - 0.04, limb.end.y - 0.038, limb.end.z + 0.03));
    }

    paintArm(order[0]);
    tapered(target, skin, upper(0, 1.63, 0), upper(0, 1.805, 0), unit * 0.077, unit * 0.082, unit * 0.06);
    const panel = (depth: number) => [upper(-0.136, 1.69, depth * 0.057), upper(-0.234, 1.62, depth * 0.067), upper(-0.198, 1.42, depth * 0.088), upper(-0.175, 1.16, depth * 0.087),
      upper(0.175, 1.16, depth * 0.087), upper(0.198, 1.42, depth * 0.088), upper(0.234, 1.62, depth * 0.067), upper(0.136, 1.69, depth * 0.057)];
    const facingPanel = panel(showFront);
    shape(target, colors(jersey)[2], ...panel(-showFront));
    shape(target, lit(target, jersey, upper(-0.22, 1.4, 0), upper(0.23, 1.4, 0)), ...facingPanel);
    const trimWidth = Math.max(0.68, unit * 0.026);
    line(target, strip, trimWidth, facingPanel[0], upper(0, showFront === 1 ? 1.614 : 1.659, 0.119 * showFront), facingPanel[7]);
    line(target, strip, trimWidth * 0.78, facingPanel[1], facingPanel[2], facingPanel[3]);
    line(target, strip, trimWidth * 0.76, facingPanel[6], facingPanel[5], facingPanel[4]);
    if (detail) {
      line(target, colors(jersey)[2], trimWidth * 0.47, upper(-0.12, 1.25, 0.114 * showFront), upper(0.055, 1.22, 0.113 * showFront));
      line(target, colors(jersey)[0], trimWidth * 0.4, upper(0.06, 1.3, 0.115 * showFront), upper(0.12, 1.24, 0.11 * showFront));
    }
    const digit = upper(0, 1.44, 0.147 * showFront);
    const leftNumber = upper(-0.09, 1.44, 0.144 * showFront);
    const rightNumber = upper(0.09, 1.44, 0.144 * showFront);
    const widthFactor = Math.hypot(rightNumber.x - leftNumber.x, rightNumber.y - leftNumber.y) / Math.max(1, unit * 0.18);
    if (widthFactor > 0.36 && digit.depth >= -1 && digit.depth <= 1) {
      target.save();
      target.translate(digit.x, digit.y);
      target.scale(Math.min(1.05, widthFactor), 1);
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      target.fillStyle = palette.ink;
      target.font = `900 ${Math.max(5.4 * ratio, size * 0.139)}px sans-serif`;
      target.fillText(String(player.profile.number), 0, 0);
      if (detail && size > 58 * ratio) {
        target.font = `800 ${Math.max(3.1 * ratio, size * 0.045)}px sans-serif`;
        target.fillText(palette.wordmark, 0, -size * 0.085);
      }
      target.restore();
    }
    paintArm(order[1]);

    const skull = headPt(0, 1.888, 0.009);
    const jaw = headPt(0, 1.833, 0.037);
    const skullColor = lit(target, skin, { ...skull, x: skull.x + unit * 0.10, y: skull.y + unit * 0.06 }, { ...skull, x: skull.x - unit * 0.11, y: skull.y - unit * 0.1 });
    disc(target, jaw, unit * 0.076 * headScale, unit * 0.083 * headScale, skullColor);
    disc(target, skull, unit * 0.094 * headScale, unit * 0.11 * headScale, skullColor);
    if (detail) {
      const ear = headPt(acrossCamera >= 0 ? 0.086 : -0.086, 1.87, 0.006);
      disc(target, ear, unit * 0.018 * headScale, unit * 0.028 * headScale, colors(skin)[2]);
    }
    if (hairstyle !== 'shaved') {
      const top = headPt(0, hairstyle === 'curls' || hairstyle === 'afro' ? 1.982 : 1.969, -0.028);
      const hairTint = lit(target, hairColor, { ...top, x: top.x + unit * 0.09 }, { ...top, x: top.x - unit * 0.09 });
      const hairRx = unit * (hairstyle === 'afro' ? 0.145 : hairstyle === 'curls' ? 0.101 : 0.091) * headScale;
      const hairRy = unit * (hairstyle === 'afro' ? 0.118 : hairstyle === 'buzz' ? 0.035 : 0.055) * headScale;
      disc(target, top, hairRx, hairRy, hairTint);
      if (detail && hairstyle === 'curls') {
        for (let curl = 0; curl < 5; curl++) {
          const angle = curl * 2.399;
          disc(target, headPt(Math.cos(angle) * 0.065, 1.993 + (curl % 2) * 0.013, Math.sin(angle) * 0.05 - 0.022), unit * 0.029 * headScale, unit * 0.025 * headScale, hairTint);
        }
      }
      if (detail && (hairstyle === 'braids' || hairstyle === 'locs' || hairstyle === 'long')) {
        for (const side of [-0.05, -0.018, 0.019, 0.05]) line(target, hairColor, unit * (hairstyle === 'locs' ? 0.021 : 0.014) * headScale, headPt(side, 1.976, -0.06), headPt(side, hairstyle === 'long' ? 1.79 : 1.863, -0.105));
      }
    }
    if (detail && towardCamera > 0) {
      const nose = headPt(0, 1.866, 0.108);
      disc(target, nose, unit * 0.016 * headScale, unit * 0.018 * headScale, colors(skin)[0]);
      for (const side of [-1, 1]) line(target, colors(skin)[2], Math.max(0.52, unit * 0.009), headPt(side * 0.025, 1.905, 0.093), headPt(side * 0.063, 1.901, 0.077));
      if (facialHair === 'goatee') {
        disc(target, headPt(0, 1.815, 0.092), unit * 0.028 * headScale, unit * 0.022 * headScale, hairColor);
      } else if (facialHair === 'beard' || facialHair === 'fullBeard') {
        line(target, hairColor, unit * (facialHair === 'fullBeard' ? 0.042 : 0.025) * headScale, headPt(-0.051, 1.843, 0.087), headPt(0, 1.818, 0.086), headPt(0.051, 1.843, 0.087));
      } else if (facialHair === 'stubble') {
        line(target, colors(skin)[2], unit * 0.018 * headScale, headPt(-0.048, 1.843, 0.087), headPt(0, 1.821, 0.086), headPt(0.048, 1.843, 0.087));
      }
    }
    if (detail && headband) line(target, strip, unit * 0.021 * headScale, headPt(-0.088, 1.954, 0.022), headPt(0, 1.948, 0.083), headPt(0.088, 1.954, 0.022));
    picks.push({ id: player.id, x: (ground.x + head.x) / 2, y: (ground.y + head.y) / 2, radius: Math.max(11 * ratio, size * 0.55) });
  }

  function draw(state: GameState, selectedId?: string, hints?: RenderHints) {
    if (!ctx || !background) return;
    const ratio = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : 1);
    const w = Math.round(container.clientWidth * ratio);
    const h = Math.round(container.clientHeight * ratio);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = backdrop.width = w;
      canvas.height = backdrop.height = h;
    }
    camera.aspect = w / h;
    const time = performance.now() / 1000;
    placeCamera(state, view, selectedId, Math.min(0.08, time - lastFrame));
    lastFrame = time;
    const blacktop = state.config.mode === 'blacktop';
    const homeTeam = blacktop ? undefined : state.teams[0];
    const floorKey = blacktop ? 'blacktop' : `team:${homeTeam?.id ?? 'default'}`;
    const nextKey = [w, h, floorKey, view, quality, ...camera.matrixWorld.elements.map((number) => number.toFixed(3))].join(',');
    if (nextKey !== stateKey) {
      paintArena(blacktop, homeTeam);
      stateKey = nextKey;
    }
    ctx.drawImage(backdrop, 0, 0);
    picks = [];
    const ball = state.ball.position;
    const ballGround = project(ball.x, 0.02, ball.z);
    const ballScale = Math.max(2.1 * ratio, Math.abs(ballGround.y - project(ball.x, 0.155, ball.z).y));
    disc(ctx, ballGround, ballScale * (1 + ball.y * 0.14), ballScale * 0.46, `rgba(33,25,9,${0.39 / (1 + ball.y * 0.38)})`);
    if (state.ball.kind === 'shot' || state.ball.kind === 'pass') {
      if (state.tick < lastTrailTick) trailPoints.length = 0;
      if (state.tick !== lastTrailTick) {
        trailPoints.push({ x: ball.x, y: Math.max(0.12, ball.y), z: ball.z });
        if (trailPoints.length > 6) trailPoints.shift();
        lastTrailTick = state.tick;
      }
      for (let i = 0; i < trailPoints.length - 1; i++) {
        const pt = trailPoints[i];
        const center = project(pt.x, pt.y, pt.z);
        const raised = project(pt.x, pt.y + 0.12, pt.z);
        const r = Math.max(1.2 * ratio, Math.hypot(center.x - raised.x, center.y - raised.y)) * (0.45 + (i / 6) * 0.45);
        disc(ctx, center, r, r, `rgba(255,166,82,${((i + 1) / 7 * 0.28).toFixed(3)})`);
      }
    } else {
      trailPoints.length = 0;
    }
    const elapsed = Math.max(0, Math.min(8, state.tick - lastBallTick)) / TICK_RATE;
    if (state.tick < lastBallTick) ballRoll = 0;
    const { spin } = state.ball as typeof state.ball & { spin?: Vec3 };
    ballRoll = (ballRoll + elapsed * (spin ? spin.x * 0.25 + spin.y * 0.3 + spin.z * 0.72 : state.ball.velocity.x * 0.35 + 3.3)) % (Math.PI * 2);
    lastBallTick = state.tick;
    const recent = motionEvents(state);
    if (actors.size > state.players.length) {
      const lineup = new Set(state.players.map(({ id }) => id));
      for (const id of actors.keys()) if (!lineup.has(id)) actors.delete(id);
    }
    const ordered = state.players.map((player) => {
      const { x, z } = player.position;
      const isPassTarget = hints?.passTargetId === player.id && selectedId !== player.id;
      return { order: project(x, 0, z).depth, paint: () => paintActor(ctx, player, state, selectedId === player.id, ratio, recent.get(player.id), isPassTarget) };
    });
    for (const side of [-1, 1]) {
      ordered.push({ order: project(side * COURT.rimX, 0, 0).depth, paint: () => paintHoop(ctx, side, ratio, state) });
    }
    ordered.push({
      order: project(ball.x, ball.y, ball.z).depth - 0.00002,
      paint() {
        const center = project(ball.x, Math.max(0.12, ball.y), ball.z);
        const raised = project(ball.x, Math.max(0.12, ball.y) + 0.12, ball.z);
        const r = Math.max(1.7 * ratio, Math.hypot(center.x - raised.x, center.y - raised.y));
        if (center.depth < -1 || center.depth > 1) return;
        const glow = ctx.createRadialGradient(center.x - r * 0.35, center.y - r * 0.51, r * 0.02, center.x, center.y, r * 1.13);
        glow.addColorStop(0, '#ffc37c');
        glow.addColorStop(0.48, '#e68539');
        glow.addColorStop(0.86, '#b35020');
        glow.addColorStop(1, '#71311c');
        disc(ctx, center, r, r, glow);
        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate(ballRoll);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.98, r * 0.98, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(-r, r * 0.12);
        ctx.quadraticCurveTo(0, -r * 0.28, r, r * 0.12);
        ctx.moveTo(-r * 0.16, -r);
        ctx.bezierCurveTo(r * 0.52, -r * 0.42, r * 0.46, r * 0.47, -r * 0.22, r);
        ctx.strokeStyle = '#552715c0';
        ctx.lineWidth = Math.max(0.55, r * 0.092);
        ctx.stroke();
        ctx.restore();
      },
    });
    ordered.sort((a, b) => b.order - a.order);
    for (const object of ordered) object.paint();
  }

  return {
    draw,
    setCamera(next) { view = next; },
    projectMove(move) { return courtMovement(camera, move); },
    projectPoint(x, y, z) {
      vector.set(x, y, z).project(camera);
      return {
        x: (vector.x + 1) * container.clientWidth / 2,
        y: (1 - vector.y) * container.clientHeight / 2,
        visible: vector.z >= -1 && vector.z <= 1,
      };
    },
    setQuality(next) { quality = next; },
    pickPlayer(x, y) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return undefined;
      const left = (x - rect.left) * canvas.width / rect.width;
      const top = (y - rect.top) * canvas.height / rect.height;
      let best = Infinity;
      let id: string | undefined;
      for (const pick of picks) {
        const distance = Math.hypot((pick.x - left) * 1.55, pick.y - top);
        if (distance <= pick.radius && distance <= best) {
          id = pick.id;
          best = distance;
        }
      }
      return id;
    },
    dispose() {
      for (const texture of floorTextures.values()) texture.dispose();
      backdrop.width = backdrop.height = 0;
      canvas.remove();
    },
  };
}
