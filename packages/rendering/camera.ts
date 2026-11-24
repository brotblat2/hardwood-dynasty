import { MathUtils, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { attackSign, type GameState } from '../contracts/index.ts';
import type { Camera } from './index.ts';

export function makeGameCamera(camera: PerspectiveCamera) {
  const position = new Vector3();
  const target = new Vector3();
  const look = new Vector3();
  let lastTick = -1;
  let lastView: Camera | undefined;
  let lastAspect = 0;

  return function placeCamera(state: GameState, view: Camera, selectedId: string | undefined, dt: number) {
    const half = state.config.halfCourt === true;
    const { x, z } = state.ball.position;
    const zoom = Math.max(1, 1.53 / camera.aspect);
    const center = half ? MathUtils.clamp(6.7 + (x - 6.7) * 0.31, 5.6, 8.8) : MathUtils.clamp(x * 0.56, -7.2, 7.2);
    let fov = 38;
    if (view === 'baseline') {
      // Keep the viewing axis stable when a pass or dribble crosses midcourt.
      const team = state.players.find(player => player.id === selectedId)?.side ?? 0;
      const end = half ? -1 : -attackSign(team);
      target.set(half ? center : center * 0.85, 0.65, z * 0.16);
      position.set(target.x + end * 20.3 * zoom, 12.5 * zoom, 12.5 * zoom);
      fov = 41;
    } else if (view === 'courtside') {
      target.set(center, 1.08, z * 0.26);
      position.set(center + 1.8, 5.1 * zoom, 14.8 * zoom + z * 0.16);
      fov = 44;
    } else if (view === 'player') {
      const active = state.players.find((player) => player.id === selectedId) ?? state.players.find((player) => player.id === state.ball.ownerId);
      const px = active?.position.x ?? x;
      const pz = active?.position.z ?? z;
      // Track from behind the player towards the hoop, even during pivots and crossovers.
      const attack = half ? 1 : attackSign(active?.side ?? 0);
      const hoopX = attack * 12.65;
      const dxRaw = attack * Math.max(3, attack * (hoopX - px));
      const length = Math.hypot(dxRaw, pz * 0.45);
      const dx = dxRaw / length;
      const dz = -pz * 0.45 / length;
      target.set(px + dx * 3.3, 1.2, pz + dz * 3.3);
      position.set(px - dx * 5.85 * zoom, 3.9 * zoom, pz - dz * 5.85 * zoom);
      fov = 54;
    } else if (view === 'cinematic') {
      target.set(center, 0.9, z * 0.24);
      position.set(center + (7.4 + Math.sin(state.tick * 0.007) * 1.65) * zoom, 8.8 * zoom, 16.1 * zoom);
      fov = 41;
    } else {
      const distance = (half ? 0.85 : 1) * zoom;
      target.set(center, 0.68, z * 0.15);
      position.set(center + (half ? -0.75 : 0.8), 15.7 * distance, 20.2 * distance + z * 0.16);
    }
    const reset = state.tick < lastTick || lastView !== view || lastAspect !== camera.aspect;
    const settle = reset ? 1 : 1 - Math.exp(-dt * (view === 'player' ? 7.5 : 4.8));
    if (!reset && camera.position.distanceToSquared(position) < 0.000004 && look.distanceToSquared(target) < 0.000004) return;
    camera.position.lerp(position, settle);
    look.lerp(target, settle);
    camera.fov = fov;
    camera.lookAt(look);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    lastTick = state.tick;
    lastView = view;
    lastAspect = camera.aspect;
  };
}
