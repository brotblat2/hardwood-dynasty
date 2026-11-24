import * as THREE from 'three';
import { COURT } from '../contracts/index.ts';
import { canvasTexture, seededRandom } from './court.ts';
import { mergeStaticMeshes } from './geometry.ts';

function box(parent: THREE.Object3D, material: THREE.Material, size: [number, number, number], x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

export function makeHoops() {
  const result = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x172629, roughness: 0.62, metalness: 0.26 });
  const padding = new THREE.MeshStandardMaterial({ color: 0x284837, roughness: 0.86 });
  const gray = new THREE.MeshStandardMaterial({ color: 0x93a5a4, roughness: 0.34, metalness: 0.63 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf8f0d7, roughness: 0.5 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xb3cacc, opacity: 0.23, transparent: true, depthWrite: false, roughness: 0.25, metalness: 0.03,
  });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xd85325, metalness: 0.4, roughness: 0.4 });
  for (const sign of [-1, 1]) {
    const rimX = sign * COURT.rimX;
    const h = COURT.rimHeight;
    const boardX = rimX + sign * 0.39;
    const baseX = sign * 15.76;

    box(result, paint, [1.06, 0.16, 1.27], baseX, 0.12, 0);
    box(result, padding, [0.55, 2.18, 0.68], baseX, 1.18, 0);
    box(result, gray, [0.18, 1.34, 0.18], baseX, 2.79, 0);
    box(result, gray, [Math.abs(baseX - boardX), 0.16, 0.17], (boardX + baseX) / 2, 3.36, 0);
    box(result, padding, [0.12, 0.075, 1.9], boardX, h - 0.075, 0);
    const board = box(result, glass, [0.055, 1.055, 1.82], boardX, h + 0.46, 0);
    board.renderOrder = 1;

    for (const y of [h - 0.047, h + 0.97]) box(result, white, [0.062, 0.028, 1.82], boardX, y, 0);
    for (const z of [-0.9, 0.9]) box(result, white, [0.062, 1.035, 0.028], boardX, h + 0.46, z);
    for (const y of [h + 0.035, h + 0.48]) box(result, white, [0.067, 0.025, 0.58], boardX, y, 0);
    for (const z of [-0.278, 0.278]) box(result, white, [0.067, 0.457, 0.025], boardX, h + 0.258, z);
    box(result, rimMaterial, [0.185, 0.037, 0.15], rimX + sign * 0.31, h - 0.017, 0);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.021, 8, 28), rimMaterial);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(rimX, h, 0);
    result.add(rim);

    const coords: number[] = [];
    const rows = 5;
    const sections = 13;
    for (let row = 0; row < rows; row++) {
      const t = row / rows;
      const u = (row + 1) / rows;
      const radius = 0.225 - 0.094 * t;
      const nextRadius = 0.225 - 0.094 * u;
      for (let i = 0; i < sections; i++) {
        const angle = ((i + (row % 2) / 2) / sections) * Math.PI * 2;
        for (const offset of [-0.5, 0.5]) {
          const nextAngle = angle + offset / sections * Math.PI * 2;
          coords.push(
            rimX + Math.cos(angle) * radius, h - t * 0.43, Math.sin(angle) * radius,
            rimX + Math.cos(nextAngle) * nextRadius, h - u * 0.43, Math.sin(nextAngle) * nextRadius,
          );
        }
      }
    }
    const net = new THREE.BufferGeometry();
    net.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
    result.add(new THREE.LineSegments(net, new THREE.LineBasicMaterial({ color: 0xf4eddc, transparent: true, opacity: 0.83 })));
  }
  mergeStaticMeshes(result, true);
  return result;
}

function makeLEDTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#102521';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#84a48e';
  ctx.font = '800 26px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = 0; i < 5; i++) {
    const center = 205 + 409 * i;
    ctx.fillText(i % 2 ? 'HARDWOOD  DYNASTY' : 'HARDWOOD  ARENA', center, 34);
    ctx.fillStyle = '#bdab6b';
    ctx.fillRect(center + 202, 25, 2, 17);
    ctx.fillStyle = '#84a48e';
  }
  ctx.fillStyle = '#d8f5d221';
  for (let i = 0; i < canvas.height; i += 2) ctx.fillRect(0, i, canvas.width, 1);
  return canvasTexture(canvas, 2);
}

