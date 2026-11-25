import type { GameState, Vec3 } from '../contracts/index.ts';

export type PrevPlayerFrame = {
  x: number;
  z: number;
  facing: number;
  jumpHeight: number;
  moveProgress: number;
  gatherPhase: number;
};

export type PrevFrame = {
  tick: number;
  players: Map<string, PrevPlayerFrame>;
  ball: Vec3;
  charge: Record<string, number>;
  meterProgress?: number;
};

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const lerpNum = (a: number, b: number, t: number) => a + (b - a) * t;

/** Capture lightweight simulation pose snapshot prior to advancing a 60Hz tick. */
export function captureFrame(state: GameState): PrevFrame {
  const players = new Map<string, PrevPlayerFrame>();
  for (const p of state.players) {
    players.set(p.id, {
      x: p.position.x,
      z: p.position.z,
      facing: p.facing,
      jumpHeight: p.action?.jumpHeight ?? 0,
      moveProgress: p.action?.moveProgress ?? 0,
      gatherPhase: p.action?.gatherPhase ?? 0,
    });
  }
  return {
    tick: state.tick,
    players,
    ball: { ...state.ball.position },
    charge: { ...state.charge },
    meterProgress: state.shotMeter?.progress,
  };
}

/** Produce a sub-frame interpolated render snapshot for display refresh rates (60/120/144Hz). */
export function interpolateState(prev: PrevFrame | null, curr: GameState, alpha: number): GameState {
  if (!prev || alpha >= 0.999 || curr.tick !== prev.tick + 1 || curr.phase !== 'live') return curr;

  const ballDist = Math.hypot(
    curr.ball.position.x - prev.ball.x,
    curr.ball.position.y - prev.ball.y,
    curr.ball.position.z - prev.ball.z,
  );
  const ballPos = ballDist < 2.4
    ? {
      x: lerpNum(prev.ball.x, curr.ball.position.x, alpha),
      y: lerpNum(prev.ball.y, curr.ball.position.y, alpha),
      z: lerpNum(prev.ball.z, curr.ball.position.z, alpha),
    }
    : curr.ball.position;

  const players = curr.players.map(p => {
    const old = prev.players.get(p.id);
    if (!old || Math.hypot(p.position.x - old.x, p.position.z - old.z) >= 2.4) return p;
    let action = p.action;
    if (action) {
      const nextJump = action.jumpHeight !== undefined ? lerpNum(old.jumpHeight, action.jumpHeight, alpha) : undefined;
      const nextGather = action.gatherPhase !== undefined ? lerpNum(old.gatherPhase, action.gatherPhase, alpha) : undefined;
      const nextProg = action.moveProgress !== undefined && action.moveProgress >= old.moveProgress
        ? lerpNum(old.moveProgress, action.moveProgress, alpha)
        : action.moveProgress;
      if (nextJump !== action.jumpHeight || nextGather !== action.gatherPhase || nextProg !== action.moveProgress) {
        action = {
          ...action,
          ...(nextJump !== undefined ? { jumpHeight: nextJump } : {}),
          ...(nextGather !== undefined ? { gatherPhase: nextGather } : {}),
          ...(nextProg !== undefined ? { moveProgress: nextProg } : {}),
        };
      }
    }
    return {
      ...p,
      position: { x: lerpNum(old.x, p.position.x, alpha), z: lerpNum(old.z, p.position.z, alpha) },
      facing: lerpAngle(old.facing, p.facing, alpha),
      ...(action ? { action } : {}),
    };
  });

  let shotMeter = curr.shotMeter;
  if (shotMeter && prev.meterProgress !== undefined && shotMeter.progress >= prev.meterProgress) {
    shotMeter = { ...shotMeter, progress: lerpNum(prev.meterProgress, shotMeter.progress, alpha) };
  }

  let charge = curr.charge;
  if (shotMeter && curr.charge[shotMeter.playerId] !== undefined && prev.charge[shotMeter.playerId] !== undefined) {
    const prevC = prev.charge[shotMeter.playerId];
    const currC = curr.charge[shotMeter.playerId];
    if (currC >= prevC) {
      charge = { ...curr.charge, [shotMeter.playerId]: lerpNum(prevC, currC, alpha) };
    }
  }

  return {
    ...curr,
    players,
    charge,
    ...(shotMeter !== undefined ? { shotMeter } : {}),
    ball: { ...curr.ball, position: ballPos },
  };
}
