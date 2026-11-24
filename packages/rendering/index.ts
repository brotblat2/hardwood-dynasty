import * as THREE from 'three';
import { TICK_RATE } from '../contracts/index.ts';
import type { GameState, Vec2, Vec3 } from '../contracts/index.ts';
import { makeArena, makeHoops } from './arena.ts';
import { makeBall, makeCourt, makeCourtTexture } from './court.ts';
import { makePlayerFactory } from './player.ts';
import { courtMovement } from './input-view.ts';
import { createCanvasFallback } from './fallback.ts';
import { makeGameCamera } from './camera.ts';
import { motionEvents } from './motion.ts';

export type Camera = 'broadcast' | 'baseline' | 'courtside' | 'player' | 'cinematic';
export type Quality = 'low' | 'high';
export type RendererOptions = { quality?: Quality; camera?: Camera };
export type GameRenderer = {
  draw(state: GameState, selectedId?: string): void;
  setCamera(camera: Camera): void;
  setQuality(quality: Quality): void;
  dispose(): void;
  projectMove(move: Vec2): Vec2;
  pickPlayer(x: number, y: number): string | undefined;
};

type PickTarget = { id: string; x: number; y: number; width: number; height: number };

function releaseScene(scene: THREE.Scene) {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    }
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  for (const material of materials) {
    if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose();
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
}

