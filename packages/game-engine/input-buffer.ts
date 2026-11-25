import type { Control } from '../contracts/index.ts';
import { INPUT_BUFFER_TICKS } from './types.ts';
import type { BufferedActionEntry, BufferedActionKind, InputBufferState, Runtime } from './types.ts';

function ensurePlayerBuffer(sim: Runtime, playerId: string): InputBufferState {
  sim.inputBuffer ??= {};
  return (sim.inputBuffer[playerId] ??= { queue: [] });
}

/** Prune expired entries and record rising-edge actions for 150ms deterministic input buffering. */
export function recordControlEdges(sim: Runtime, playerId: string, control: Control | undefined, tick: number): void {
  const buf = ensurePlayerBuffer(sim, playerId);
  buf.queue = buf.queue.filter(entry => entry.expires >= tick);

  const dribbleDown = !!control?.dribble;
  const passDown = !!control?.pass;
  const fakeDown = !!control?.pumpFake;
  const shootDown = !!control?.shoot;

  if (dribbleDown && !buf.prevDribble) {
    const rawDir = control?.dribbleDir && Math.hypot(control.dribbleDir.x, control.dribbleDir.z) > 0.15
      ? control.dribbleDir
      : control?.move;
    const dir = rawDir && Math.hypot(rawDir.x, rawDir.z) > 0.05 ? { x: rawDir.x, z: rawDir.z } : undefined;
    // Keep at most two queued dribble combos so chains feel snappy without runaway buffering.
    const existingDribbles = buf.queue.filter(e => e.kind === 'dribble').length;
    if (existingDribbles >= 2) {
      const idx = buf.queue.findIndex(e => e.kind === 'dribble');
      if (idx >= 0) buf.queue.splice(idx, 1);
    }
    buf.queue.push({ kind: 'dribble', tick, expires: tick + INPUT_BUFFER_TICKS, ...(dir ? { dir } : {}) });
  }

  if (passDown && !buf.prevPass) {
    buf.queue.push({
      kind: 'pass',
      tick,
      expires: tick + INPUT_BUFFER_TICKS,
      ...(control?.targetId ? { targetId: control.targetId } : {}),
      ...(control?.passType ? { passType: control.passType } : {}),
    });
  }

  if (fakeDown && !buf.prevPumpFake) {
    buf.queue.push({ kind: 'pumpFake', tick, expires: tick + INPUT_BUFFER_TICKS });
  }

  if (shootDown && !buf.prevShoot) {
    buf.queue.push({ kind: 'shoot', tick, expires: tick + INPUT_BUFFER_TICKS });
  }

  buf.prevDribble = dribbleDown;
  buf.prevPass = passDown;
  buf.prevPumpFake = fakeDown;
  buf.prevShoot = shootDown;
}

/** Consume the oldest unexpired buffered entry matching `kind`, if one exists. */
export function consumeBuffered(
  sim: Runtime,
  playerId: string,
  kind: BufferedActionKind,
  tick: number,
): BufferedActionEntry | undefined {
  const buf = sim.inputBuffer?.[playerId];
  if (!buf?.queue.length) return undefined;
  const idx = buf.queue.findIndex(entry => entry.kind === kind && entry.expires >= tick);
  if (idx < 0) return undefined;
  return buf.queue.splice(idx, 1)[0];
}

/** Peek whether an unexpired buffered action of `kind` is waiting. */
export function hasBuffered(sim: Runtime, playerId: string, kind: BufferedActionKind, tick: number): boolean {
  const buf = sim.inputBuffer?.[playerId];
  return !!buf?.queue.some(entry => entry.kind === kind && entry.expires >= tick);
}

/** Drop queued actions (used on turnovers, possession changes, or dead balls). */
export function clearPlayerBuffer(sim: Runtime, playerId: string): void {
  const buf = sim.inputBuffer?.[playerId];
  if (buf) buf.queue = [];
}
