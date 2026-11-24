import * as THREE from 'three';
import type { GameEvent, GamePlayer, Team, Vec3 } from '../contracts/index.ts';
import { canvasTexture } from './court.ts';
import { mergeStaticMeshes } from './geometry.ts';
import { appearanceFor } from './appearance.ts';
import { makeMotion } from './motion.ts';

type Standard = THREE.MeshStandardMaterial;
type Limb = {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  joint: THREE.Mesh;
  tip: THREE.Object3D;
  cuff?: THREE.Mesh;
  trim?: THREE.Mesh;
};
const axis = new THREE.Vector3(0, 1, 0);
const direction = new THREE.Vector3();
const start = new THREE.Vector3();
const joint = new THREE.Vector3();
const end = new THREE.Vector3();
const sleeve = new THREE.Vector3();
const hem = new THREE.Vector3();
function segment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
  direction.subVectors(to, from);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.scale.set(radius, direction.length(), radius);
  mesh.quaternion.setFromUnitVectors(axis, direction.normalize());
}

function profiledGeometry(profile: [number, number][], sides = 20) {
  return new THREE.LatheGeometry(profile.map(([y, radius]) => new THREE.Vector2(radius, y)), sides);
}

function numberTexture(number: number, textColor: string, topText: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 112;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${topText.length > 6 ? 13 : 16}px sans-serif`;
  ctx.shadowColor = '#0000003d';
  ctx.shadowBlur = 2;
  ctx.fillText(topText, 64, 16, 118);
  ctx.font = '900 76px sans-serif';
  ctx.fillText(String(number), 64, 68);
  return canvasTexture(canvas, 2);
}

export function makePlayerFactory() {
  const sphere = new THREE.SphereGeometry(1, 20, 14);
  const upperArmGeometry = profiledGeometry([[-0.52, 0.4], [-0.45, 0.87], [-0.26, 1.13], [-0.02, 1.01], [0.28, 0.79], [0.5, 0.71]]);
  const forearmGeometry = profiledGeometry([[-0.52, 0.77], [-0.28, 1.01], [-0.02, 0.91], [0.27, 0.74], [0.52, 0.6]]);
  const thighGeometry = profiledGeometry([[-0.54, 0.86], [-0.42, 1.07], [-0.19, 1.03], [0.19, 0.94], [0.48, 0.85], [0.52, 0.8]]);
  const shinGeometry = profiledGeometry([[-0.53, 0.69], [-0.36, 1.06], [-0.16, 1.08], [0.17, 0.79], [0.5, 0.47]]);
  const cuffGeometry = new THREE.CylinderGeometry(0.67, 1, 1, 16);
  const torsoGeometry = profiledGeometry([[0, 0.71], [0.095, 0.73], [0.25, 0.74], [0.46, 0.81], [0.7, 0.95], [0.84, 1], [0.93, 0.88], [1, 0.52]], 32);
  const fabric = document.createElement('canvas');
  fabric.width = fabric.height = 128;
  const weave = fabric.getContext('2d')!;
  weave.fillStyle = '#f6f6f6';
  weave.fillRect(0, 0, 128, 128);
  for (let row = 0; row < 128; row += 4) {
    for (let column = row % 8 === 0 ? 0 : 2; column < 128; column += 4) {
      weave.fillStyle = '#bfbfbf';
      weave.fillRect(column, row, 1, 2);
      weave.fillStyle = '#ffffff';
      weave.fillRect(column + 1, row + 2, 1, 1);
    }
  }
  const clothTexture = canvasTexture(fabric, 4);
  const numberGeometry = new THREE.PlaneGeometry(0.245, 0.227);
  const ringGeometry = new THREE.RingGeometry(0.38, 0.435, 44);
  const meterGeometry = new THREE.RingGeometry(0.5, 0.565, 64, 1, 0, Math.PI * 2);
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

  function material(color: THREE.ColorRepresentation) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.86 });
  }

  function ellipsoid(parent: THREE.Object3D, mat: Standard, scale: [number, number, number], pos: [number, number, number]) {
    const mesh = new THREE.Mesh(sphere, mat);
    mesh.scale.set(...scale);
    mesh.position.set(...pos);
    parent.add(mesh);
    return mesh;
  }

  function build(player: GamePlayer, team: Team) {
    const root = new THREE.Group();
    const model = new THREE.Group();
    const body = new THREE.Group();
    root.add(model);
    model.add(body);
    const { stature, thickness, skin: complexion, hair: hairstyle, hairColor, hash } = appearanceFor(player.profile);
    const normalScale = stature / 2.02;
    model.scale.setScalar(normalScale);
    const motion = makeMotion(stature, thickness, hash);

    const skin = material(complexion);
    skin.roughness = 0.64;
    const skinShade = material(skin.color.clone().multiplyScalar(0.79));
    const hair = material(hairColor);
    const eyeWhite = material(0xf3e5d7);
    const kit = new THREE.Group();
    body.add(kit);
    kit.scale.set(thickness, 1, 0.59 + thickness * 0.41);
    const club = new THREE.Color(team.color);
    const accent = new THREE.Color(team.accent);
    const uniform = player.side === 0 ? club.clone() : new THREE.Color(0xece8dd).lerp(club, 0.14);
    if (player.side === 0 && uniform.getHSL({ h: 0, s: 0, l: 0 }).l < 0.085) uniform.offsetHSL(0, 0.02, 0.14);
    const trim = player.side === 0 ? accent.clone() : club.clone();
    const jersey = material(uniform);
    jersey.roughness = 0.94;
    jersey.map = clothTexture;
    const piping = material(trim);
    const shorts = material(uniform.clone().multiplyScalar(0.90));
    shorts.map = clothTexture;
    const shoes = material(hash % 3 === 1 ? 0x282b2a : 0xe9e9dc);
    const sole = material(hash % 3 === 1 ? 0x9eaba2 : 0x293233);
    const socks = material(hash % 7 === 0 ? trim : 0xe6e3db);
    const laces = material(hash % 3 === 1 ? 0xeee8db : 0x9ea89f);

    const chest = new THREE.Mesh(torsoGeometry, jersey);
    chest.scale.set(0.251, 0.579, 0.151);
    chest.position.y = 1.145;
    chest.castShadow = true;
    kit.add(chest);
    ellipsoid(kit, jersey, [0.211, 0.061, 0.125], [0, 1.66, 0]);
    ellipsoid(kit, piping, [0.093, 0.018, 0.089], [0, 1.718, 0.013]);
    ellipsoid(body, skin, [0.071, 0.102, 0.071], [0, 1.738, 0]);
    const head = ellipsoid(body, skin, [0.091 + (hash % 5) * 0.0016, 0.119, 0.093], [0, 1.888, 0.003]);
    head.castShadow = true;
    ellipsoid(body, skin, [0.073 + (hash % 4) * 0.0015, 0.067, 0.08], [0, 1.842, 0.02]);
    ellipsoid(body, skin, [0.055, 0.035, 0.055], [0, 1.805, 0.04]);
    const nose = ellipsoid(body, skin, [0.016 + (hash % 5) * 0.0014, 0.035, 0.026], [0, 1.864, 0.089]);
    nose.rotation.x = -0.16;
    ellipsoid(body, skin, [0.025, 0.015, 0.024], [0, 1.853, 0.105]);
    ellipsoid(body, skinShade, [0.028, 0.005, 0.008], [0, 1.82, 0.093]);
    for (const side of [-1, 1]) {
      ellipsoid(body, skin, [0.017, 0.029, 0.019], [side * 0.097, 1.869, 0.002]);
      ellipsoid(body, skinShade, [0.008, 0.014, 0.012], [side * 0.108, 1.868, 0.004]);
      ellipsoid(body, skinShade, [0.024, 0.012, 0.009], [side * 0.04, 1.89, 0.083]);
      const eye = ellipsoid(body, eyeWhite, [0.017, 0.006, 0.009], [side * 0.04, 1.89, 0.084]);
      eye.rotation.y = side * 0.29;
      ellipsoid(body, hair, [0.006, 0.007, 0.005], [side * 0.04, 1.89, 0.09]);
      const brow = ellipsoid(body, hair, [0.026, 0.005, 0.009], [side * 0.043, 1.908, 0.087]);
      brow.rotation.z = side * 0.12;
      const strip = ellipsoid(kit, piping, [0.013, 0.221, 0.061], [side * 0.197, 1.407, 0]);
      strip.rotation.z = side * -0.10;
      const armhole = ellipsoid(kit, piping, [0.022, 0.073, 0.11], [side * 0.211, 1.613, 0.003]);
      armhole.rotation.z = side * -0.15;
    }
    if (hairstyle !== 'shaved') {
      const raised = hairstyle === 'curls' ? 0.017 : 0;
      const scalp = ellipsoid(body, hair, [0.1, 0.065 + raised, 0.105], [0, 1.958 + raised * 0.4, -0.013]);
      scalp.rotation.x = -0.17;
      if (hairstyle === 'fade') ellipsoid(body, hair, [0.078, 0.038, 0.078], [0, 1.999, -0.008]);
      if (hairstyle === 'curls') {
        for (let index = 0; index < 9; index++) {
          const angle = index * 2.399;
          ellipsoid(body, hair, [0.03, 0.023, 0.03], [Math.cos(angle) * 0.071, 2.013 + (index % 3) * 0.004, Math.sin(angle) * 0.073 - 0.013]);
        }
      }
      if (hairstyle === 'braids') {
        for (const x of [-0.068, -0.033, 0, 0.033, 0.068]) {
          const braid = ellipsoid(body, hair, [0.013, 0.054, 0.016], [x, 1.935 - Math.abs(x) * 0.28, -0.088]);
          braid.rotation.x = 0.36 + Math.abs(x) * 3;
        }
      }
    }
    if (hash % 6 === 0) {
      const beard = ellipsoid(body, hair, [0.067, 0.027, 0.04], [0, 1.805, 0.057]);
      beard.rotation.x = -0.41;
    }
    if (hash % 11 === 0) ellipsoid(body, piping, [0.103, 0.016, 0.107], [0, 1.943, -0.006]);
    ellipsoid(kit, shorts, [0.218, 0.152, 0.142], [0, 1.098, 0]);
    ellipsoid(kit, piping, [0.186, 0.021, 0.117], [0, 1.183, 0]);

    const ink = uniform.getHSL({ h: 0, s: 0, l: 0 }).l > 0.58 ? '#151e21' : '#f7f2df';
    const parts = player.profile.name.trim().split(/\s+/);
    const lastName = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).toUpperCase();
    const frontDigits = numberTexture(player.profile.number, ink, team.abbreviation);
    const backDigits = numberTexture(player.profile.number, ink, lastName);
    const frontMaterial = new THREE.MeshBasicMaterial({
      map: frontDigits, transparent: true, depthWrite: false, alphaTest: 0.2, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const backMaterial = new THREE.MeshBasicMaterial({
      map: backDigits, transparent: true, depthWrite: false, alphaTest: 0.2, polygonOffset: true, polygonOffsetFactor: -2,
    });
    for (const side of [-1, 1]) {
      const label = new THREE.Mesh(numberGeometry, side === 1 ? frontMaterial : backMaterial);
      label.position.set(0, 1.493, side * 0.153);
      label.rotation.y = side < 0 ? Math.PI : 0;
      kit.add(label);
    }

    mergeStaticMeshes(body, false);
    mergeStaticMeshes(kit, false);
    const sharedGeometry = new Set<THREE.BufferGeometry>([sphere, torsoGeometry, numberGeometry]);

    const arms: Limb[] = [];
    const bakedGeometries: THREE.BufferGeometry[] = [];
    const bands = new THREE.Mesh(cuffGeometry, piping);
    if (hash % 5 === 0) model.add(bands);
    const legs: Limb[] = [];
    for (let index = 0; index < 2; index++) {
      const upperArm = new THREE.Mesh(upperArmGeometry, skin);
      const lowerArm = new THREE.Mesh(forearmGeometry, skin);
      const elbow = ellipsoid(model, skin, [0.056, 0.055, 0.054], [0, 0, 0]);
      const hand = new THREE.Group();
      ellipsoid(hand, skin, [0.044, 0.069, 0.034], [0, -0.021, 0]);
      const thumb = ellipsoid(hand, skin, [0.017, 0.039, 0.021], [index === 0 ? 0.038 : -0.038, -0.015, 0.015]);
      thumb.rotation.z = index === 0 ? 0.41 : -0.41;
      mergeStaticMeshes(hand, false);
      for (const child of hand.children) if (child instanceof THREE.Mesh) bakedGeometries.push(child.geometry);
      upperArm.castShadow = true;
      lowerArm.castShadow = true;
      model.add(upperArm, lowerArm, hand);
      arms.push({ upper: upperArm, lower: lowerArm, joint: elbow, tip: hand });

      const upperLeg = new THREE.Mesh(thighGeometry, shorts);
      const lowerLeg = new THREE.Mesh(shinGeometry, skin);
      const knee = ellipsoid(model, skin, [0.064, 0.075, 0.063], [0, 0, 0]);
      const sock = new THREE.Mesh(cuffGeometry, socks);
      const edge = new THREE.Mesh(cuffGeometry, piping);
      const foot = new THREE.Group();
      ellipsoid(foot, shoes, [0.084, 0.07, 0.139], [0, 0.028, 0.015]);
      ellipsoid(foot, shoes, [0.088, 0.043, 0.103], [0, 0.002, 0.117]);
      ellipsoid(foot, sole, [0.092, 0.023, 0.175], [0, -0.039, 0.055]);
      ellipsoid(foot, piping, [0.061, 0.047, 0.061], [0, 0.019, -0.073]);
      for (let lace = 0; lace < 3; lace++) {
        const loop = ellipsoid(foot, laces, [0.044 - 0.003 * lace, 0.004, 0.008], [0, 0.085 - 0.008 * lace, 0.04 + 0.025 * lace]);
        loop.rotation.y = index === 0 ? 0.18 : -0.18;
      }
      mergeStaticMeshes(foot, false);
      for (const child of foot.children) if (child instanceof THREE.Mesh && child.geometry !== sphere) bakedGeometries.push(child.geometry);
      upperLeg.castShadow = true;
      lowerLeg.castShadow = true;
      model.add(upperLeg, lowerLeg, sock, foot, edge);
      legs.push({ upper: upperLeg, lower: lowerLeg, joint: knee, tip: foot, cuff: sock, trim: edge });
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
    root.add(shadow, ring, meter);

    function animate(gamePlayer: GamePlayer, tick: number, heldBall: Vec3 | undefined, selected: boolean, charge: number, event: GameEvent | undefined) {
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
        segment(leg.upper, start, sleeve, 0.107 * thickness);
        hem.copy(sleeve).lerp(start, 0.062);
        segment(leg.trim!, hem, sleeve, 0.099 * thickness);
        leg.joint.position.copy(joint);
        segment(leg.lower, joint, end, 0.07 * thickness);
        sleeve.copy(end).lerp(joint, 0.28);
        segment(leg.cuff!, sleeve, end, 0.062 * thickness);
        leg.tip.position.set(end.x, end.y - 0.049, end.z);
        leg.tip.rotation.set(legPose.pitch, index === 0 ? -0.11 : 0.11, 0);

        const arm = arms[index];
        const armPose = pose.arms[index];
        start.set(armPose.start.x, armPose.start.y, armPose.start.z);
        joint.set(armPose.joint.x, armPose.joint.y, armPose.joint.z);
        end.set(armPose.end.x, armPose.end.y, armPose.end.z);
        segment(arm.upper, start, joint, 0.071 * thickness);
        arm.joint.position.copy(joint);
        segment(arm.lower, joint, end, 0.053 * thickness);
        arm.tip.position.copy(end);
        arm.tip.quaternion.copy(arm.lower.quaternion);
        arm.tip.rotateX(Math.PI + armPose.pitch);
        if (index === 1 && bands.parent) {
          sleeve.copy(end).lerp(joint, 0.23);
          hem.copy(end).lerp(joint, 0.08);
          segment(bands, sleeve, hem, 0.04 * thickness);
        }
      }
    }

    function dispose() {
      for (const mat of [skin, skinShade, hair, eyeWhite, jersey, piping, shorts, shoes, sole, socks, laces, frontMaterial, backMaterial, meterMaterial]) mat.dispose();
      frontDigits.dispose();
      backDigits.dispose();
      for (const geometry of bakedGeometries) geometry.dispose();
      meter.geometry.dispose();
      body.traverse((mesh) => {
        if (mesh instanceof THREE.Mesh && !sharedGeometry.has(mesh.geometry)) mesh.geometry.dispose();
      });
    }

    return { root, animate, dispose };
  }

  function dispose() {
    for (const geometry of [sphere, upperArmGeometry, forearmGeometry, thighGeometry, shinGeometry, cuffGeometry, torsoGeometry, numberGeometry, ringGeometry, meterGeometry, shadowGeometry]) geometry.dispose();
    clothTexture.dispose();
    shadowMaterial.map?.dispose();
    shadowMaterial.dispose();
    ringMaterial.dispose();
  }

  return { build, dispose };
}