type Spectator = { x: number; y: number; z: number; rotation: number; scale: number; sway: number; wave: boolean; top: THREE.Color; skin: THREE.Color };

function makeCrowd(stands: THREE.Group) {
  const random = seededRandom(481);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x20282a, roughness: 0.92 });
  const darkSeat = new THREE.MeshStandardMaterial({ color: 0x293333, roughness: 0.9 });
  const rail = new THREE.MeshStandardMaterial({ color: 0x394946, metalness: 0.67, roughness: 0.56 });
  const palette = [0x685d55, 0xa59979, 0x365642, 0x899085, 0x564445, 0x4e6b73, 0x263440, 0x373b33, 0xada18a, 0x75593e];
  const complexion = [0x704635, 0x9a6548, 0xb98362, 0xcba584, 0xaa7956, 0x574135];
  const spectators: Spectator[] = [];
  for (const end of [-1, 0, 1]) {
    const sectionCount = end === 0 ? 5 : 2;
    const seats = end === 0 ? 9 : 10;
    const seatSpacing = 0.57;
    const sectionWidth = seatSpacing * seats + 0.72;
    const rotate = end * -Math.PI / 2;
    const sectionBase = end === 0 ? -9.95 : -16.52;
    for (let section = 0; section < sectionCount; section++) {
      const center = (section - (sectionCount - 1) / 2) * sectionWidth;
      for (let row = 0; row < 9; row++) {
        const y = 0.2 + row * 0.4 + (row > 4 ? 0.28 : 0);
        const z = sectionBase - row * 0.64 - (row > 4 ? 0.55 : 0);
        const xFor = (seatX: number) => end === 0 ? seatX : end * -z;
        const zFor = (seatX: number) => end === 0 ? z : end * seatX;
        box(stands, concrete, end === 0 ? [sectionWidth, 0.45, 0.81] : [0.81, 0.45, sectionWidth], xFor(center), y, zFor(center));
        box(stands, darkSeat, end === 0 ? [sectionWidth - 0.52, 0.24, 0.33] : [0.33, 0.24, sectionWidth - 0.52], xFor(center), y + 0.15, zFor(center));
        if (row === 5) {
          box(stands, rail, end === 0 ? [sectionWidth - 0.45, 0.041, 0.041] : [0.041, 0.041, sectionWidth - 0.45], xFor(center), y + 0.7, zFor(center));
        }
        for (let col = 0; col < seats; col++) {
          if (random() < 0.18) continue;
          const x = center + (col - (seats - 1) / 2) * seatSpacing + (random() - 0.5) * 0.09;
          spectators.push({
            x: xFor(x), y: y + 0.54 + random() * 0.09, z: zFor(x), rotation: rotate + (random() - 0.5) * 0.25,
            scale: 0.87 + random() * 0.26, sway: random() * Math.PI * 2, wave: random() < 0.22,
            top: new THREE.Color(palette[Math.floor(random() * palette.length)]),
            skin: new THREE.Color(complexion[Math.floor(random() * complexion.length)]),
          });
        }
      }
    }
  }

  const cloth = new THREE.MeshStandardMaterial({ roughness: 1 });
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 7, 5), cloth, spectators.length);
  const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.18, 0.14, 2, 6), cloth, spectators.length);
  heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  heads.frustumCulled = false;
  bodies.frustumCulled = false;
  stands.add(heads, bodies);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < spectators.length; i++) {
    heads.setColorAt(i, spectators[i].skin);
    bodies.setColorAt(i, spectators[i].top);
  }

  function animate(time: number, cheer: number) {
    for (let i = 0; i < spectators.length; i++) {
      const spectator = spectators[i];
      const swing = Math.sin(time * 2.6 + spectator.sway);
      const lift = spectator.wave ? cheer * (0.12 + 0.1 * swing) : 0;
      dummy.scale.set(spectator.scale, spectator.scale, spectator.scale);
      dummy.rotation.set(0, spectator.rotation, swing * (0.02 + lift * 0.4));
      dummy.position.set(spectator.x, spectator.y + lift, spectator.z);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);
      dummy.scale.x *= 0.93;
      dummy.position.y += 0.32 * spectator.scale;
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);
    }
    heads.instanceMatrix.needsUpdate = true;
    bodies.instanceMatrix.needsUpdate = true;
  }
  animate(0, 0);
  return animate;
}

