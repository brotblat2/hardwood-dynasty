import { PerspectiveCamera, Vector3 } from 'three';
import { COURT, TICK_RATE } from '../contracts/index.ts';
import type { GamePlayer, GameState } from '../contracts/index.ts';
import { makeCourtTexture, seededRandom } from './court.ts';
import { courtMovement } from './input-view.ts';
import { appearanceFor } from './appearance.ts';
import type { Camera, GameRenderer, RendererOptions } from './index.ts';

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
  const floorTextures = new Map<boolean, ReturnType<typeof makeCourtTexture>>();
  const camera = new PerspectiveCamera(39, 1, 0.12, 120);
  const vector = new Vector3();
  let view: Camera = options.camera ?? 'broadcast';
  let quality = options.quality ?? 'high';
  let stateKey = '';
  let picks: { id: string; x: number; y: number; radius: number }[] = [];

  function project(x: number, y: number, z: number): Point {
    vector.set(x, y, z).project(camera);
    return { x: (vector.x + 1) * canvas.width / 2, y: (1 - vector.y) * canvas.height / 2, depth: vector.z };
  }

  function shape(target: CanvasRenderingContext2D, color: string, ...points: Point[]) {
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

  function disc(target: CanvasRenderingContext2D, center: Point, x: number, y: number, color: string, stroke?: string) {
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

  function fitCamera(state: GameState, selectedId?: string) {
    const half = state.config.halfCourt === true;
    const focus = half ? 7.1 : 0;
    const zoom = Math.max(1, 1.63 / camera.aspect);
    const ball = state.ball.position;
    if (view === 'baseline') {
      camera.fov = 43;
      camera.position.set(focus + 25.5 * zoom, 16 * zoom, 15.5 * zoom);
    } else if (view === 'courtside') {
      camera.fov = 48;
      camera.position.set(focus + 1.6, 8.2 * zoom, 20 * zoom);
    } else if (view === 'player') {
      const carrier = state.players.find((player) => player.id === selectedId)?.position ?? ball;
      const follow = Math.round(carrier.x * 2) / 2;
      camera.fov = 52;
      camera.position.set(follow - 4.0, 6.1 * zoom, 13.8 * zoom);
      camera.lookAt(follow, 0.8, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      return;
    } else if (view === 'cinematic') {
      camera.fov = 42;
      camera.position.set(focus + 9.4 * zoom, 11.5 * zoom, 22.4 * zoom);
    } else {
      camera.fov = 39;
      const spread = half ? Math.max(0.91, zoom * 0.78) : zoom;
      camera.position.set(focus, 21.8 * spread, 24.8 * spread);
    }
    camera.lookAt(focus, 0.25, -0.12);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function paintTriangle(target: CanvasRenderingContext2D, image: HTMLCanvasElement, p: Point, q: Point, r: Point, a: SourcePoint, b: SourcePoint, c: SourcePoint) {
    if ([p, q, r].some(({ depth }) => depth < -1 || depth > 1)) return;
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
    target.drawImage(image, 0, 0);
    target.restore();
  }

  function paintArena(blacktop: boolean) {
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
      for (const y of [4.9, 5.14]) {
        line(target, '#8d9b733d', 1.7, project(-23, y, -16), project(23, y, -16));
      }
      for (let row = 9; row >= 0; row--) {
        const y = row * 0.43;
        const z = -9.65 - row * 0.65;
        shape(target, row % 2 === 0 ? '#273632' : '#202d2a', project(-17, y - 0.42, z), project(-17, y + 0.12, z), project(17, y + 0.12, z), project(17, y - 0.42, z));
        for (let x = -16.4; x <= 16.4; x += 0.47) {
          if (random() < 0.23 || Math.abs(x - Math.round(x / 6.5) * 6.5) < 0.34) continue;
          const headY = y + 0.56 + random() * 0.13;
          const head = project(x, headY, z);
          const shoulder = project(x, headY - 0.27, z);
          const unit = Math.max(0.85, Math.abs(head.y - shoulder.y) * 0.41);
          const top = spectatorTops[Math.floor(random() * spectatorTops.length)];
          const shift = 0.13 * Math.sin(x * 3 + row * 0.73);
          const shoulderLeft = project(x - 0.11, headY - 0.22 + shift * 0.4, z);
          const shoulderRight = project(x + 0.11, headY - 0.22 - shift * 0.4, z);
          line(target, top, unit * 1.8, shoulderLeft, shoulder, shoulderRight);
          disc(target, shoulder, 1.24 * unit, 1.41 * unit, top);
          disc(target, head, unit * 0.67, unit * 0.78, skinTones[Math.floor(random() * skinTones.length)]);
        }
      }
      const left = project(-14.9, 0.2, -9.03);
      const right = project(14.9, 0.2, -9.03);
      shape(target, '#181f1b', left, project(-14.9, 0.86, -9.03), project(14.9, 0.86, -9.03), right);
      line(target, '#709785', 1.2, project(-14.9, 0.83, -9.025), project(14.9, 0.83, -9.025));
      target.fillStyle = '#9dab86';
      target.font = `bold ${Math.max(8, canvas.height * 0.013)}px sans-serif`;
      target.textAlign = 'center';
      for (const x of [-10.5, -3.5, 3.5, 10.5]) {
        const label = project(x, 0.46, -9.02);
        target.fillText('HARDWOOD DYNASTY', label.x, label.y);
      }
    }
    if (!floorTextures.has(blacktop)) floorTextures.set(blacktop, makeCourtTexture(blacktop, 1));
    const image = floorTextures.get(blacktop)!.image as HTMLCanvasElement;
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

  function paintHoop(target: CanvasRenderingContext2D, side: number, ratio: number) {
    const rimX = side * COURT.rimX;
    const board = rimX + side * 0.39;
    const pole = side * 15.76;
    const h = COURT.rimHeight;
    const weight = Math.max(1.1, Math.abs(project(pole, 0, 0).y - project(pole, 2.2, 0).y) / 21);
    line(target, '#1b2623', weight * 2.5, project(pole, 0.04, -0.38), project(pole, 0.04, 0.38));
    line(target, '#849894', weight, project(pole, 1.62, 0), project(pole, h + 0.32, 0), project(board, h + 0.32, 0));
    line(target, '#2b5245', weight * 2.5, project(pole, 0.075, 0), project(pole, 2.09, 0));
    const corners = [project(board, h - 0.07, -0.9), project(board, h + 0.98, -0.9), project(board, h + 0.98, 0.9), project(board, h - 0.07, 0.9)];
    shape(target, '#9ab5a646', ...corners);
    line(target, '#e3e4cc', ratio * 1.15, ...corners, corners[0]);
    const rectangle = [project(board, h + 0.035, -0.279), project(board, h + 0.48, -0.279), project(board, h + 0.48, 0.279), project(board, h + 0.035, 0.279)];
    line(target, '#e7dfc5', ratio * 0.85, ...rectangle, rectangle[0]);
    line(target, '#bd4f2e', weight * 0.75, project(board, h, 0), project(rimX + side * 0.22, h, 0));
    const rim: Point[] = [];
    for (let i = 0; i <= 16; i++) {
      const angle = i / 16 * Math.PI * 2;
      rim.push(project(rimX + 0.235 * Math.cos(angle), h, 0.235 * Math.sin(angle)));
      if (i % 2 === 0) {
        for (const turn of [-0.33, 0.33]) {
          const middle = project(rimX + 0.173 * Math.cos(angle + turn), h - 0.27, 0.173 * Math.sin(angle + turn));
          line(target, '#f6edd0ac', ratio * 0.63, rim[i], middle, project(rimX + 0.125 * Math.cos(angle), h - 0.43, 0.125 * Math.sin(angle)));
        }
      }
    }
    line(target, '#eb6440', ratio * 1.25, ...rim);
  }

  function paintPlayer(target: CanvasRenderingContext2D, player: GamePlayer, state: GameState, selected: boolean, ratio: number) {
    const { x, z } = player.position;
    const ground = project(x, 0, z);
    const head = project(x, 2, z);
    if (ground.depth > 1 || ground.depth < -1 || ground.x < -120 || ground.x > canvas.width + 120) return;
    const size = Math.max(8, Math.hypot(head.x - ground.x, head.y - ground.y));
    const { stature, thickness, skin, hair: hairstyle, hash } = appearanceFor(player.profile);
    const width = Math.max(1.6, size / 12) * thickness;
    const headWidth = width / thickness;
    const scale = stature / 2.02;
    const facing = player.facing;
    const fx = Math.cos(facing);
    const fz = Math.sin(facing);
    const team = state.teams[player.side];
    const jersey = player.side === 0 ? team.color : '#eee9d7';
    const strip = player.side === 0 ? team.accent : team.color;
    const speed = Math.min(1, Math.hypot(player.velocity.x, player.velocity.z) / 5.5);
    const cycle = state.tick / TICK_RATE * (12 + speed * 5) + player.profile.number * 0.48;
    const charge = state.charge[player.id] ?? 0;
    const raising = player.pose === 'shoot' || player.pose === 'contest' || charge > 0;
    const screen = player.pose === 'screen';
    const bounce = speed * (0.025 * Math.sin(2 * cycle) - 0.045) + (raising && charge <= 0 ? 0.1 : 0);
    const at = (side: number, y: number, forward: number) => project(x + scale * (-side * thickness * fz + forward * fx), scale * (y + bounce), z + scale * (side * thickness * fx + forward * fz));

    const baseWidth = Math.max(ratio * 5, size * 0.19);
    disc(target, ground, baseWidth * 1.16, baseWidth * 0.45, '#14150c50');
    if (selected) {
      const marker: Point[] = [];
      const steps = 30;
      for (let i = 0; i <= steps; i++) {
        const arc = i / steps * Math.PI * 2;
        marker.push(project(x + 0.49 * Math.cos(arc), 0.025, z + 0.49 * Math.sin(arc)));
      }
      line(target, '#d9f99a', ratio * 1.65, ...marker);
      if (charge > 0) line(target, Math.abs(charge - 0.62) < 0.085 ? '#f1ffe2' : '#ffc763', ratio * 2.7, ...marker.slice(0, 2 + Math.floor(Math.min(1, charge / 1.2) * (steps - 1))));
    }

    const signs = [1, -1].sort((a, b) => at(b * 0.28, 1.4, 0).depth - at(a * 0.28, 1.4, 0).depth);
    const paintArm = (sign: number) => {
      const stride = Math.sin(cycle + (sign === 1 ? 0 : Math.PI)) * speed * 0.36;
      const dribble = state.ball.ownerId === player.id && sign === 1;
      const shoulder = at(sign * 0.235, 1.57, 0.015);
      const elbow = at(sign * (raising ? 0.31 : 0.277), raising ? 1.8 : 1.32, raising ? 0.19 : dribble ? 0.2 : -stride * 0.65);
      const hand = at(sign * (raising ? 0.155 : 0.28), raising ? 2.01 : dribble ? 1.04 : 1.12, raising ? 0.26 : dribble ? 0.35 : -stride + 0.04);
      line(target, '#263029', width * 0.98, shoulder, elbow, hand);
      line(target, skin, width * 0.81, shoulder, elbow, hand);
      disc(target, hand, width * 0.43, width * 0.46, skin);
    };
    for (const sign of signs) {
      const phase = cycle + (sign > 0 ? 0 : Math.PI);
      const step = Math.sin(phase) * speed * 0.36;
      const lift = Math.max(0, Math.cos(phase)) * speed * 0.17;
      const hip = at(sign * 0.122, 1.06, 0);
      const knee = at(sign * (screen ? 0.29 : 0.145), 0.54 + lift * 0.32, 0.075 + step * 0.62);
      const ankle = at(sign * (screen ? 0.34 : 0.16), 0.12 + lift, step);
      const toe = at(sign * (screen ? 0.34 : 0.16), 0.079 + lift, step + 0.175);
      line(target, '#27302c', width * 1.25, hip, knee, ankle);
      line(target, skin, width * 0.77, knee, ankle);
      line(target, jersey, width * 1.12, hip, at(sign * 0.141, 0.68 + lift * 0.24, 0.065 + step * 0.5));
      line(target, '#39403c', width * 1.03, ankle, toe);
      line(target, hash % 3 === 1 ? '#bcc1ad' : '#e3e4d5', width * 0.74, ankle, toe);
    }

    paintArm(signs[0]);
    const chestLeft = at(-0.23, 1.61, 0);
    const chestRight = at(0.23, 1.61, 0);
    const leftHip = at(-0.157, 1.08, 0);
    const rightHip = at(0.157, 1.08, 0);
    const torsoTop = at(0, 1.57, 0);
    const torsoBottom = at(0, 1.12, 0);
    line(target, '#26322e', width * 2.37, torsoTop, torsoBottom);
    line(target, jersey, width * 1.96, torsoTop, torsoBottom);
    shape(target, jersey, chestLeft, chestRight, rightHip, leftHip);
    line(target, strip, width * 0.35, at(-0.12, 1.65, 0.025), at(0, 1.58, 0.05), at(0.12, 1.65, 0.025));
    line(target, strip, width * 0.22, at(-0.18, 1.53, 0), leftHip);
    line(target, strip, width * 0.22, at(0.18, 1.53, 0), rightHip);
    paintArm(signs[1]);
    const skull = at(0, 1.86, 0);
    line(target, skin, headWidth * 0.6, at(0, 1.63, 0), skull);
    disc(target, at(0, 1.83, 0.018), headWidth * 0.45, headWidth * 0.49, skin);
    disc(target, skull, headWidth * 0.56, headWidth * 0.75, skin);
    if (hairstyle !== 'shaved') {
      const hair = at(0, hairstyle === 'curls' ? 1.981 : 1.951, -0.027);
      disc(target, hair, headWidth * 0.56, headWidth * (hairstyle === 'buzz' ? 0.27 : 0.41), '#302722');
      if (hairstyle === 'braids') {
        line(target, '#302722', headWidth * 0.19, hair, at(-0.038, 1.83, -0.112));
        line(target, '#302722', headWidth * 0.19, hair, at(0.043, 1.83, -0.112));
      }
    }
    if (size > 44 && (camera.position.x - x) * fx + (camera.position.z - z) * fz > 0) {
      disc(target, at(0, 1.86, 0.108), headWidth * 0.15, headWidth * 0.17, skin);
      for (const side of [-1, 1]) {
        line(target, '#392a25', headWidth * 0.09, at(side * 0.023, 1.903, 0.092), at(side * 0.065, 1.905, 0.077));
      }
    }
    const number = at(0, 1.39, 0.08);
    target.font = `900 ${Math.max(5 * ratio, size * 0.167)}px sans-serif`;
    target.textAlign = 'center';
    target.textBaseline = 'middle';
    target.fillStyle = player.side === 0 ? '#faf2da' : '#1e2929';
    target.fillText(String(player.profile.number), number.x, number.y);
    picks.push({ id: player.id, x: (ground.x + head.x) / 2, y: (ground.y + head.y) / 2, radius: Math.max(11 * ratio, size * 0.55) });
  }

  function draw(state: GameState, selectedId?: string) {
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
    fitCamera(state, selectedId);
    const blacktop = state.config.mode === 'blacktop';
    const nextKey = [w, h, blacktop, view, quality, ...camera.position.toArray()].join(',');
    if (nextKey !== stateKey) {
      paintArena(blacktop);
      stateKey = nextKey;
    }
    ctx.drawImage(backdrop, 0, 0);
    picks = [];
    const ball = state.ball.position;
    const ballGround = project(ball.x, 0.02, ball.z);
    disc(ctx, ballGround, 3.7 * ratio, 1.65 * ratio, '#2119096b');
    const ordered = state.players.map((player) => {
      const { x, z } = player.position;
      return { order: project(x, 0, z).depth, paint: () => paintPlayer(ctx, player, state, selectedId === player.id, ratio) };
    });
    for (const side of [-1, 1]) {
      ordered.push({ order: project(side * COURT.rimX, 0, 0).depth, paint: () => paintHoop(ctx, side, ratio) });
    }
    ordered.push({
      order: ballGround.depth - 0.0001,
      paint() {
        const center = project(ball.x, Math.max(0.12, ball.y), ball.z);
        const raised = project(ball.x, Math.max(0.12, ball.y) + 0.12, ball.z);
        const r = Math.max(1.7 * ratio, Math.hypot(center.x - raised.x, center.y - raised.y));
        disc(ctx, center, r, r, '#dc7a33', '#633317');
        if (center.depth >= -1 && center.depth <= 1) {
          ctx.beginPath();
          ctx.moveTo(center.x - r * 0.88, center.y);
          ctx.quadraticCurveTo(center.x, center.y - r * 0.5, center.x + r * 0.85, center.y + r * 0.25);
          ctx.strokeStyle = '#784020';
          ctx.lineWidth = Math.max(0.55, ratio * 0.5);
          ctx.stroke();
        }
      },
    });
    ordered.sort((a, b) => b.order - a.order);
    for (const object of ordered) object.paint();
  }

  return {
    draw,
    setCamera(next) { view = next; },
    projectMove(move) { return courtMovement(camera, move); },
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
