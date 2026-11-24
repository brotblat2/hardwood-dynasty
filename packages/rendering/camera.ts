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
  let currentAttack = 1;

  return function placeCamera(state: GameState, view: Camera, selectedId: string | undefined, dt: number) {
    const half = state.config.halfCourt === true;
    const { x, z } = state.ball.position;
    const zoom = Math.max(1, 1.53 / camera.aspect);
    const center = half ? MathUtils.clamp(6.7 + (x - 6.7) * 0.31, 5.6, 8.8) : MathUtils.clamp(x * 0.56, -7.2, 7.2);
    const reset = state.tick < lastTick || lastView !== view || lastAspect !== camera.aspect;
    const targetAttack = half ? 1 : attackSign(state.possession);
    currentAttack = reset ? targetAttack : MathUtils.lerp(currentAttack, targetAttack, 1 - Math.exp(-dt * 3.2));

    let fov = 38;
    if (state.freeThrow && view !== 'player' && view !== 'cinematic') {
      const shooter = state.players.find(player => player.id === state.freeThrow!.shooterId);
      if (shooter) {
        const ftAttack = half ? 1 : attackSign(shooter.side);
        const rimX = ftAttack * 12.65;
        target.set((shooter.position.x + rimX) * 0.5, 1.65, 0);
        if (view === '2k') {
          position.set(shooter.position.x - ftAttack * 6.8 * zoom, 4.9 * zoom, 1.6);
          fov = 40;
        } else if (view === 'baseline') {
          position.set(rimX + ftAttack * 6.4 * zoom, 5.4 * zoom, 3.8 * zoom);
          fov = 38;
        } else {
          position.set((shooter.position.x + rimX) * 0.5, 6.2 * zoom, 10.2 * zoom);
          fov = 36;
        }
      }
    } else if (view === '2k') {
      target.set(center + currentAttack * 5.2, 1.35, z * 0.22);
      position.set(center - currentAttack * (half ? 11.4 : 13.6) * zoom, (half ? 7.6 : 8.5) * zoom, MathUtils.clamp(z * 0.34, -3.4, 3.4));
      fov = 44;
    } else if (view === 'baseline') {
      // Keep the viewing axis stable when a pass or dribble crosses midcourt.
      const team = state.players.find(player => player.id === selectedId)?.side ?? 0;
      const end = half ? -1 : -attackSign(team);
      target.set(half ? center : center * 0.85, 0.72, z * 0.14);
      position.set(target.x + end * 18.8 * zoom, 10.6 * zoom, 6.2 * zoom);
      fov = 42;
    } else if (view === 'courtside') {
      target.set(center, 1.08, z * 0.26);
      position.set(center + 1.8, 5.1 * zoom, 14.8 * zoom + z * 0.16);
      fov = 44;
    } else if (view === 'player') {
      const active = state.players.find((player) => player.id === selectedId) ?? state.players.find((player) => player.id === state.ball.ownerId);
      const px = active?.position.x ?? x;
      const pz = active?.position.z ?? z;
      // Track from behind the player towards the hoop (or ballhandler on defense).
      const attack = half ? 1 : attackSign(active?.side ?? 0);
      const hoopX = attack * 12.65;
      let dxRaw = attack * Math.max(3, attack * (hoopX - px));
      let dzRaw = -pz * 0.45;
      if (active && active.side !== state.possession) {
        const bx = x - px;
        const bz = z - pz;
        const bLen = Math.hypot(bx, bz);
        if (bLen > 0.4) {
          dxRaw = dxRaw * 0.35 + (bx / bLen) * 6.0;
          dzRaw = dzRaw * 0.35 + (bz / bLen) * 6.0;
        }
      }
      const length = Math.max(0.01, Math.hypot(dxRaw, dzRaw));
      const dx = dxRaw / length;
      const dz = dzRaw / length;
      target.set(px + dx * 3.3, 1.2, pz + dz * 3.3);
      position.set(px - dx * 5.85 * zoom, 3.9 * zoom, pz - dz * 5.85 * zoom);
      fov = 54;
    } else if (view === 'cinematic') {
      target.set(center, 0.9, z * 0.24);
      position.set(center + (7.4 + Math.sin(state.tick * 0.007) * 1.65) * zoom, 8.8 * zoom, 16.1 * zoom);
      fov = 41;
    } else {
      const lead = targetAttack * 1.45;
      const midZoom = 1 + Math.max(0, 1 - Math.abs(x) / 6) * 0.08;
      const distance = (half ? 0.85 : 1) * zoom * midZoom;
      target.set(center + lead * 0.5, 0.68, z * 0.15);
      position.set(center + (half ? -0.75 : 0.8) + lead * 0.25, 15.7 * distance, 20.2 * distance + z * 0.16);
    }

    let impactAge = Infinity;
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      const age = state.tick - ev.tick;
      if (age >= 14) break;
      if (ev.type === 'block') { impactAge = age; break; }
      if (ev.type === 'score') {
        const dunkShot = state.events.slice(Math.max(0, i - 10), i).some(s => s.type === 'shot' && s.playerId === ev.playerId && s.detail?.startsWith('Dunk'));
        if (dunkShot) { impactAge = age; break; }
      }
    }
    if (impactAge < 14) {
      const mag = (1 - impactAge / 14) * 0.065;
      position.x += Math.sin(state.tick * 2.7) * mag;
      position.y += Math.cos(state.tick * 3.4) * mag;
    }

    const settle = reset ? 1 : 1 - Math.exp(-dt * (view === 'player' ? 7.5 : 4.8));
    if (!reset && impactAge >= 14 && camera.fov === fov && camera.position.distanceToSquared(position) < 0.000004 && look.distanceToSquared(target) < 0.000004) return;
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
