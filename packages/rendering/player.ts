import * as THREE from 'three';
import type { GameEvent, GamePlayer, Team, Vec3 } from '../contracts/index.ts';
import { appearanceFor } from './appearance.ts';
import { canvasTexture } from './court.ts';
import { mergeStaticMeshes } from './geometry.ts';
import { makeClothMaps, makeJerseyTexture, makeShortsTexture, resolveKitPalette } from './jerseys.ts';
import type { KitPalette } from './jerseys.ts';
import { makeMotion } from './motion.ts';

type Limb = {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  joint: THREE.Mesh;
  tip: THREE.Object3D;
  cuff?: THREE.Mesh;
  trim?: THREE.Mesh;
  sleeve?: THREE.Mesh;
};

const axis = new THREE.Vector3(0, 1, 0);
const direction = new THREE.Vector3();
const start = new THREE.Vector3();
const joint = new THREE.Vector3();
const end = new THREE.Vector3();
const sleeve = new THREE.Vector3();
const hem = new THREE.Vector3();
const armKneeA = new THREE.Vector3();
const armKneeB = new THREE.Vector3();

function segment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
  direction.subVectors(to, from);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.scale.set(radius, direction.length(), radius);
  mesh.quaternion.setFromUnitVectors(axis, direction.normalize());
}

function profiledGeometry(profile: [number, number][], sides = 12, phiStart = 0, linearV = false) {
  const geo = new THREE.LatheGeometry(profile.map(([y, radius]) => new THREE.Vector2(radius, y)), sides, phiStart, Math.PI * 2);
  if (linearV) {
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = Math.max(0.001, maxY - minY);
    for (let i = 0; i < uv.count; i++) {
      uv.setY(i, (pos.getY(i) - minY) / span);
    }
    uv.needsUpdate = true;
  }
  return geo;
}

