import type { ScheduledGame } from './index.ts';

export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(value: string) {
  let hashed = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hashed = Math.imul(hashed ^ value.charCodeAt(index), 16777619);
  }
  return hashed >>> 0;
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const ordered = [...items];
  for (let index = ordered.length - 1; index > 0; index--) {
    const next = Math.floor(random() * (index + 1));
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
  }
  return ordered;
}

type Pair = [string, string];

function roundRobin(teamIds: string[]): Pair[][] {
  const rotation: (string | undefined)[] = [...teamIds];
  if (rotation.length % 2) rotation.push(undefined);
  return Array.from({ length: rotation.length - 1 }, () => {
    const round: Pair[] = [];
    for (let index = 0; index < rotation.length / 2; index++) {
      const a = rotation[index];
      const b = rotation[rotation.length - 1 - index];
      if (a !== undefined && b !== undefined) round.push([a, b]);
    }
    rotation.splice(1, 0, rotation.pop());
    return round;
  });
}

function oddsRemainder(teamIds: string[], remainder: number): Pair[][] {
  const days: Pair[][] = [];
  for (let offset = 1; offset <= remainder / 2; offset++) {
    const matchups = teamIds.map((team, index): Pair => [team, teamIds[(index + offset) % teamIds.length]]);
    const offsetDays: { games: Pair[]; busy: Set<string> }[] = [];
    for (const matchup of matchups) {
      const [a, b] = matchup;
      let day = offsetDays.find(({ busy }) => !busy.has(a) && !busy.has(b));
      if (!day) {
        day = { games: [], busy: new Set() };
        offsetDays.push(day);
      }
      day.games.push(matchup);
      day.busy.add(a);
      day.busy.add(b);
    }
    days.push(...offsetDays.map(({ games }) => games));
  }
  return days;
}

function balanceHomeCourt(days: Pair[][], teamIds: string[]) {
  const unpaired = new Map<string, Pair>();
  for (const pair of days.flat()) {
    const [a, b] = pair;
    const key = JSON.stringify([a, b].sort());
    const previous = unpaired.get(key);
    if (previous) {
      [pair[0], pair[1]] = [previous[1], previous[0]];
      unpaired.delete(key);
    } else {
      unpaired.set(key, pair);
    }
  }
  const edges = [...unpaired.values()];
  const incident = new Map(teamIds.map((id) => [id, [] as number[]]));
  for (const [index, [a, b]] of edges.entries()) {
    incident.get(a)!.push(index);
    incident.get(b)!.push(index);
  }
  const oddDegree = teamIds.filter((id) => incident.get(id)!.length % 2 !== 0);
  for (let index = 0; index < oddDegree.length; index += 2) {
    const edgeIndex = edges.length;
    const a = oddDegree[index];
    const b = oddDegree[index + 1];
    edges.push([a, b]);
    incident.get(a)!.push(edgeIndex);
    incident.get(b)!.push(edgeIndex);
  }

  // Orient Eulerian trails to give every club an equal home and away count, within one game.
  const used = new Set<number>();
  for (const id of teamIds) {
    const stack = [id];
    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const edgeIndex = incident.get(current)!.pop();
      if (edgeIndex === undefined) {
        stack.pop();
        continue;
      }
      if (used.has(edgeIndex)) continue;
      used.add(edgeIndex);
      const pair = edges[edgeIndex];
      const other = pair[0] === current ? pair[1] : pair[0];
      pair[0] = current;
      pair[1] = other;
      stack.push(other);
    }
  }
}

export function generateSchedule(teamIds: readonly string[], seasonLength: number, year: number, seed: number): ScheduledGame[] {
  if (teamIds.length < 2 || new Set(teamIds).size !== teamIds.length) throw new Error('A league needs at least two teams with distinct IDs.');
  if (!Number.isInteger(seasonLength) || seasonLength < 1 || seasonLength > 150) throw new Error('Season length must be between 1 and 150 games.');
  const oddTeamCount = teamIds.length % 2 === 1;
  if (oddTeamCount && seasonLength % 2) throw new Error('A league with an odd number of teams requires an even season length.');
  const ordered = shuffle(teamIds, seededRandom(seed ^ year));
  const rounds = roundRobin(ordered);
  const days: Pair[][] = [];
  const fullCycles = Math.floor(seasonLength / (ordered.length - 1));
  const remainder = seasonLength % (ordered.length - 1);
  for (let index = 0; index < fullCycles; index++) {
    days.push(...rounds.map((round) => round.map(([a, b]): Pair => [a, b])));
  }
  days.push(...(oddTeamCount ? oddsRemainder(ordered, remainder) : rounds.slice(0, remainder)));
  balanceHomeCourt(days, ordered);
  return days.flatMap((round, day) => round.map(([homeId, awayId], index) => ({
    id: `${year}-r-${day + 1}-${index + 1}`, day: day + 1, homeId, awayId,
  })));
}