export function createRenderer(container: HTMLElement, options: RendererOptions = {}): GameRenderer {
  let webgl: THREE.WebGLRenderer;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!context) return createCanvasFallback(container, options);
    webgl = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false });
  } catch {
    return createCanvasFallback(container, options);
  }

  webgl.outputColorSpace = THREE.SRGBColorSpace;
  webgl.toneMapping = THREE.NeutralToneMapping;
  webgl.toneMappingExposure = 0.94;
  webgl.shadowMap.type = THREE.PCFShadowMap;
  const element = webgl.domElement;
  element.style.display = 'block';
  element.style.width = '100%';
  element.style.height = '100%';
  element.setAttribute('aria-label', 'Hardwood Dynasty 3D basketball court');
  element.setAttribute('role', 'img');
  container.append(element);

  let cameraMode: Camera = options.camera ?? 'broadcast';
  let quality: Quality = options.quality ?? 'high';
  const scene = new THREE.Scene();
  const indoorColor = new THREE.Color(0x121918);
  const outdoorColor = new THREE.Color(0x293d45);
  scene.background = indoorColor;
  scene.fog = new THREE.FogExp2(indoorColor, 0.012);
  const perspective = new THREE.PerspectiveCamera(36, 1, 0.13, 115);
  const placeCamera = makeGameCamera(perspective);
  let lastFrame = 0;
  let lastCrowdDraw = -Infinity;
  let floorMode: boolean | undefined;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastRatio = 0;
  let lastBallTick = -1;
  const ballAxis = new THREE.Vector3();
  const ballTurn = new THREE.Quaternion();

  const ambient = new THREE.HemisphereLight(0xffecd2, 0x61777b, 1.52);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xfff0df, 2.55);
  key.position.set(-6.4, 16, 8);
  key.castShadow = true;
  key.shadow.camera.left = -17;
  key.shadow.camera.right = 17;
  key.shadow.camera.top = 11;
  key.shadow.camera.bottom = -11;
  key.shadow.camera.near = 0.2;
  key.shadow.camera.far = 33;
  key.shadow.mapSize.set(1536, 1536);
  key.shadow.normalBias = 0.018;
  key.shadow.bias = -0.00007;
  key.shadow.radius = 2;
  const fill = new THREE.DirectionalLight(0xdbeeff, 1.24);
  fill.position.set(7, 9, -12);
  const bounce = new THREE.DirectionalLight(0xffd69a, 0.26);
  bounce.position.set(2.3, -4.2, 7);
  scene.add(key, fill, bounce);

  const arena = makeArena();
  const court = makeCourt();
  const hoops = makeHoops();
  const anisotropy = Math.min(8, webgl.capabilities.getMaxAnisotropy());
  const ball = makeBall(anisotropy);
  const factories = makePlayerFactory();
  const players = new Map<string, ReturnType<typeof factories.build>>();
  const textures = new Map<boolean, THREE.Texture>();
  const samples = new Map<string, PickTarget>();
  const projectedFeet = new THREE.Vector3();
  const projectedHead = new THREE.Vector3();
  scene.add(arena.group, court, hoops.group, ball);

  const ballShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.17, 24),
    new THREE.MeshBasicMaterial({ color: 0x16140b, transparent: true, opacity: 0.23, depthWrite: false }),
  );
  ballShadow.rotation.x = -Math.PI / 2;
  ballShadow.position.y = 0.014;
  scene.add(ballShadow);

  function setQuality(next: Quality) {
    quality = next;
    webgl.shadowMap.enabled = quality === 'high';
  }
  setQuality(quality);

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.65 : 1);
    if (width !== lastWidth || height !== lastHeight || ratio !== lastRatio) {
      webgl.setPixelRatio(ratio);
      webgl.setSize(width, height, false);
      lastWidth = width;
      lastHeight = height;
      lastRatio = ratio;
      perspective.aspect = width / height;
    }
    return true;
  }

  function setMode(blacktop: boolean) {
    if (floorMode === blacktop) return;
    floorMode = blacktop;
    arena.setOutdoor(blacktop);
    scene.background = blacktop ? outdoorColor : indoorColor;
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(scene.background);
    fog.density = blacktop ? 0.014 : 0.012;
    ambient.color.set(blacktop ? 0xd0edff : 0xffecd2);
    key.color.set(blacktop ? 0xffe2be : 0xfff0d8);
    if (!textures.has(blacktop)) textures.set(blacktop, makeCourtTexture(blacktop, anisotropy));
    court.material.roughness = blacktop ? 0.82 : 0.39;
    court.material.clearcoat = blacktop ? 0 : 0.46;
    court.material.map = textures.get(blacktop)!;
    court.material.needsUpdate = true;
  }

  function draw(state: GameState, selectedId?: string) {
    if (!resize()) return;
    const time = performance.now() / 1_000;
    const dt = Math.min(0.1, time - lastFrame);
    lastFrame = time;
    setMode(state.config.mode === 'blacktop');
    if (time - lastCrowdDraw > (quality === 'high' ? 0.076 : 0.16)) {
      const score = state.events.findLast((event) => event.type === 'score');
      const cheer = score ? Math.max(0, 1 - (state.tick - score.tick) / (2.3 * TICK_RATE)) : 0;
      arena.animate(time, cheer);
      lastCrowdDraw = time;
    }

    placeCamera(state, cameraMode, selectedId, dt);
    const events = motionEvents(state);
    hoops.animate(state);
    const activeIds = new Set<string>();
    samples.clear();
    for (const player of state.players) {
      activeIds.add(player.id);
      let actor = players.get(player.id);
      if (!actor) {
        actor = factories.build(player, state.teams[player.side]);
        players.set(player.id, actor);
        scene.add(actor.root);
      }
      const hasBall = state.ball.ownerId === player.id;
      actor.animate(player, state.tick, hasBall ? state.ball.position : undefined, selectedId === player.id, state.charge[player.id] ?? 0, events.get(player.id));
      projectedFeet.set(player.position.x, 0.05, player.position.z).project(perspective);
      projectedHead.set(player.position.x, 2, player.position.z).project(perspective);
      if (projectedFeet.z >= -1 && projectedFeet.z <= 1) {
        const height = Math.abs(projectedHead.y - projectedFeet.y) * lastHeight * 0.5;
        samples.set(player.id, {
          id: player.id,
          x: ((projectedFeet.x + projectedHead.x) / 4 + 0.5) * lastWidth,
          y: (0.5 - (projectedFeet.y + projectedHead.y) / 4) * lastHeight,
          width: Math.max(16, height * 0.38),
          height: Math.max(18, height * 0.67),
        });
      }
    }
    for (const [id, actor] of players) {
      if (activeIds.has(id)) continue;
      actor.root.removeFromParent();
      actor.dispose();
      players.delete(id);
    }

    const { position, velocity, ownerId, spin } = state.ball as typeof state.ball & { spin?: Vec3 };
    ball.position.set(position.x, Math.max(position.y, 0.122), position.z);
    const elapsed = Math.max(0, Math.min(8, state.tick - lastBallTick)) / TICK_RATE;
    if (state.tick < lastBallTick) ball.quaternion.identity();
    if (spin) ballAxis.set(spin.x, spin.y, spin.z);
    else if (ownerId === null) ballAxis.set(velocity.z * 0.55 + 2.2, 0.4, -velocity.x * 0.7 - 2.8);
    else ballAxis.set(1.1, 2.4, 0.36);
    const radians = ballAxis.length() * elapsed;
    if (radians) ball.quaternion.premultiply(ballTurn.setFromAxisAngle(ballAxis.normalize(), radians));
    lastBallTick = state.tick;
    ballShadow.position.set(position.x, 0.014, position.z);
    ballShadow.scale.setScalar(1 + Math.min(position.y, 8) * 0.18);
    ballShadow.material.opacity = 0.25 / (1 + position.y * 0.24);
    webgl.render(scene, perspective);
  }

  function pickPlayer(x: number, y: number) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    const localX = (x - rect.left) / rect.width * lastWidth;
    const localY = (y - rect.top) / rect.height * lastHeight;
    let nearest: string | undefined;
    let best = 1;
    for (const target of samples.values()) {
      const distance = ((localX - target.x) / target.width) ** 2 + ((localY - target.y) / target.height) ** 2;
      if (distance < best) {
        best = distance;
        nearest = target.id;
      }
    }
    return nearest;
  }

  function dispose() {
    for (const actor of players.values()) {
      actor.root.removeFromParent();
      actor.dispose();
    }
    players.clear();
    factories.dispose();
    court.material.map = null;
    for (const texture of textures.values()) texture.dispose();
    key.shadow.dispose();
    releaseScene(scene);
    webgl.dispose();
    webgl.forceContextLoss();
    element.remove();
  }

  return { draw, setQuality, setCamera(camera) { cameraMode = camera; }, dispose, pickPlayer, projectMove: move => courtMovement(perspective, move) };
}
