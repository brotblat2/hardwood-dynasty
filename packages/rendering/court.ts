import * as THREE from 'three';
import { COURT } from '../contracts/index.ts';

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

export function makeCourtTexture(blacktop: boolean, anisotropy: number) {
  const density = 90;
  const canvas = makeCanvas(Math.round(length * density), Math.round(width * density));
  const ctx = canvas.getContext('2d')!;
  const random = seededRandom(121);
  const lx = COURT.length / 2;
  const wz = COURT.width / 2;
  ctx.setTransform(canvas.width / length, 0, 0, canvas.height / width, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = blacktop ? '#15232c' : '#172724';
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
  } else {
    for (let row = 0, z = -wz; z < wz; row++, z += 0.145) {
      const h = Math.min(0.145, wz - z);
      let x = -lx;
      while (x < lx) {
        const w = Math.min(row % 2 === 0 && x === -lx ? 0.5 + random() * 1.5 : 1.25 + random() * 3.5, lx - x);
        const lightness = 66 + random() * 10 + 2.5 * Math.sin(row * 0.43);
        ctx.fillStyle = `hsl(${33 + random() * 6} ${56 + random() * 9}% ${lightness}%)`;
        ctx.fillRect(x, z, w, h);
        ctx.fillStyle = '#51321e24';
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
    const varnish = ctx.createLinearGradient(-lx, -wz, lx, wz);
    varnish.addColorStop(0, '#ae6e1922');
    varnish.addColorStop(0.45, '#fff8b519');
    varnish.addColorStop(1, '#75441729');
    ctx.fillStyle = varnish;
    ctx.fillRect(-lx, -wz, COURT.length, COURT.width);
  }

  const ink = blacktop ? '#cbdfd9' : '#f9e9c2';
  const paint = blacktop ? '#294e50' : '#243d32';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.065;
  for (const sign of [-1, 1]) {
    ctx.save();
    ctx.scale(sign, 1);
    const laneX = lx - 5.79;
    const laneZ = 2.45;
    ctx.fillStyle = paint;
    ctx.fillRect(laneX, -laneZ, lx - laneX, laneZ * 2);
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
  ctx.arc(0, 0, 1.76, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = blacktop ? '#a4beb5' : '#c49d53';
  ctx.lineWidth = 0.035;
  ctx.beginPath();
  ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = ink;
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

  if (!blacktop) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-lx, -wz, COURT.length, COURT.width);
    ctx.clip();
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
    ctx.restore();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 1px sans-serif';
  for (const [side, title] of [[-1, blacktop ? 'BLACKTOP' : 'HARDWOOD'], [1, blacktop ? 'STREETBALL' : 'DYNASTY']] as const) {
    ctx.save();
    ctx.translate(side * (lx + 0.76), 0);
    ctx.rotate(side * Math.PI / 2);
    ctx.fillStyle = blacktop ? '#cce3d7' : '#ead2a0';
    ctx.fillText(title, 0, 0);
    ctx.restore();
  }
  ctx.fillStyle = blacktop ? '#749d96' : '#a4814a';
  ctx.fillRect(-lx, -wz - 0.45, 9.6, 0.035);
  ctx.fillRect(lx - 9.6, wz + 0.45, 9.6, 0.035);
  return canvasTexture(canvas, anisotropy);
}

export function makeCourt() {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.62,
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
  const ctx = canvas.getContext('2d')!;
  const random = seededRandom(6);
  ctx.fillStyle = '#d27128';
  ctx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 3400; i++) {
    ctx.fillStyle = i % 2 ? '#3d170e22' : '#ffd29f40';
    ctx.fillRect(random() * 512, random() * 256, 1.7, 1.7);
  }
  ctx.strokeStyle = '#341b13';
  ctx.lineWidth = 5;
  for (const x of [0, 128, 256, 384, 512]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x - 42, 74, x + 42, 182, x, 256);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, 128);
  ctx.lineTo(512, 128);
  ctx.stroke();

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.122, 20, 14),
    new THREE.MeshStandardMaterial({ map: canvasTexture(canvas, anisotropy), roughness: 0.78 }),
  );
  ball.castShadow = true;
  return ball;
}