export function makeArena() {
  const group = new THREE.Group();
  const indoor = new THREE.Group();
  const outdoor = new THREE.Group();
  group.add(indoor, outdoor);
  outdoor.visible = false;
  const stage = new THREE.MeshStandardMaterial({ color: 0x151d20, roughness: 0.8 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x344341, roughness: 1 });
  const ground = box(group, stage, [84, 0.27, 65], 0, -0.15, 0);
  ground.receiveShadow = true;

  const arenaWall = new THREE.MeshStandardMaterial({ color: 0x141e1d, roughness: 0.93 });
  box(indoor, arenaWall, [45, 9, 0.5], 0, 4.5, -17.15);
  const upperEdge = new THREE.MeshBasicMaterial({ color: 0x435651 });
  box(indoor, upperEdge, [44.7, 0.038, 0.1], 0, 5.18, -16.88);
  const led = new THREE.MeshBasicMaterial({ map: makeLEDTexture() });
  box(indoor, stage, [28.8, 0.78, 0.48], 0, 0.43, -9.23);
  const ledBoard = new THREE.Mesh(new THREE.PlaneGeometry(28.6, 0.6), led);
  ledBoard.position.set(0, 0.45, -8.985);
  indoor.add(ledBoard);
  for (const x of [-10, 0, 10]) {
    const table = box(indoor, stage, [3.6, 0.65, 0.62], x, 0.45, 9.76);
    table.castShadow = true;
  }
  const crowd = makeCrowd(indoor);

  box(outdoor, concrete, [42, 0.15, 35], 0, -0.09, 0);
  const fence = new THREE.MeshStandardMaterial({ color: 0x778786, metalness: 0.43, roughness: 0.8 });
  const wirePositions: number[] = [];
  function fenceSpan(x1: number, z1: number, x2: number, z2: number) {
    const length = Math.hypot(x2 - x1, z2 - z1);
    const segments = Math.ceil(length / 0.255);
    const height = 3.45;
    for (let i = 0; i < segments; i++) {
      const t = i / segments;
      const x = x1 + (x2 - x1) * t;
      const z = z1 + (z2 - z1) * t;
      wirePositions.push(x, 0.06, z, x, height, z);
    }
    for (let y = 0.06; y < height; y += 0.23) wirePositions.push(x1, y, z1, x2, y, z2);
    const posts = Math.ceil(length / 3.2);
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      box(outdoor, fence, [0.085, height + 0.05, 0.085], x1 + (x2 - x1) * t, height / 2, z1 + (z2 - z1) * t);
    }
  }
  fenceSpan(-17.3, -10.25, 17.3, -10.25);
  fenceSpan(-17.3, -10.25, -17.3, 8.8);
  fenceSpan(17.3, -10.25, 17.3, 8.8);
  const wire = new THREE.BufferGeometry();
  wire.setAttribute('position', new THREE.Float32BufferAttribute(wirePositions, 3));
  outdoor.add(new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: 0x859e99, transparent: true, opacity: 0.39 })));
  const skyline = new THREE.MeshStandardMaterial({ color: 0x26363a, roughness: 1 });
  const windows = new THREE.MeshBasicMaterial({ color: 0x52615b });
  const random = seededRandom(84);
  for (let x = -38; x < 36; x += 2.7 + random() * 3.5) {
    const height = 2.8 + random() * 9;
    const z = -23 - random() * 8;
    const wide = 2.3 + random() * 2.3;
    box(outdoor, skyline, [wide, height, 3], x, height / 2, z);
    for (let y = 1; y < height - 0.35; y += 0.9) {
      if (random() < 0.5) box(outdoor, windows, [wide * 0.61, 0.31, 0.018], x, y, z + 1.5);
    }
  }

  mergeStaticMeshes(indoor, true);
  mergeStaticMeshes(outdoor, true);

  return {
    group,
    setOutdoor(value: boolean) {
      indoor.visible = !value;
      outdoor.visible = value;
    },
    animate(time: number, cheer: number) {
      if (indoor.visible) crowd(time, cheer);
    },
  };
}
