import { COURT, attackSign, zeroControl } from '../contracts/index.ts';
import type { Control, Difficulty, GamePlayer, GameState, Vec2 } from '../contracts/index.ts';

const levels: Difficulty[] = ['Rookie', 'Pro', 'All-Star', 'Superstar', 'Hall of Fame', 'Legendary'];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const nearest = (point: Vec2, players: GamePlayer[]) =>
  Math.min(10, ...players.map(p => distance(point, p.position)));

function move(from: Vec2, to: Vec2): Vec2 {
  const dx = clamp(to.x, -13.7, 13.7) - from.x;
  const dz = clamp(to.z, -7.05, 7.05) - from.z;
  const scale = Math.max(0.65, Math.hypot(dx, dz));
  return { x: dx / scale, z: dz / scale };
}

function noise(id: string, seed: number, cycle: number) {
  let hash = seed ^ Math.imul(cycle + 1, 2654435761);
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function passingLane(a: Vec2, b: Vec2, defenders: GamePlayer[]) {
  const dx = b.x - a.x, dz = b.z - a.z;
  let space = 5;
  for (const defender of defenders) {
    const p = defender.position;
    const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1);
    if (t > 0.08 && t < 0.94) space = Math.min(space, distance(p, { x: a.x + t * dx, z: a.z + t * dz }));
  }
  return space;
}

function shotValue(p: GamePlayer, defenders: GamePlayer[], rim: Vec2) {
  const range = distance(p.position, rim);
  const touch = range < 3 ? p.profile.ratings.finishing : p.profile.ratings.shooting;
  return 0.45 + touch / 200 + clamp(nearest(p.position, defenders) - 1.5, -1.5, 3) * 0.10
    - range * 0.045 - Math.max(0, range - 8) * 0.14 + (range < 2 ? 0.21 : 0);
}

function support(p: GamePlayer, owner: GamePlayer, team: GamePlayer[], rim: Vec2, tick: number): Control {
  const sign = Math.sign(rim.x);
  const others = team.filter(m => m.id !== owner.id).sort((a, b) => {
    const roles = ['PG', 'SG', 'SF', 'PF', 'C'];
    return roles.indexOf(a.profile.position) - roles.indexOf(b.profile.position);
  });
  const slot = others.indexOf(p);
  const inside = slot === others.length - 1 && others.length > 1;
  const wave = Math.floor(tick / 240);
  const flank = (slot % 2 === 0 ? 1 : -1) * (wave % 2 === 0 ? 1 : -1);
  let target = { x: rim.x - sign * (slot < 2 ? 5.5 : 1.3), z: flank * 6.5 };
  const rimDistance = distance(owner.position, rim);
  if (rimDistance > 13) {
    target.x = owner.position.x + sign * (inside ? 8 : 5);
    target.z = inside ? -2 : flank * 5.5;
  } else if (inside && rimDistance > 4 && tick % 240 < 110) {
    target = { x: owner.position.x + sign * 1.45, z: owner.position.z + flank * 0.8 };
    if (distance(p.position, target) < 0.85) return { ...zeroControl(), screen: true };
  } else if (inside || (slot === wave % Math.max(1, others.length) && tick % 240 > 155)) {
    target = { x: rim.x - sign * 1.25, z: flank * 1.8 };
  }
  return { move: move(p.position, target), sprint: distance(p.position, target) > 4 };
}

function defend(p: GamePlayer, match: GamePlayer | undefined, owner: GamePlayer | undefined, rim: Vec2, state: GameState, level: number): Control {
  if (!match) return { move: move(p.position, rim) };
  const onBall = match.id === owner?.id;
  const rimGap = Math.max(1, distance(match.position, rim));
  const cushion = Math.min(0.75, (onBall ? 0.95 + (5 - level) * 0.12 : 1.75) / rimGap);
  const target = {
    x: match.position.x + (rim.x - match.position.x) * cushion,
    z: match.position.z + (rim.z - match.position.z) * cushion
  };
  if (owner && !onBall && distance(owner.position, rim) < 4 && distance(p.position, owner.position) < 4.5) {
    target.x = (owner.position.x + rim.x) / 2;
    target.z = (owner.position.z + rim.z) / 2;
  }
  const pressure = owner ? distance(p.position, owner.position) : Infinity;
  return {
    move: move(p.position, target), sprint: distance(p.position, target) > 2.4,
    contest: pressure < 1.3 + level * 0.13,
    steal: pressure < 1.15 && state.tick % (115 - 8 * level) === Math.floor(noise(p.id, 3, 0) * 40)
  };
}