export function makePlayerFactory(anisotropy = 2) {
  const sphere = new THREE.SphereGeometry(1, 12, 9);
  const upperArmGeometry = profiledGeometry([[-0.52, 0.4], [-0.45, 0.87], [-0.26, 1.14], [-0.02, 1.02], [0.28, 0.79], [0.5, 0.71]]);
  const forearmGeometry = profiledGeometry([[-0.52, 0.77], [-0.28, 1.01], [-0.02, 0.91], [0.27, 0.74], [0.52, 0.6]]);
  const thighGeometry = profiledGeometry([[-0.54, 0.86], [-0.42, 1.07], [-0.19, 1.03], [0.19, 0.94], [0.48, 0.85], [0.52, 0.8]]);
  const shinGeometry = profiledGeometry([[-0.53, 0.69], [-0.36, 1.06], [-0.16, 1.08], [0.17, 0.79], [0.5, 0.47]]);
  const cuffGeometry = new THREE.CylinderGeometry(0.67, 1, 1, 16);
  // phiStart = -Math.PI/2 + linearV ensures front chest sits at u=0.25 (left-to-right) and back at u=0.75 (left-to-right)
  const torsoGeometry = profiledGeometry(
    [[0, 0.71], [0.095, 0.73], [0.25, 0.74], [0.46, 0.81], [0.7, 0.96], [0.84, 1.02], [0.93, 0.89], [1, 0.52]],
    22,
    -Math.PI / 2,
    true,
  );
  const pelvisGeometry = profiledGeometry(
    [[-1, 0.82], [-0.45, 0.98], [0.25, 1.00], [0.75, 0.91], [1, 0.82]],
    18,
    -Math.PI / 2,
    true,
  );

  const clothMaps = makeClothMaps();
  const ringGeometry = new THREE.RingGeometry(0.38, 0.435, 44);
  const meterGeometry = new THREE.RingGeometry(0.5, 0.565, 64, 1, 0, Math.PI * 2);
  const clampArcGeometry = new THREE.RingGeometry(0.45, 0.52, 24, 1, -Math.PI * 0.42, Math.PI * 0.84);
  const statusRingGeometry = new THREE.RingGeometry(0.46, 0.53, 36);
  const greenRingGeometry = new THREE.RingGeometry(0.44, 0.52, 40);
  const shadowGeometry = new THREE.PlaneGeometry(1.65, 1.35);
  const chargeGreen = new THREE.Color(0xbaff93);
  const clockGold = new THREE.Color(0xffca5d);
  const lateRed = new THREE.Color(0xff7d7c);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
  gradient.addColorStop(0, '#0000009c');
  gradient.addColorStop(0.38, '#00000070');
  gradient.addColorStop(1, '#00000000');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: canvasTexture(canvas), transparent: true, depthWrite: false, opacity: 0.72, polygonOffset: true, polygonOffsetFactor: -1,
  });
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xe1fc8f, transparent: true, depthWrite: false, opacity: 0.95, side: THREE.DoubleSide,
  });

  function material(color: THREE.ColorRepresentation, roughness = 0.86) {
    return new THREE.MeshStandardMaterial({ color, roughness });
  }

  function ellipsoid(parent: THREE.Object3D, mat: THREE.Material, scale: [number, number, number], pos: [number, number, number]) {
    const mesh = new THREE.Mesh(sphere, mat);
    mesh.scale.set(...scale);
    mesh.position.set(...pos);
    parent.add(mesh);
    return mesh;
  }

  function build(player: GamePlayer, team: Team, kitPalette?: KitPalette) {
    const palette = kitPalette ?? resolveKitPalette(team, player.side);
    const root = new THREE.Group();
    const model = new THREE.Group();
    const body = new THREE.Group();
    root.add(model);
    model.add(body);

    const app = appearanceFor(player.profile);
    const normalScale = app.stature / 2.02;
    model.scale.setScalar(normalScale);
    const motion = makeMotion(app.stature, app.thickness, app.hash, app.armScale);

    const skin = new THREE.MeshStandardMaterial({
      color: app.skin,
      roughness: 0.58,
    });
    const skinShade = material(app.skinShade, 0.72);
    const lipMat = material(app.lipTone, 0.62);
    const hair = material(app.hairColor, 0.92);
    const eyeWhite = material(0xf3e8dc, 0.35);

    const kit = new THREE.Group();
    body.add(kit);
    kit.scale.set(app.shoulderScale, 1, 0.59 + app.limbBulk * 0.41);

    const jerseyTex = makeJerseyTexture(team, player, palette, anisotropy);
    const shortsTex = makeShortsTexture(team, palette, anisotropy);
    const jerseyMat = new THREE.MeshStandardMaterial({
      map: jerseyTex,
      bumpMap: clothMaps.bumpMap,
      bumpScale: 0.004,
      roughnessMap: clothMaps.roughnessMap,
      roughness: 0.88,
    });
    const shortsMat = new THREE.MeshStandardMaterial({
      map: shortsTex,
      bumpMap: clothMaps.bumpMap,
      bumpScale: 0.004,
      roughnessMap: clothMaps.roughnessMap,
      roughness: 0.88,
    });
    const thighMat = new THREE.MeshStandardMaterial({
      color: palette.shortsBase,
      bumpMap: clothMaps.bumpMap,
      bumpScale: 0.003,
      roughnessMap: clothMaps.roughnessMap,
      roughness: 0.88,
    });
    const piping = material(palette.trim, 0.82);
    const sleeveColor = palette.kit === 'home' ? 0x191b20 : palette.accent;
    const sleeveMat = material(sleeveColor, 0.72);
    const darkShoe = app.hash % 3 === 1;
    const shoeBase = app.shoeColor ?? (darkShoe ? '#25282c' : '#ecece3');
    const shoes = material(shoeBase, 0.62);
    const midsoleMat = material('#f3f1ea', 0.55);
    const sole = material(darkShoe ? palette.accent : '#2a3034', 0.72);
    const socks = material(app.hash % 5 === 0 ? palette.accent : '#e9e6de', 0.88);
    const laces = material(palette.accent, 0.8);

    // Torso mesh with UV-wrapped team wordmark, front/back numbers & surname
    const chest = new THREE.Mesh(torsoGeometry, jerseyMat);
    chest.scale.set(0.252, 0.585, 0.152);
    chest.position.y = 1.142;
    chest.castShadow = true;
    kit.add(chest);
    ellipsoid(kit, jerseyMat, [0.214, 0.058, 0.125], [0, 1.662, 0]);
    ellipsoid(kit, piping, [0.094, 0.017, 0.09], [0, 1.718, 0.012]);

    // Shorts pelvis mesh
    const pelvis = new THREE.Mesh(pelvisGeometry, shortsMat);
    pelvis.scale.set(0.216 * (app.waistScale / Math.max(0.7, app.shoulderScale)), 0.145, 0.138);
    pelvis.position.y = 1.095;
    pelvis.castShadow = true;
    kit.add(pelvis);

    // Armhole shoulder piping rings
    for (const side of [-1, 1]) {
      const strip = ellipsoid(kit, piping, [0.014, 0.218, 0.062], [side * 0.20, 1.407, 0]);
      strip.rotation.z = side * -0.10;
      const armhole = ellipsoid(kit, piping, [0.023, 0.075, 0.112], [side * 0.213, 1.613, 0.003]);
      armhole.rotation.z = side * -0.15;
    }

    // Neck + independently proportion-scaled headGroup (y = 1.74 pivot)
    ellipsoid(body, skin, [0.072, 0.098, 0.072], [0, 1.732, 0]);
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.74, 0);
    headGroup.scale.setScalar(app.headScale);
    body.add(headGroup);

    const craniumW = 0.091 + (app.hash % 5) * 0.0016;
    const head = ellipsoid(headGroup, skin, [craniumW, 0.119, 0.093], [0, 0.148, 0.003]);
    head.castShadow = true;
    ellipsoid(headGroup, skin, [0.074 + (app.hash % 4) * 0.0015, 0.068, 0.08], [0, 0.102, 0.02]);
    ellipsoid(headGroup, skin, [0.055, 0.035, 0.055], [0, 0.065, 0.04]);
    const nose = ellipsoid(headGroup, skin, [0.016 + (app.hash % 5) * 0.0014, 0.035, 0.026], [0, 0.124, 0.089]);
    nose.rotation.x = -0.16;
    ellipsoid(headGroup, skin, [0.025, 0.015, 0.024], [0, 0.113, 0.105]);
    ellipsoid(headGroup, lipMat, [0.028, 0.007, 0.01], [0, 0.08, 0.093]);

    for (const side of [-1, 1]) {
      ellipsoid(headGroup, skin, [0.017, 0.029, 0.019], [side * 0.097, 0.129, 0.002]);
      ellipsoid(headGroup, skinShade, [0.008, 0.014, 0.012], [side * 0.108, 0.128, 0.004]);
      ellipsoid(headGroup, skinShade, [0.024, 0.012, 0.009], [side * 0.04, 0.15, 0.083]);
      const eye = ellipsoid(headGroup, eyeWhite, [0.017, 0.006, 0.009], [side * 0.04, 0.15, 0.084]);
      eye.rotation.y = side * 0.29;
      ellipsoid(headGroup, hair, [0.006, 0.007, 0.005], [side * 0.04, 0.15, 0.09]);
      const brow = ellipsoid(headGroup, hair, [0.026, 0.005, 0.009], [side * 0.043, 0.168, 0.087]);
      brow.rotation.z = side * 0.12;
    }

    // 10 distinct 3D hairstyles
    const hStyle = app.hair;
    if (hStyle === 'shaved') {
      const cap = ellipsoid(headGroup, skinShade, [craniumW * 0.99, 0.044, 0.095], [0, 0.214, -0.008]);
      cap.rotation.x = -0.14;
    } else if (hStyle === 'buzz') {
      const cap = ellipsoid(headGroup, hair, [0.096, 0.052, 0.10], [0, 0.215, -0.011]);
      cap.rotation.x = -0.15;
    } else if (hStyle === 'fade') {
      const scalp = ellipsoid(headGroup, hair, [0.095, 0.054, 0.098], [0, 0.215, -0.011]);
      scalp.rotation.x = -0.16;
      ellipsoid(headGroup, hair, [0.079, 0.042, 0.081], [0, 0.258, -0.008]);
    } else if (hStyle === 'taper') {
      const scalp = ellipsoid(headGroup, hair, [0.099, 0.064, 0.104], [0, 0.22, -0.012]);
      scalp.rotation.x = -0.17;
      ellipsoid(headGroup, hair, [0.082, 0.036, 0.086], [0, 0.264, -0.004]);
      for (const s of [-1, 1]) ellipsoid(headGroup, hair, [0.018, 0.032, 0.032], [s * 0.086, 0.176, -0.002]);
    } else if (hStyle === 'curls') {
      const scalp = ellipsoid(headGroup, hair, [0.102, 0.072, 0.106], [0, 0.224, -0.013]);
      scalp.rotation.x = -0.17;
      for (let index = 0; index < 11; index++) {
        const angle = index * 2.399;
        const ring = 0.035 + (index % 3) * 0.022;
        ellipsoid(headGroup, hair, [0.032, 0.026, 0.032], [Math.cos(angle) * ring, 0.276 + (index % 3) * 0.006, Math.sin(angle) * ring - 0.008]);
      }
    } else if (hStyle === 'afro') {
      ellipsoid(headGroup, hair, [0.148, 0.132, 0.146], [0, 0.244, -0.014]);
      for (let index = 0; index < 8; index++) {
        const a = (index / 8) * Math.PI * 2;
        ellipsoid(headGroup, hair, [0.046, 0.044, 0.046], [Math.cos(a) * 0.115, 0.245, Math.sin(a) * 0.115 - 0.014]);
      }
    } else if (hStyle === 'braids') {
      const scalp = ellipsoid(headGroup, hair, [0.097, 0.056, 0.101], [0, 0.217, -0.012]);
      scalp.rotation.x = -0.17;
      for (const x of [-0.068, -0.034, 0, 0.034, 0.068]) {
        const ridge = ellipsoid(headGroup, hair, [0.013, 0.058, 0.018], [x, 0.194 - Math.abs(x) * 0.28, -0.088]);
        ridge.rotation.x = 0.36 + Math.abs(x) * 3;
      }
    } else if (hStyle === 'locs') {
      ellipsoid(headGroup, hair, [0.104, 0.068, 0.108], [0, 0.226, -0.012]);
      for (let k = 0; k < 7; k++) {
        const theta = -0.9 + (k / 6) * 1.8;
        const loc = ellipsoid(headGroup, hair, [0.018, 0.092, 0.022], [Math.sin(theta) * 0.096, 0.175, -Math.cos(theta) * 0.088]);
        loc.rotation.z = -theta * 0.22;
        loc.rotation.x = 0.26;
      }
    } else if (hStyle === 'medium') {
      const cap = ellipsoid(headGroup, hair, [0.105, 0.068, 0.114], [0, 0.224, -0.008]);
      cap.rotation.x = -0.10;
      const fringe = ellipsoid(headGroup, hair, [0.086, 0.025, 0.048], [0.012, 0.222, 0.058]);
      fringe.rotation.x = 0.34;
    } else if (hStyle === 'long') {
      ellipsoid(headGroup, hair, [0.105, 0.072, 0.112], [0, 0.222, -0.015]);
      for (const s of [-0.062, -0.02, 0.02, 0.062]) {
        const fall = ellipsoid(headGroup, hair, [0.026, 0.128, 0.026], [s, 0.108, -0.098]);
        fall.rotation.x = 0.18;
      }
    }

    // 5 facial hair styles
    const fStyle = app.facialHair;
    if (fStyle === 'stubble') {
      ellipsoid(headGroup, skinShade, [0.069, 0.028, 0.044], [0, 0.064, 0.053]);
    } else if (fStyle === 'goatee') {
      ellipsoid(headGroup, hair, [0.036, 0.024, 0.026], [0, 0.052, 0.078]);
      ellipsoid(headGroup, hair, [0.032, 0.008, 0.012], [0, 0.092, 0.094]);
    } else if (fStyle === 'beard') {
      const chin = ellipsoid(headGroup, hair, [0.066, 0.032, 0.045], [0, 0.061, 0.057]);
      chin.rotation.x = -0.35;
      for (const s of [-1, 1]) {
        const jaw = ellipsoid(headGroup, hair, [0.021, 0.034, 0.042], [s * 0.071, 0.088, 0.032]);
        jaw.rotation.x = -0.25;
      }
    } else if (fStyle === 'fullBeard') {
      const full = ellipsoid(headGroup, hair, [0.074, 0.046, 0.056], [0, 0.051, 0.058]);
      full.rotation.x = -0.28;
      ellipsoid(headGroup, hair, [0.042, 0.012, 0.018], [0, 0.092, 0.093]);
      for (const s of [-1, 1]) ellipsoid(headGroup, hair, [0.024, 0.042, 0.046], [s * 0.075, 0.092, 0.032]);
    }

    if (app.headband) {
      const band = ellipsoid(headGroup, piping, [0.104, 0.018, 0.109], [0, 0.203, -0.004]);
      band.rotation.x = -0.08;
    }

    mergeStaticMeshes(headGroup, false);
    mergeStaticMeshes(body, false);
    mergeStaticMeshes(kit, false);
    const sharedGeometry = new Set<THREE.BufferGeometry>([sphere, torsoGeometry, pelvisGeometry]);

    const arms: Limb[] = [];
    const bakedGeometries: THREE.BufferGeometry[] = [];
    const bands = new THREE.Mesh(cuffGeometry, piping);
    if (app.hash % 5 === 0) model.add(bands);
    const legs: Limb[] = [];

    for (let index = 0; index < 2; index++) {
      const upperArm = new THREE.Mesh(upperArmGeometry, skin);
      const lowerArm = new THREE.Mesh(forearmGeometry, skin);
      const elbow = ellipsoid(model, skin, [0.056 * app.limbBulk, 0.055 * app.limbBulk, 0.054 * app.limbBulk], [0, 0, 0]);
      const hand = new THREE.Group();
      ellipsoid(hand, skin, [0.044, 0.069, 0.034], [0, -0.021, 0]);
      const thumb = ellipsoid(hand, skin, [0.017, 0.039, 0.021], [index === 0 ? 0.038 : -0.038, -0.015, 0.015]);
      thumb.rotation.z = index === 0 ? 0.41 : -0.41;
      mergeStaticMeshes(hand, false);
      for (const child of hand.children) if (child instanceof THREE.Mesh) bakedGeometries.push(child.geometry);
      upperArm.castShadow = true;
      lowerArm.castShadow = true;
      model.add(upperArm, lowerArm, hand);

      const hasArmSleeve = app.armSleeve === 'both' || (index === 0 && app.armSleeve === 'left') || (index === 1 && app.armSleeve === 'right');
      let armSleeveMesh: THREE.Mesh | undefined;
      if (hasArmSleeve) {
        armSleeveMesh = new THREE.Mesh(cuffGeometry, sleeveMat);
        model.add(armSleeveMesh);
      }
      arms.push({ upper: upperArm, lower: lowerArm, joint: elbow, tip: hand, sleeve: armSleeveMesh });

      const upperLeg = new THREE.Mesh(thighGeometry, thighMat);
      const lowerLeg = new THREE.Mesh(shinGeometry, skin);
      const knee = ellipsoid(model, skin, [0.064 * app.limbBulk, 0.075 * app.limbBulk, 0.063 * app.limbBulk], [0, 0, 0]);
      const sock = new THREE.Mesh(cuffGeometry, socks);
      const edge = new THREE.Mesh(cuffGeometry, piping);

      const hasLegSleeve = app.legSleeve === 'both' || (index === 0 && app.legSleeve === 'left') || (index === 1 && app.legSleeve === 'right');
      let legSleeveMesh: THREE.Mesh | undefined;
      if (hasLegSleeve) {
        legSleeveMesh = new THREE.Mesh(cuffGeometry, sleeveMat);
        model.add(legSleeveMesh);
      }

      // Multi-tone athletic basketball sneaker
      const foot = new THREE.Group();
      ellipsoid(foot, shoes, [0.084, 0.066, 0.136], [0, 0.028, 0.014]);
      ellipsoid(foot, shoes, [0.088, 0.041, 0.104], [0, 0.004, 0.115]);
      ellipsoid(foot, midsoleMat, [0.091, 0.018, 0.174], [0, -0.026, 0.055]);
      ellipsoid(foot, sole, [0.093, 0.012, 0.176], [0, -0.044, 0.055]);
      ellipsoid(foot, piping, [0.063, 0.045, 0.062], [0, 0.022, -0.072]);
      ellipsoid(foot, piping, [0.014, 0.024, 0.082], [index === 0 ? -0.081 : 0.081, 0.012, 0.032]);
      for (let lace = 0; lace < 3; lace++) {
        const loop = ellipsoid(foot, laces, [0.044 - 0.003 * lace, 0.004, 0.008], [0, 0.085 - 0.008 * lace, 0.04 + 0.025 * lace]);
        loop.rotation.y = index === 0 ? 0.18 : -0.18;
      }
      mergeStaticMeshes(foot, false);
      for (const child of foot.children) if (child instanceof THREE.Mesh && child.geometry !== sphere) bakedGeometries.push(child.geometry);
      upperLeg.castShadow = true;
      lowerLeg.castShadow = true;
      model.add(upperLeg, lowerLeg, sock, foot, edge);
      legs.push({ upper: upperLeg, lower: lowerLeg, joint: knee, tip: foot, cuff: sock, trim: edge, sleeve: legSleeveMesh });
    }

    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    shadow.renderOrder = 2;
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.024;
    ring.renderOrder = 3;
    const meterMaterial = new THREE.MeshBasicMaterial({ color: clockGold, side: THREE.DoubleSide, depthWrite: false });
    const meter = new THREE.Mesh(meterGeometry.clone(), meterMaterial);
    meter.rotation.x = -Math.PI / 2;
    meter.position.y = 0.025;
    meter.renderOrder = 3;
    const clampArcMaterial = new THREE.MeshBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
    const clampArc = new THREE.Mesh(clampArcGeometry, clampArcMaterial);
    clampArc.rotation.x = -Math.PI / 2;
    clampArc.position.y = 0.022;
    clampArc.renderOrder = 3;
    clampArc.visible = false;
    const statusRingMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide });
    const statusRing = new THREE.Mesh(statusRingGeometry, statusRingMaterial);
    statusRing.rotation.x = -Math.PI / 2;
    statusRing.position.y = 0.023;
    statusRing.renderOrder = 3;
    statusRing.visible = false;
    const greenRingMaterial = new THREE.MeshBasicMaterial({ color: 0x8cff66, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const greenRing = new THREE.Mesh(greenRingGeometry, greenRingMaterial);
    greenRing.rotation.x = -Math.PI / 2;
    greenRing.position.y = 0.026;
    greenRing.renderOrder = 3;
    greenRing.visible = false;
    root.add(shadow, ring, meter, clampArc, statusRing, greenRing);

    function animate(gamePlayer: GamePlayer, tick: number, heldBall: Vec3 | undefined, selected: boolean, charge: number, event: GameEvent | undefined, greenPulse = 0) {
      const pose = motion(gamePlayer, tick, heldBall, charge, event);
      root.position.set(gamePlayer.position.x, 0, gamePlayer.position.z);
      model.rotation.y = Math.PI / 2 - pose.facing;
      ring.visible = selected;
      meter.visible = selected && charge > 0;
      if (meter.visible) {
        const fraction = Math.min(charge / 1.2, 1);
        meter.geometry.setDrawRange(0, Math.max(6, Math.round(fraction * 64) * 6));
        meterMaterial.color.copy(Math.abs(charge - 0.62) < 0.065 ? chargeGreen : charge > 0.72 ? lateRed : clockGold);
      }
      const action = gamePlayer.action;
      const clamping = action?.bodyUp === 'clamp';
      const riding = action?.bodyUp === 'ride';
      clampArc.visible = Boolean(action?.intenseD || clamping || riding);
      if (clampArc.visible) {
        clampArc.rotation.z = -pose.facing;
        clampArcMaterial.color.setHex(clamping ? 0x2e9dff : 0x5ec8ff);
        clampArcMaterial.opacity = clamping ? 0.9 : 0.65;
      }
      const st = action?.stumble ?? 0;
      const fb = action?.flyBy ?? 0;
      const hot = (action?.hotStreak ?? 0) >= 2;
      statusRing.visible = st > 0 || fb > 0 || hot;
      if (statusRing.visible) {
        if (st > 0 || fb > 0) {
          statusRingMaterial.color.setHex(st > 0 ? 0xffb347 : 0xff7f66);
          statusRingMaterial.opacity = Math.max(st, fb) * 0.85;
          statusRing.scale.setScalar(1 + Math.sin(tick * 0.6) * 0.06);
        } else {
          statusRingMaterial.color.setHex(0xff8c32);
          statusRingMaterial.opacity = 0.55 + Math.sin(tick * 0.25) * 0.15;
          statusRing.scale.setScalar(1.04 + Math.sin(tick * 0.25) * 0.03);
        }
      }
      greenRing.visible = greenPulse > 0;
      if (greenRing.visible) {
        greenRing.scale.setScalar(1 + (1 - greenPulse) * 0.75);
        greenRingMaterial.opacity = 0.9 * greenPulse;
      }

      model.position.y = pose.rise * normalScale;
      body.position.set(0, -pose.crouch, 0);
      body.rotation.set(pose.tilt, pose.twist, pose.roll);
      body.position.z = -Math.sin(pose.tilt) * 1.29;
      body.position.x = Math.sin(pose.roll) * 1.29;
      shadow.scale.setScalar(1 + pose.rise * 0.62);
      shadow.position.x = -0.07 - pose.rise * 0.32;

      for (let index = 0; index < 2; index++) {
        const leg = legs[index];
        const legPose = pose.legs[index];
        start.set(legPose.start.x, legPose.start.y, legPose.start.z);
        joint.set(legPose.joint.x, legPose.joint.y, legPose.joint.z);
        end.set(legPose.end.x, legPose.end.y, legPose.end.z);
        sleeve.copy(joint).lerp(start, 0.155);
        segment(leg.upper, start, sleeve, 0.107 * app.limbBulk);
        hem.copy(sleeve).lerp(start, 0.062);
        segment(leg.trim!, hem, sleeve, 0.099 * app.limbBulk);
        leg.joint.position.copy(joint);
        segment(leg.lower, joint, end, 0.07 * app.limbBulk);
        sleeve.copy(end).lerp(joint, 0.28);
        segment(leg.cuff!, sleeve, end, 0.062 * app.limbBulk);
        if (leg.sleeve) {
          armKneeA.copy(start).lerp(joint, 0.85);
          armKneeB.copy(joint).lerp(end, 0.58);
          segment(leg.sleeve, armKneeA, armKneeB, 0.074 * app.limbBulk);
        }
        leg.tip.position.set(end.x, end.y - 0.049, end.z);
        leg.tip.rotation.set(legPose.pitch, index === 0 ? -0.11 : 0.11, 0);

        const arm = arms[index];
        const armPose = pose.arms[index];
        start.set(armPose.start.x, armPose.start.y, armPose.start.z);
        joint.set(armPose.joint.x, armPose.joint.y, armPose.joint.z);
        end.set(armPose.end.x, armPose.end.y, armPose.end.z);
        segment(arm.upper, start, joint, 0.071 * app.limbBulk);
        arm.joint.position.copy(joint);
        segment(arm.lower, joint, end, 0.053 * app.limbBulk);
        if (arm.sleeve) {
          armKneeA.copy(joint).lerp(start, 0.42);
          armKneeB.copy(end).lerp(joint, 0.14);
          segment(arm.sleeve, armKneeA, armKneeB, 0.066 * app.limbBulk);
        }
        arm.tip.position.copy(end);
        arm.tip.quaternion.copy(arm.lower.quaternion);
        arm.tip.rotateX(Math.PI + armPose.pitch);
        if (index === 1 && bands.parent) {
          sleeve.copy(end).lerp(joint, 0.23);
          hem.copy(end).lerp(joint, 0.08);
          segment(bands, sleeve, hem, 0.04 * app.limbBulk);
        }
      }
    }

    function dispose() {
      for (const mat of [
        skin, skinShade, lipMat, hair, eyeWhite, jerseyMat, shortsMat, thighMat, piping,
        sleeveMat, shoes, midsoleMat, sole, socks, laces, meterMaterial, clampArcMaterial,
        statusRingMaterial, greenRingMaterial,
      ]) mat.dispose();
      jerseyTex.dispose();
      shortsTex.dispose();
      for (const geometry of bakedGeometries) geometry.dispose();
      meter.geometry.dispose();
      body.traverse((mesh) => {
        if (mesh instanceof THREE.Mesh && !sharedGeometry.has(mesh.geometry)) mesh.geometry.dispose();
      });
    }

    return { root, animate, dispose };
  }

  function dispose() {
    for (const geometry of [
      sphere, upperArmGeometry, forearmGeometry, thighGeometry, shinGeometry, cuffGeometry,
      torsoGeometry, pelvisGeometry, ringGeometry, meterGeometry, clampArcGeometry,
      statusRingGeometry, greenRingGeometry, shadowGeometry,
    ]) geometry.dispose();
    clothMaps.bumpMap.dispose();
    clothMaps.roughnessMap.dispose();
    shadowMaterial.map?.dispose();
    shadowMaterial.dispose();
    ringMaterial.dispose();
  }

  return { build, dispose };
}
