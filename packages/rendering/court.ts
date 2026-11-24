import * as THREE from 'three';
import { COURT } from '../contracts/index.ts';
import type { Team } from '../contracts/index.ts';

function shadeHex(hex: string, factor: number, mixHex?: string, mixRatio = 0) {
  const c = new THREE.Color(hex);
  if (mixHex && mixRatio > 0) c.lerp(new THREE.Color(mixHex), mixRatio);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(0.75, hsl.s), Math.max(0.11, Math.min(0.38, hsl.l * factor)));
  return '#' + c.getHexString();
}

const apron = 1.65;
const length = COURT.length + apron * 2;
const width = COURT.width + apron * 2;

export function seededRandom(seed: number) {
  return () => {
    seed = Math.imul(1664525, seed) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296;
  };
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function canvasTexture(canvas: HTMLCanvasElement, anisotropy = 1) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

export function makeCourtTexture(blacktop: boolean, anisotropy: number, homeTeam?: Team) {
  const density = 64;
  const canvas = makeCanvas(Math.round(length * density), Math.round(width * density));
  const ctx = canvas.getContext('2d')!;
  const random = seededRandom(121);
  const lx = COURT.length / 2;
  const wz = COURT.width / 2;
  const teamApron = !blacktop && homeTeam ? shadeHex(homeTeam.color, 0.42, '#0f1615', 0.35) : '#152c27';
  const teamPaint = !blacktop && homeTeam ? shadeHex(homeTeam.color, 0.72, '#15201e', 0.12) : '#203f37';
  const teamAccent = !blacktop && homeTeam ? homeTeam.accent : '#c49d53';
  ctx.setTransform(canvas.width / length, 0, 0, canvas.height / width, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = blacktop ? '#15232c' : teamApron;
  ctx.fillRect(-length / 2, -width / 2, length, width);

  if (blacktop) {
    ctx.fillStyle = '#465a63';
    ctx.fillRect(-lx, -wz, COURT.length, COURT.width);
    for (let i = 0; i < 7600; i++) {
      ctx.fillStyle = random() < 0.5 ? '#ffffff18' : '#00000025';
      ctx.fillRect(-lx + random() * COURT.length, -wz + random() * COURT.width, 0.006 + random() * 0.055, 0.006 + random() * 0.05);
    }
    ctx.strokeStyle = '#263841';
    ctx.lineWidth = 0.024;
    for (const z of [-5, 4.3]) {
      ctx.beginPath();
      ctx.moveTo(-lx, z);
      ctx.lineTo(lx, z);
      ctx.stroke();
    }
  } else if (homeTeam?.abbreviation.toUpperCase() === 'BOS') {
    const tile = 0.78;
    for (let gx = -lx, col = 0; gx < lx; gx += tile, col++) {
      for (let gz = -wz, row = 0; gz < wz; gz += tile, row++) {
        const tw = Math.min(tile, lx - gx);
        const th = Math.min(tile, wz - gz);
        const horiz = (row + col) % 2 === 0;
        const baseL = 67 + ((row * 3 + col * 5) % 6) * 1.4;
        for (let s = 0; s < 5; s++) {
          const stripL = baseL + (random() - 0.5) * 4.5 + (horiz ? 1.8 : -1.5);
          ctx.fillStyle = `hsl(${35 + random() * 4} ${52 + random() * 8}% ${stripL}%)`;
          if (horiz) ctx.fillRect(gx, gz + (s / 5) * th, tw, th / 5);
          else ctx.fillRect(gx + (s / 5) * tw, gz, tw / 5, th);
        }
        ctx.strokeStyle = '#51321e28';
        ctx.lineWidth = 0.012;
        ctx.strokeRect(gx, gz, tw, th);
      }
    }
    const varnish = ctx.createLinearGradient(-lx, -wz, lx, wz);
    varnish.addColorStop(0, '#96612720');
    varnish.addColorStop(0.45, '#fff6d224');
    varnish.addColorStop(1, '#75441722');
    ctx.fillStyle = varnish;
    ctx.fillRect(-lx, -wz, COURT.length, COURT.width);
  } else {
    for (let row = 0, z = -wz; z < wz; row++, z += 0.145) {
      const h = Math.min(0.145, wz - z);
      let x = -lx;
      while (x < lx) {
        const w = Math.min(row % 2 === 0 && x === -lx ? 0.5 + random() * 1.5 : 1.25 + random() * 3.5, lx - x);
        const lightness = 68 + random() * 9 + 2.2 * Math.sin(row * 0.43);
        ctx.fillStyle = `hsl(${35 + random() * 5} ${53 + random() * 10}% ${lightness}%)`;
        ctx.fillRect(x, z, w, h);
        ctx.fillStyle = '#51321e2b';
        ctx.fillRect(x, z, w, 0.01);
        ctx.fillRect(x, z, 0.012, h);
        for (let i = 0; i < 5; i++) {
          const grainZ = z + h * random();
          const grainX = x + w * random();
          const grainW = (x + w - grainX) * random();
          ctx.strokeStyle = i % 2 ? '#532c181b' : '#fff0bb32';
          ctx.lineWidth = 0.003 + random() * 0.008;
          ctx.beginPath();
          ctx.moveTo(grainX, grainZ);
          ctx.bezierCurveTo(grainX + grainW * 0.22, grainZ + 0.029, grainX + grainW * 0.73, grainZ - 0.012, grainX + grainW, grainZ);
          ctx.stroke();
        }
        x += w;
      }
    }
    // Two-tone warm stain inside each three-point arc
    for (const sign of [-1, 1]) {
      ctx.save();
      ctx.scale(sign, 1);
      const corner = wz - 0.9;
      const angle = Math.asin(corner / COURT.three);
      const endpoint = COURT.rimX - Math.sqrt(COURT.three ** 2 - corner ** 2);
      ctx.beginPath();
      ctx.moveTo(lx, -corner);
      ctx.lineTo(endpoint, -corner);
      ctx.arc(COURT.rimX, 0, COURT.three, Math.PI + angle, Math.PI - angle, true);
      ctx.lineTo(lx, corner);
      ctx.closePath();
      ctx.fillStyle = 'rgba(130, 74, 24, 0.075)';
      ctx.fill();
      ctx.restore();
    }
    const varnish = ctx.createLinearGradient(-lx, -wz, lx, wz);
    varnish.addColorStop(0, '#96612722');
    varnish.addColorStop(0.45, '#fff6d220');
    varnish.addColorStop(1, '#75441724');
    ctx.fillStyle = varnish;
    ctx.fillRect(-lx, -wz, COURT.length, COURT.width);
  }

  const ink = blacktop ? '#cbdfd9' : '#f8eed4';
  const paint = blacktop ? '#294e50' : teamPaint;
  if (!blacktop) {
    ctx.strokeStyle = homeTeam ? teamAccent : '#829b77';
    ctx.lineWidth = 0.025;
    ctx.strokeRect(-lx - 0.24, -wz - 0.24, COURT.length + 0.48, COURT.width + 0.48);
    ctx.strokeStyle = '#a08b5d';
    ctx.strokeRect(-length / 2 + 0.19, -width / 2 + 0.19, length - 0.38, width - 0.38);
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.065;
  for (const sign of [-1, 1]) {
    ctx.save();
    ctx.scale(sign, 1);
    const laneX = lx - 5.79;
    const laneZ = 2.45;
    if (blacktop) ctx.fillStyle = paint;
    else {
      const lane = ctx.createLinearGradient(laneX, -laneZ, lx, laneZ);
      lane.addColorStop(0, homeTeam ? shadeHex(homeTeam.color, 0.85, '#1b2623', 0.08) : '#294b40');
      lane.addColorStop(0.5, paint);
      lane.addColorStop(1, homeTeam ? shadeHex(homeTeam.color, 0.58, '#101816', 0.2) : '#18362d');
      ctx.fillStyle = lane;
    }
    ctx.fillRect(laneX, -laneZ, lx - laneX, laneZ * 2);
    if (!blacktop) {
      ctx.fillStyle = '#d5ddae0c';
      for (let z = -laneZ; z < laneZ; z += 0.145) ctx.fillRect(laneX, z, lx - laneX, 0.009);
    }
    ctx.strokeRect(laneX, -laneZ, lx - laneX, laneZ * 2);

    ctx.beginPath();
    ctx.arc(laneX, 0, 1.83, Math.PI / 2, 3 * Math.PI / 2);
    ctx.stroke();
    ctx.setLineDash([0.23, 0.16]);
    ctx.beginPath();
    ctx.arc(laneX, 0, 1.83, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(COURT.rimX, 0, 1.22, Math.PI / 2, Math.PI * 1.5);
    ctx.stroke();
    for (const x of [laneX + 0.85, laneX + 1.9, laneX + 2.9, laneX + 3.9]) {
      ctx.beginPath();
      ctx.moveTo(x, -laneZ - 0.14);
      ctx.lineTo(x, -laneZ);
      ctx.moveTo(x, laneZ);
      ctx.lineTo(x, laneZ + 0.14);
      ctx.stroke();
    }

    const corner = wz - 0.9;
    const angle = Math.asin(corner / COURT.three);
    const endpoint = COURT.rimX - Math.sqrt(COURT.three ** 2 - corner ** 2);
    ctx.beginPath();
    ctx.moveTo(lx, -corner);
    ctx.lineTo(endpoint, -corner);
    ctx.arc(COURT.rimX, 0, COURT.three, Math.PI + angle, Math.PI - angle, true);
    ctx.lineTo(lx, corner);
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeRect(-lx, -wz, COURT.length, COURT.width);
  ctx.beginPath();
  ctx.moveTo(0, -wz);
  ctx.lineTo(0, wz);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 1.83, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = paint;
  ctx.beginPath();
  ctx.arc(0, 0, 1.78, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = blacktop ? '#a4beb5' : teamAccent;
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  ctx.arc(0, 0, 1.62, 0, Math.PI * 2);
  ctx.stroke();
  if (!blacktop && homeTeam) {
    // Basketball seam medallion silhouette behind team monogram
    ctx.save();
    ctx.strokeStyle = teamAccent;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.arc(0, 0, 1.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-1.25, 0);
    ctx.lineTo(1.25, 0);
    ctx.moveTo(-0.78, -0.96);
    ctx.quadraticCurveTo(0, 0, -0.78, 0.96);
    ctx.moveTo(0.78, -0.96);
    ctx.quadraticCurveTo(0, 0, 0.78, 0.96);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#f8f2e4';
    ctx.strokeStyle = '#0f1216';
    ctx.lineWidth = 0.07;
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${homeTeam.abbreviation.length > 3 ? 0.98 : 1.24}px sans-serif`;
    ctx.strokeText(homeTeam.abbreviation, 0, 0.04, 2.7);
    ctx.fillText(homeTeam.abbreviation, 0, 0.04, 2.7);
  } else {
    ctx.beginPath();
    ctx.moveTo(-0.77, -0.76);
    ctx.lineTo(-0.32, -0.76);
    ctx.lineTo(-0.49, -0.15);
    ctx.lineTo(0.27, -0.15);
    ctx.lineTo(0.44, -0.76);
    ctx.lineTo(0.89, -0.76);
    ctx.lineTo(0.48, 0.68);
    ctx.lineTo(0.03, 0.68);
    ctx.lineTo(0.19, 0.13);
    ctx.lineTo(-0.57, 0.13);
    ctx.lineTo(-0.73, 0.68);
    ctx.lineTo(-1.18, 0.68);
    ctx.fill();
  }

  if (!blacktop) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-lx, -wz, COURT.length, COURT.width);
    ctx.clip();
    for (const x of [-11.2, -7.6, -3.8, 0, 3.8, 7.6, 11.2]) {
      for (const z of [-6.25, 3.8]) {
        ctx.save();
        ctx.translate(x, z);
        ctx.scale(1.55, 0.52);
        const reflection = ctx.createRadialGradient(0, 0, 0.04, 0, 0, 1.43);
        reflection.addColorStop(0, '#fff7d774');
        reflection.addColorStop(0.23, '#fff4d653');
        reflection.addColorStop(0.58, '#ffeac82d');
        reflection.addColorStop(1, '#fff4d600');
        ctx.fillStyle = reflection;
        ctx.fillRect(-1.45, -1.45, 2.9, 2.9);
        ctx.restore();
      }
    }
    for (const x of [-8.4, 0, 8.4]) {
      ctx.save();
      ctx.translate(x, -4.8);
      ctx.scale(1.5, 0.92);
      const wash = ctx.createRadialGradient(0, 0, 0.1, 0, 0, 3.2);
      wash.addColorStop(0, '#fff0c536');
      wash.addColorStop(0.42, '#ffeab622');
      wash.addColorStop(1, '#fff2cf00');
      ctx.fillStyle = wash;
      ctx.fillRect(-3.2, -3.2, 6.4, 6.4);
      ctx.restore();
    }
    for (let i = 0; i < 340; i++) {
      const x = (random() * 2 - 1) * lx;
      const z = (random() * 2 - 1) * wz;
      ctx.strokeStyle = i % 3 === 0 ? '#54382026' : '#faf0d52a';
      ctx.lineWidth = 0.008 + random() * 0.015;
      ctx.beginPath();
      ctx.moveTo(x, z);
      ctx.quadraticCurveTo(x + random() * 0.075, z + random() * 0.06, x + random() * 0.12, z + random() * 0.10);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 1px sans-serif';
  const leftBaseline = blacktop ? 'BLACKTOP' : homeTeam ? homeTeam.city.toUpperCase() : 'HARDWOOD';
  const rightBaseline = blacktop ? 'STREETBALL' : homeTeam ? homeTeam.name.toUpperCase() : 'DYNASTY';
  for (const [side, title] of [[-1, leftBaseline], [1, rightBaseline]] as const) {
    ctx.save();
    ctx.translate(side * (lx + 0.76), 0);
    ctx.rotate(side * Math.PI / 2);
    ctx.fillStyle = blacktop ? '#cce3d7' : '#ead2a0';
    ctx.fillText(title, 0, 0, COURT.width - 1.5);
    ctx.restore();
  }
  ctx.fillStyle = blacktop ? '#749d96' : '#a4814a';
  ctx.fillRect(-lx, -wz - 0.45, 9.6, 0.035);
  ctx.fillRect(lx - 9.6, wz + 0.45, 9.6, 0.035);
  return canvasTexture(canvas, anisotropy);
}

export function makeCourtMaps(blacktop: boolean, anisotropy: number, parquet = false) {
  const bCanvas = makeCanvas(256, 256);
  const rCanvas = makeCanvas(256, 256);
  const bCtx = bCanvas.getContext('2d')!;
  const rCtx = rCanvas.getContext('2d')!;
  if (blacktop) {
    const random = seededRandom(33);
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, 256, 256);
    rCtx.fillStyle = '#dedede';
    rCtx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2400; i++) {
      bCtx.fillStyle = i % 2 ? '#b8b8b8' : '#4a4a4a';
      bCtx.fillRect(random() * 256, random() * 256, 2, 2);
    }
  } else if (parquet) {
    bCtx.fillStyle = '#bdbdbd';
    bCtx.fillRect(0, 0, 256, 256);
    rCtx.fillStyle = '#707070';
    rCtx.fillRect(0, 0, 256, 256);
    for (let gy = 0; gy < 256; gy += 64) {
      for (let gx = 0; gx < 256; gx += 64) {
        const horiz = ((gx + gy) / 64) % 2 === 0;
        rCtx.fillStyle = horiz ? '#626262' : '#7c7c7c';
        rCtx.fillRect(gx, gy, 64, 64);
        bCtx.fillStyle = '#606060';
        for (let s = 0; s < 64; s += 16) {
          if (horiz) bCtx.fillRect(gx, gy + s, 64, 2);
          else bCtx.fillRect(gx + s, gy, 2, 64);
        }
        bCtx.fillRect(gx, gy, 64, 2);
        bCtx.fillRect(gx, gy, 2, 64);
      }
    }
  } else {
    bCtx.fillStyle = '#c8c8c8';
    bCtx.fillRect(0, 0, 256, 256);
    rCtx.fillStyle = '#6c6c6c';
    rCtx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 16) {
      bCtx.fillStyle = '#606060';
      bCtx.fillRect(0, y, 256, 2);
      rCtx.fillStyle = (y / 16) % 2 === 0 ? '#656565' : '#787878';
      rCtx.fillRect(0, y + 2, 256, 14);
      const join = ((y / 16) * 73) % 256;
      bCtx.fillRect(join, y, 2, 16);
    }
  }
  const setup = (c: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = anisotropy;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 5);
    return tex;
  };
  return { bumpMap: setup(bCanvas), roughnessMap: setup(rCanvas) };
}

export function makeCourt() {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.34,
    bumpScale: 0.006,
    metalness: 0,
    side: THREE.FrontSide,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(length, width), material);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  return floor;
}

export function makeBall(anisotropy: number) {
  const canvas = makeCanvas(512, 256);
  const bumpCanvas = makeCanvas(512, 256);
  const ctx = canvas.getContext('2d')!;
  const bCtx = bumpCanvas.getContext('2d')!;
  const random = seededRandom(6);
  ctx.fillStyle = '#d27128';
  ctx.fillRect(0, 0, 512, 256);
  bCtx.fillStyle = '#909090';
  bCtx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 4200; i++) {
    const px = random() * 512;
    const py = random() * 256;
    ctx.fillStyle = i % 2 ? '#3d170e22' : '#ffd29f40';
    ctx.fillRect(px, py, 1.7, 1.7);
    bCtx.fillStyle = i % 2 ? '#e0e0e0' : '#4a4a4a';
    bCtx.fillRect(px, py, 1.6, 1.6);
  }
  ctx.strokeStyle = '#341b13';
  ctx.lineWidth = 5;
  bCtx.strokeStyle = '#181818';
  bCtx.lineWidth = 6;
  for (const x of [0, 128, 256, 384, 512]) {
    for (const c of [ctx, bCtx]) {
      c.beginPath();
      c.moveTo(x, 0);
      c.bezierCurveTo(x - 42, 74, x + 42, 182, x, 256);
      c.stroke();
    }
  }
  for (const c of [ctx, bCtx]) {
    c.beginPath();
    c.moveTo(0, 128);
    c.lineTo(512, 128);
    c.stroke();
  }
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.anisotropy = anisotropy;

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.122, 24, 16),
    new THREE.MeshStandardMaterial({
      map: canvasTexture(canvas, anisotropy),
      bumpMap,
      bumpScale: 0.004,
      roughness: 0.52,
    }),
  );
  ball.castShadow = true;
  return ball;
}
