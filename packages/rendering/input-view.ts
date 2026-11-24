import type { Camera } from 'three';
import type { Vec2 } from '../contracts/index.ts';

/** Convert screen-right/screen-down to court coordinates for either renderer. */
export function courtMovement(camera: Camera, move: Vec2): Vec2 {
  const x = camera.matrixWorld.elements[0];
  const z = camera.matrixWorld.elements[2];
  const length = Math.hypot(x, z);
  if (length < 0.001) return move;
  return { x: (x * move.x - z * move.z) / length, z: (z * move.x + x * move.z) / length };
}
