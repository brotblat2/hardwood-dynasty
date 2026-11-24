import * as THREE from 'three';
import type { GamePlayer, Team, Vec3 } from '../contracts/index.ts';
import { canvasTexture } from './court.ts';
import { mergeStaticMeshes } from './geometry.ts';
import { appearanceFor } from './appearance.ts';

type Standard = THREE.MeshStandardMaterial;
type Limb = {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  joint: THREE.Mesh;
  tip: THREE.Object3D;
  cuff?: THREE.Mesh;
};
const axis = new THREE.Vector3(0, 1, 0);
const direction = new THREE.Vector3();
const start = new THREE.Vector3();
const joint = new THREE.Vector3();
const end = new THREE.Vector3();
const sleeve = new THREE.Vector3();
function segment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
  direction.subVectors(to, from);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.scale.set(radius, direction.length(), radius);
  mesh.quaternion.setFromUnitVectors(axis, direction.normalize());
}

function numberTexture(number: number, textColor: string, abbreviation: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 112;
  canvas.height = 104;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 18px sans-serif';
  ctx.fillText(abbreviation, 56, 15);
  ctx.font = '900 77px sans-serif';
  ctx.fillText(String(number), 56, 62);
  return canvasTexture(canvas, 2);
}

export function makePlayerFactory() {
  const sphere = new THREE.SphereGeometry(1, 13, 9);
  const taper = new THREE.CylinderGeometry(0.86, 1, 1, 10);
  const torsoGeometry = new THREE.CylinderGeometry(1, 0.68, 1, 12, 1);
  const numberGeometry = new THREE.PlaneGeometry(0.245, 0.227);
  const ringGeometry = new THREE.RingGeometry(0.38, 0.435, 44);
  const meterGeometry = new THREE.RingGeometry(0.5, 0.565, 64, 1, 0, Math.PI * 2);
  const shadowGeometry = new THREE.PlaneGeometry(1.65, 1.35);
  const chargeGreen = new THREE.Color(0xbaff93);
  const clockGold = new THREE.Color(0xffca5d);
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
    const { stature, thickness, skin: complexion, hair: hairstyle, hash } = appearanceFor(player.profile);
    const normalScale = stature / 2.02;
    model.scale.setScalar(normalScale);

    const skin = material(complexion);
    skin.roughness = 0.72;
    const skinShade = material(skin.color.clone().multiplyScalar(0.79));
    const hair = material(hash % 17 === 0 ? 0x57402d : 0x261c19);
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
    const piping = material(trim);
    const shorts = material(uniform.clone().multiplyScalar(0.88));
    const shoes = material(hash % 3 === 1 ? 0x282b2a : 0xe9e9dc);
    const sole = material(hash % 3 === 1 ? 0x9eaba2 : 0x293233);
    const socks = material(0xe6e3db);

    const chest = new THREE.Mesh(torsoGeometry, jersey);
    chest.scale.set(0.259, 0.525, 0.144);
    chest.position.y = 1.443;
    chest.castShadow = true;
    kit.add(chest);
    ellipsoid(kit, jersey, [0.246, 0.107, 0.14], [0, 1.653, 0]);
    ellipsoid(kit, piping, [0.119, 0.029, 0.105], [0, 1.699, 0.006]);
    ellipsoid(body, skin, [0.071, 0.102, 0.071], [0, 1.738, 0]);
    const head = ellipsoid(body, skin, [0.097, 0.126, 0.099], [0, 1.888, 0.003]);
    head.castShadow = true;
    ellipsoid(body, skin, [0.078, 0.074, 0.081], [0, 1.83, 0.018]);
    const nose = ellipsoid(body, skin, [0.022, 0.042, 0.03], [0, 1.866, 0.099]);
    nose.rotation.x = -0.16;
    ellipsoid(body, skin, [0.025, 0.015, 0.024], [0, 1.853, 0.105]);
    ellipsoid(body, skinShade, [0.028, 0.005, 0.008], [0, 1.82, 0.093]);
    for (const side of [-1, 1]) {
      ellipsoid(body, skin, [0.017, 0.029, 0.019], [side * 0.097, 1.869, 0.002]);
      ellipsoid(body, skinShade, [0.008, 0.014, 0.012], [side * 0.108, 1.868, 0.004]);
      const eye = ellipsoid(body, eyeWhite, [0.021, 0.008, 0.009], [side * 0.043, 1.892, 0.083]);
      eye.rotation.y = side * 0.29;
      ellipsoid(body, hair, [0.008, 0.008, 0.006], [side * 0.043, 1.892, 0.09]);
      const brow = ellipsoid(body, hair, [0.026, 0.005, 0.009], [side * 0.043, 1.908, 0.087]);
      brow.rotation.z = side * 0.12;
      const strip = ellipsoid(kit, piping, [0.018, 0.234, 0.048], [side * 0.2, 1.446, 0]);
      strip.rotation.z = side * -0.115;
      const armhole = ellipsoid(kit, piping, [0.032, 0.073, 0.133], [side * 0.206, 1.625, 0.003]);
      armhole.rotation.z = side * -0.239;
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
    ellipsoid(kit, shorts, [0.223, 0.166, 0.132], [0, 1.093, 0]);
    ellipsoid(kit, piping, [0.213, 0.027, 0.135], [0, 1.195, 0]);

    const ink = uniform.getHSL({ h: 0, s: 0, l: 0 }).l > 0.58 ? '#151e21' : '#f7f2df';
    const digits = numberTexture(player.profile.number, ink, team.abbreviation);
    const numberMaterial = new THREE.MeshBasicMaterial({
      map: digits, transparent: true, depthWrite: false, alphaTest: 0.2, polygonOffset: true, polygonOffsetFactor: -2,
    });
    for (const side of [-1, 1]) {
      const label = new THREE.Mesh(numberGeometry, numberMaterial);
      label.position.set(0, 1.49, side * 0.149);
      label.rotation.y = side < 0 ? Math.PI : 0;
      kit.add(label);
    }

    mergeStaticMeshes(body, false);
    mergeStaticMeshes(kit, false);
    const sharedGeometry = new Set<THREE.BufferGeometry>([sphere, torsoGeometry, numberGeometry]);

    const arms: Limb[] = [];
    const legs: Limb[] = [];
    for (let index = 0; index < 2; index++) {
      const upperArm = new THREE.Mesh(taper, skin);
      const lowerArm = new THREE.Mesh(taper, skin);
      const elbow = ellipsoid(model, skin, [0.055, 0.054, 0.053], [0, 0, 0]);
      const hand = ellipsoid(model, skin, [0.054, 0.073, 0.045], [0, 0, 0]);
      upperArm.castShadow = true;
      model.add(upperArm, lowerArm);
      arms.push({ upper: upperArm, lower: lowerArm, joint: elbow, tip: hand });

      const upperLeg = new THREE.Mesh(taper, shorts);
      const lowerLeg = new THREE.Mesh(taper, skin);
      const knee = ellipsoid(model, skin, [0.074, 0.078, 0.069], [0, 0, 0]);
      const sock = new THREE.Mesh(taper, socks);
      const foot = new THREE.Group();
      ellipsoid(foot, shoes, [0.091, 0.073, 0.177], [0, 0.019, 0.047]);
      ellipsoid(foot, sole, [0.091, 0.025, 0.181], [0, -0.035, 0.048]);
      ellipsoid(foot, piping, [0.064, 0.05, 0.042], [0, 0.035, -0.056]);
      upperLeg.castShadow = true;
      lowerLeg.castShadow = true;
      model.add(upperLeg, lowerLeg, sock, foot);
      legs.push({ upper: upperLeg, lower: lowerLeg, joint: knee, tip: foot, cuff: sock });
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

    function animate(gamePlayer: GamePlayer, time: number, heldBall: Vec3 | undefined, selected: boolean, charge: number) {
      root.position.set(gamePlayer.position.x, 0, gamePlayer.position.z);
      model.rotation.y = Math.PI / 2 - gamePlayer.facing;
      ring.visible = selected;
      meter.visible = selected && charge > 0;
      if (meter.visible) {
        const fraction = Math.min(charge / 1.2, 1);
        meter.geometry.setDrawRange(0, Math.max(6, Math.round(fraction * 64) * 6));
        meterMaterial.color.copy(Math.abs(charge - 0.62) < 0.085 ? chargeGreen : clockGold);
      }

      const speed = Math.hypot(gamePlayer.velocity.x, gamePlayer.velocity.z);
      const running = THREE.MathUtils.clamp(speed / 6.1, 0, 1);
      const cycle = time * (12 + running * 3.4) + (hash % 17) * 0.28;
      const raised = gamePlayer.pose === 'shoot' || gamePlayer.pose === 'contest' || charge > 0;
      const blocked = gamePlayer.pose === 'contest';
      const screening = gamePlayer.pose === 'screen';
      const leaping = raised && charge <= 0;
      const bob = Math.sin(cycle * 2) * 0.025 * running;
      const jump = (leaping ? 0.105 + 0.035 * Math.sin(time * 13 + hash % 23) : 0) + bob;
      const crouch = screening ? 0.07 : Math.min(running * 0.09, 0.09);
      body.position.y = -crouch;
      model.position.y = jump;
      shadow.scale.setScalar(1 + jump * 0.4);
      body.rotation.x = running * 0.085;

      for (let index = 0; index < 2; index++) {
        const sign = index === 0 ? -1 : 1;
        const stride = Math.sin(cycle + index * Math.PI) * 0.34 * running;
        const lift = Math.max(0, Math.cos(cycle + index * Math.PI)) * 0.18 * running;
        const leg = legs[index];
        start.set(sign * 0.124 * thickness, 1.102 - crouch, 0);
        joint.set(sign * (screening ? 0.22 : 0.137), 0.55 + lift * 0.48, stride * 0.59 + 0.08);
        end.set(sign * (screening ? 0.31 : 0.147), 0.115 + lift, stride);
        segment(leg.upper, start, joint, 0.108 * thickness);
        leg.joint.position.copy(joint);
        segment(leg.lower, joint, end, 0.069 * thickness);
        sleeve.copy(end).lerp(joint, 0.3);
        segment(leg.cuff!, sleeve, end, 0.073 * thickness);
        leg.tip.position.set(end.x, end.y - 0.056, end.z);
        leg.tip.rotation.x = running * Math.cos(cycle + index * Math.PI) * 0.28;

        const arm = arms[index];
        start.set(sign * 0.237 * thickness, 1.621 - crouch, 0.001);
        if (blocked) {
          joint.set(sign * 0.38, 1.838 - crouch, 0.06);
          end.set(sign * 0.37, 2.106 - crouch, 0.15);
        } else if (raised) {
          joint.set(sign * 0.228, 1.79 - crouch, 0.249);
          end.set(sign * 0.122, 2.005 - crouch, 0.25);
        } else if (screening) {
          joint.set(sign * 0.31, 1.327 - crouch, 0.082);
          end.set(sign * 0.06, 1.267 - crouch, 0.211);
        } else if (heldBall && index === 1) {
          const dx = heldBall.x - gamePlayer.position.x;
          const dz = heldBall.z - gamePlayer.position.z;
          const rotation = model.rotation.y;
          const handX = (Math.cos(rotation) * dx - Math.sin(rotation) * dz) / normalScale;
          const handZ = (Math.sin(rotation) * dx + Math.cos(rotation) * dz) / normalScale;
          joint.set(0.275, 1.322 - crouch, Math.max(0.046, handZ * 0.36));
          end.set(THREE.MathUtils.clamp(handX, -0.24, 0.45), THREE.MathUtils.clamp((heldBall.y - jump) / normalScale + 0.1, 1.02, 1.58), THREE.MathUtils.clamp(handZ, -0.22, 0.53));
        } else {
          joint.set(sign * 0.287 * thickness, 1.345 - crouch, -stride * 0.61 + 0.012);
          end.set(sign * 0.299 * thickness, 1.098 - crouch + running * 0.12, -stride * 0.92 + running * 0.142);
        }
        segment(arm.upper, start, joint, 0.07 * thickness);
        arm.joint.position.copy(joint);
        segment(arm.lower, joint, end, 0.054 * thickness);
        arm.tip.position.copy(end);
      }
    }

    function dispose() {
      for (const mat of [skin, skinShade, hair, eyeWhite, jersey, piping, shorts, shoes, sole, socks, numberMaterial, meterMaterial]) mat.dispose();
      digits.dispose();
      meter.geometry.dispose();
      body.traverse((mesh) => {
        if (mesh instanceof THREE.Mesh && !sharedGeometry.has(mesh.geometry)) mesh.geometry.dispose();
      });
    }

    return { root, animate, dispose };
  }

  function dispose() {
    for (const geometry of [sphere, taper, torsoGeometry, numberGeometry, ringGeometry, meterGeometry, shadowGeometry]) geometry.dispose();
    shadowMaterial.map?.dispose();
    shadowMaterial.dispose();
    ringMaterial.dispose();
  }

  return { build, dispose };
}