export function createCoach() {
  let holder = '', received = 0, release = -1, lastTick = -1;
  return {
    controls(state: GameState, userPlayerIds: ReadonlySet<string> = new Set()): Record<string, Control> {
      const result: Record<string, Control> = {};
      const owner = state.players.find(p => p.id === state.ball.ownerId);
      const ownerId = owner?.id ?? '';
      if (holder !== ownerId || state.tick < lastTick) {
        holder = ownerId;
        received = state.tick;
        release = -1;
      }
      lastTick = state.tick;
      const level = levels.indexOf(state.config.difficulty ?? 'Pro');
      const seed = state.config.seed ?? 1;
      for (const p of state.players) {
        if (userPlayerIds.has(p.id)) {
          if (ownerId === p.id) release = -1;
          continue;
        }
        const team = state.players.filter(m => m.side === p.side);
        const foes = state.players.filter(m => m.side !== p.side);
        const attacking = p.side === (owner?.side ?? state.possession);
        const halfCourt = state.config.halfCourt ?? state.config.mode === 'blacktop';
        const sign = halfCourt ? 1 : attackSign(attacking ? p.side : (1 - p.side) as 0 | 1);
        const rim = { x: sign * COURT.rimX, z: 0 };
        let c = zeroControl();
        if (state.phase !== 'live') { result[p.id] = c; continue; }
        if (!owner && (state.ball.kind === 'loose' || state.ball.kind === 'shot')) {
          const landing = { x: state.ball.position.x + 0.22 * state.ball.velocity.x, z: state.ball.position.z + 0.22 * state.ball.velocity.z };
          const chase = [...team].sort((a,b) => distance(a.position, landing) - distance(b.position, landing)).slice(0,2);
          c = { move: move(p.position, chase.includes(p) ? landing : rim), sprint: true };
        } else if (!attacking) {
          c = defend(p, foes[team.indexOf(p) % Math.max(1, foes.length)], owner, rim, state, level);
        } else if (owner && owner.id !== p.id) {
          c = support(p, owner, team, rim, state.tick);
        } else if (owner) {
          const range = distance(p.position, rim);
          const cycle = Math.floor((state.tick - received) / (30 - 4 * level));
          const variance = (id: string) => (noise(id, seed, cycle) - 0.5) * (0.32 - level * 0.05);
          const value = shotValue(p, foes, rim) + variance(p.id);
          let best: GamePlayer | undefined;
          let bestValue = value + 0.13;
          for (const mate of team) {
            if (mate === p || distance(p.position, mate.position) < 1.5) continue;
            const lane = passingLane(p.position, mate.position, foes);
            const option = shotValue(mate, foes, rim) + variance(mate.id) - Math.max(0, 1.1 - lane) * (0.18 + level * 0.055);
            if (option > bestValue) { bestValue = option; best = mate; }
          }
          const age = state.tick - received;
          const urgent = Math.min(state.shotClock, state.clock) < 1.4;
          if (release >= 0 && state.tick > release) release = -1;
          if (release === -1 && (urgent || age > 24 - level * 2)) {
            if (!urgent && best && age % (18 - 2 * level) === 0) {
              c.pass = true;
              c.targetId = best.id;
              c.passType = passingLane(p.position, best.position, foes) < 0.85 ? 'bounce' : 'chest';
            } else if (urgent || range < 2.2 || (range < 8.5 && value > 0.84 && !best) || (age > 275 && range < 9)) {
              release = state.tick + (urgent ? 4 : 37 + Math.round(variance(p.id) * 48));
            }
          }
          if (!c.pass && release < 0) {
            const flank = p.position.z >= 0 ? 1 : -1;
            const waypoint = { x: rim.x - sign * 0.8, z: range > 5 ? flank * 1.8 : 0 };
            c.move = move(p.position, waypoint);
            c.sprint = range > 10;
            c.dribble = true;
          } else if (release >= 0) {
            c.shoot = state.tick < release;
          }
        }
        result[p.id] = c;
      }
      return result;
    }
  };
}
