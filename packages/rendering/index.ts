import * as THREE from 'three';
import { TICK_RATE } from '../contracts/index.ts';
import type { GameState, Team, Vec2, Vec3 } from '../contracts/index.ts';
import { makeArena, makeHoops } from './arena.ts';
import { makeBall, makeCourt, makeCourtMaps, makeCourtTexture } from './court.ts';
import { makePlayerFactory } from './player.ts';
import { resolveKitPalette } from './jerseys.ts';
import { courtMovement } from './input-view.ts';
import { createCanvasFallback } from './fallback.ts';
import { makeGameCamera } from './camera.ts';
import { motionEvents } from './motion.ts';

export type Camera = 'broadcast' | '2k' | 'baseline' | 'courtside' | 'player' | 'cinematic';
export type Quality = 'low' | 'high';
export type RendererOptions = { quality?: Quality; camera?: Camera };
export type RenderHints = { passTargetId?: string };
export type GameRenderer = {
  draw(state: GameState, selectedId?: string, hints?: RenderHints): void;
  setCamera(camera: Camera): void;
  setQuality(quality: Quality): void;
  dispose(): void;
  projectMove(move: Vec2): Vec2;
  projectPoint(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
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
    if ('bumpMap' in material && material.bumpMap instanceof THREE.Texture) material.bumpMap.dispose();
    if ('roughnessMap' in material && material.roughnessMap instanceof THREE.Texture) material.roughnessMap.dispose();
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
}

function makeArenaEnvironment(webgl: THREE.WebGLRenderer, blacktop: boolean) {
  const pmrem = new THREE.PMREMGenerator(webgl);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(blacktop ? 0x3b5866 : 0x161f22);
  const mats: THREE.Material[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const addPanel = (color: number, w: number, h: number, y: number, rx: number, z = 0) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, y, z);
    mesh.rotation.x = rx;
    envScene.add(mesh);
    mats.push(mat);
    geos.push(geo);
  };
  addPanel(blacktop ? 0xfff1da : 0xfff5e4, 24, 14, 12, Math.PI / 2);
  addPanel(0x885c34, 24, 16, -6, -Math.PI / 2);
  addPanel(blacktop ? 0x5c8aa4 : 0x36526c, 28, 7, 3, 0, -14);
  const rt = pmrem.fromScene(envScene, 0.04);
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  pmrem.dispose();
  return rt;
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
  webgl.toneMapping = THREE.ACESFilmicToneMapping;
  webgl.toneMappingExposure = 1.04;
  webgl.shadowMap.type = THREE.PCFSoftShadowMap;
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
  let floorKey: string | undefined;
  let envKey: string | undefined;
  let envRT: THREE.WebGLRenderTarget | undefined;
  let kitSignature = '';
  let cachedKitQuery = '';
  let cachedPalettes: [ReturnType<typeof resolveKitPalette>, ReturnType<typeof resolveKitPalette>] | undefined;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastRatio = 0;
  let lastBallTick = -1;
  let lastTrailTick = -1;
  const ballAxis = new THREE.Vector3();
  const ballTurn = new THREE.Quaternion();

  const ambient = new THREE.HemisphereLight(0xffecd2, 0x5c7278, 1.38);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xfff0df, 2.75);
  key.position.set(-6.4, 16, 8);
  key.castShadow = true;
  key.shadow.camera.left = -17;
  key.shadow.camera.right = 17;
  key.shadow.camera.top = 11;
  key.shadow.camera.bottom = -11;
  key.shadow.camera.near = 0.2;
  key.shadow.camera.far = 33;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.normalBias = 0.018;
  key.shadow.bias = -0.00007;
  key.shadow.radius = 2;
  const fill = new THREE.DirectionalLight(0xdbeeff, 1.18);
  fill.position.set(7, 9, -12);
  const rimLight = new THREE.DirectionalLight(0xc8e4ff, 1.05);
  rimLight.position.set(0, 11, -13);
  const bounce = new THREE.DirectionalLight(0xffd69a, 0.28);
  bounce.position.set(2.3, -4.2, 7);
  scene.add(key, fill, rimLight, bounce);

  const arena = makeArena();
  const court = makeCourt();
  const hoops = makeHoops();
  const anisotropy = Math.min(8, webgl.capabilities.getMaxAnisotropy());
  const ball = makeBall(anisotropy);
  const factories = makePlayerFactory(anisotropy);
  const players = new Map<string, ReturnType<typeof factories.build>>();
  const textures = new Map<string, THREE.Texture>();
  const courtMapsCache = new Map<string, { bumpMap: THREE.Texture; roughnessMap: THREE.Texture }>();
  const samples = new Map<string, PickTarget>();
  const projectedFeet = new THREE.Vector3();
  const projectedHead = new THREE.Vector3();
  const projectedTemp = new THREE.Vector3();
  scene.add(arena.group, court, hoops.group, ball);

  const ballShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.17, 24),
    new THREE.MeshBasicMaterial({ color: 0x16140b, transparent: true, opacity: 0.23, depthWrite: false }),
  );
  ballShadow.rotation.x = -Math.PI / 2;
  ballShadow.position.y = 0.014;
  scene.add(ballShadow);

  const passRing = new THREE.Mesh(
    new THREE.RingGeometry(0.37, 0.43, 32),
    new THREE.MeshBasicMaterial({ color: 0x62e5ff, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }),
  );
  passRing.rotation.x = -Math.PI / 2;
  passRing.position.y = 0.023;
  passRing.renderOrder = 3;
  passRing.visible = false;
  scene.add(passRing);

  const trailGeometry = new THREE.SphereGeometry(0.085, 10, 8);
  const trailMeshes = Array.from({ length: 6 }, (_, i) => {
    const mesh = new THREE.Mesh(
      trailGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffa652, transparent: true, opacity: (i + 1) / 7 * 0.28, depthWrite: false }),
    );
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });
  const trailPoints: Vec3[] = [];

  function setQuality(next: Quality) {
    quality = next;
    webgl.shadowMap.enabled = quality === 'high';
    const size = 1024;
    if (key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
  }
  setQuality(quality);

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.25 : 1);
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

  function setMode(blacktop: boolean, homeTeam?: Team) {
    const nextEnvKey = blacktop ? 'blacktop' : 'indoor';
    if (envKey !== nextEnvKey) {
      envKey = nextEnvKey;
      envRT?.dispose();
      envRT = makeArenaEnvironment(webgl, blacktop);
      scene.environment = envRT.texture;
    }
    const key = blacktop ? 'blacktop' : `team:${homeTeam?.id ?? 'default'}`;
    if (floorKey === key) return;
    floorKey = key;
    arena.setOutdoor(blacktop);
    arena.setTeam(blacktop ? undefined : homeTeam);
    hoops.setOutdoor(blacktop);
    scene.background = blacktop ? outdoorColor : indoorColor;
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(scene.background);
    fog.density = blacktop ? 0.014 : 0.012;
    ambient.color.set(blacktop ? 0xd0edff : 0xffecd2);
    keyLight(blacktop);
    if (!textures.has(key)) textures.set(key, makeCourtTexture(blacktop, anisotropy, homeTeam));
    const parquet = !blacktop && homeTeam?.abbreviation.toUpperCase() === 'BOS';
    const mapsKey = blacktop ? 'blacktop' : parquet ? 'parquet' : 'maple';
    if (!courtMapsCache.has(mapsKey)) courtMapsCache.set(mapsKey, makeCourtMaps(blacktop, anisotropy, parquet));
    const maps = courtMapsCache.get(mapsKey)!;
    court.material.roughness = blacktop ? 0.86 : 0.34;
    court.material.map = textures.get(key)!;
    court.material.bumpMap = maps.bumpMap;
    court.material.roughnessMap = maps.roughnessMap;
    court.material.needsUpdate = true;
  }

  function keyLight(blacktop: boolean) {
    key.color.set(blacktop ? 0xffdfb3 : 0xfff0d8);
  }

  function draw(state: GameState, selectedId?: string, hints?: RenderHints) {
    if (!resize()) return;
    const time = performance.now() / 1_000;
    const dt = Math.min(0.1, time - lastFrame);
    lastFrame = time;
    setMode(state.config.mode === 'blacktop', state.teams[0]);
    const score = state.events.findLast((event) => event.type === 'score');
    const cheer = score ? Math.max(0, 1 - (state.tick - score.tick) / (2.3 * TICK_RATE)) : 0;
    const crowdInterval = cheer > 0.02 ? 0.075 : (quality === 'high' ? 0.18 : 0.32);
    if (time - lastCrowdDraw > crowdInterval) {
      arena.animate(time, cheer, state);
      lastCrowdDraw = time;
    }

    const kitQuery = `${state.teams[0].id}:${state.teams[1].id}:${state.config.kits?.[0] ?? ''}:${state.config.kits?.[1] ?? ''}`;
    if (kitQuery !== cachedKitQuery || !cachedPalettes) {
      cachedKitQuery = kitQuery;
      const homeP = resolveKitPalette(state.teams[0], 0, state.config.kits?.[0]);
      const awayP = resolveKitPalette(state.teams[1], 1, state.config.kits?.[1], homeP.base);
      cachedPalettes = [homeP, awayP];
    }
    const [homePalette, awayPalette] = cachedPalettes;
    const nextKitSig = `${homePalette.base}:${awayPalette.base}:${state.teams[0].id}:${state.teams[1].id}`;
    if (nextKitSig !== kitSignature) {
      kitSignature = nextKitSig;
      for (const actor of players.values()) {
        actor.root.removeFromParent();
        actor.dispose();
      }
      players.clear();
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
        actor = factories.build(player, state.teams[player.side], player.side === 0 ? homePalette : awayPalette);
        players.set(player.id, actor);
        scene.add(actor.root);
      }
      const hasBall = state.ball.ownerId === player.id;
      const greenPulse = state.shotFeedback?.green && state.shotFeedback.playerId === player.id && state.tick - state.shotFeedback.tick >= 0 && state.tick - state.shotFeedback.tick < 36
        ? 1 - (state.tick - state.shotFeedback.tick) / 36
        : 0;
      actor.animate(player, state.tick, hasBall ? state.ball.position : undefined, selectedId === player.id, state.charge[player.id] ?? 0, events.get(player.id), greenPulse);
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

    const passTarget = hints?.passTargetId && hints.passTargetId !== selectedId
      ? state.players.find(player => player.id === hints.passTargetId)
      : undefined;
    if (passTarget) {
      passRing.visible = true;
      passRing.position.set(passTarget.position.x, 0.023, passTarget.position.z);
      passRing.scale.setScalar(1 + Math.sin(time * 7) * 0.05);
    } else {
      passRing.visible = false;
    }

    const { position, velocity, ownerId, spin } = state.ball as typeof state.ball & { spin?: Vec3 };
    const ballY = Math.max(position.y, 0.122);
    ball.position.set(position.x, ballY, position.z);
    if (state.ball.kind === 'shot' || state.ball.kind === 'pass') {
      if (state.tick < lastTrailTick) trailPoints.length = 0;
      if (state.tick !== lastTrailTick) {
        trailPoints.push({ x: position.x, y: ballY, z: position.z });
        if (trailPoints.length > trailMeshes.length) trailPoints.shift();
        lastTrailTick = state.tick;
      }
      for (let i = 0; i < trailMeshes.length; i++) {
        const idx = trailPoints.length - 1 - (trailMeshes.length - 1 - i);
        const pt = idx >= 0 ? trailPoints[idx] : undefined;
        const mesh = trailMeshes[i];
        if (pt && idx < trailPoints.length - 1) {
          mesh.visible = true;
          mesh.position.set(pt.x, pt.y, pt.z);
          mesh.scale.setScalar(0.45 + (i / trailMeshes.length) * 0.55);
        } else {
          mesh.visible = false;
        }
      }
    } else {
      trailPoints.length = 0;
      for (const mesh of trailMeshes) mesh.visible = false;
    }

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

  function projectPoint(x: number, y: number, z: number) {
    projectedTemp.set(x, y, z).project(perspective);
    return {
      x: (projectedTemp.x + 1) * 0.5 * element.clientWidth,
      y: (1 - projectedTemp.y) * 0.5 * element.clientHeight,
      visible: projectedTemp.z >= -1 && projectedTemp.z <= 1,
    };
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
    scene.environment = null;
    envRT?.dispose();
    court.material.map = null;
    court.material.bumpMap = null;
    court.material.roughnessMap = null;
    for (const texture of textures.values()) texture.dispose();
    for (const maps of courtMapsCache.values()) {
      maps.bumpMap.dispose();
      maps.roughnessMap.dispose();
    }
    key.shadow.dispose();
    releaseScene(scene);
    webgl.dispose();
    webgl.forceContextLoss();
    element.remove();
  }

  return { draw, setQuality, setCamera(camera) { cameraMode = camera; }, dispose, pickPlayer, projectPoint, projectMove: move => courtMovement(perspective, move) };
}
