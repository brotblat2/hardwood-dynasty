import { COURT, attackSign, zeroControl } from '../contracts/index.ts';
import type {
  Control, DefenseScheme, GamePlayer, GameState, OffensePlay, ScreenMode, Side, Vec2,
} from '../contracts/index.ts';
import { defend, defensiveAssignments, reboundControls } from './defense-ai.ts';
import type { KickoutState } from './defense-ai.ts';
import { choosePassType, offensiveSupport } from './offense-ai.ts';
import { driveTarget, screenCall, screenLane, shotType } from './playbooks.ts';
import type { Screen } from './playbooks.ts';
import {
  clamp, closeout, distance, highPostHub, levels, mix, move, noise, opposite, passingLane, shotValue,
} from './spatial.ts';

export type { DefensePlan, KickoutState, ScreenCoverage } from './defense-ai.ts';
export { defensiveAssignments } from './defense-ai.ts';
export type { Screen } from './playbooks.ts';

export function createCoach() {
  let holder = '';
  let received = 0;
  let release = -1;
  let lastTick = -1;
  let possession: Side | undefined;
  let gained = 0;
  let attempt: Control['shotType'];
  let screen: Screen | undefined;
  let screenCalled = false;
  let lastScreenEnded = -999;
  let intendedPass: { receiver: string; sender: string; spot: Vec2 } | undefined;
  let kickout: KickoutState | undefined;
  let lastPasser = '';
  let passes = 0;
  let outletAttempted = false;
  const offensePlays: [OffensePlay, OffensePlay] = ['motion', 'motion'];
  const defenseSchemes: [DefenseScheme, DefenseScheme] = ['man', 'man'];
  const screenModes: [ScreenMode | undefined, ScreenMode | undefined] = [undefined, undefined];

  return {
    controls(
      state: GameState,
      userPlayerIds: ReadonlySet<string> = new Set(),
      userControls: Readonly<Record<string, Control>> = {},
    ): Record<string, Control> {
      const result: Record<string, Control> = {};
      if (state.offensePlay) {
        offensePlays[0] = state.offensePlay[0];
        offensePlays[1] = state.offensePlay[1];
      }
      if (state.defenseScheme) {
        defenseSchemes[0] = state.defenseScheme[0];
        defenseSchemes[1] = state.defenseScheme[1];
      }
      if (state.screenMode) {
        screenModes[0] = state.screenMode[0];
        screenModes[1] = state.screenMode[1];
      }
      for (const p of state.players) {
        const u = userControls[p.id];
        if (u?.offensePlay) offensePlays[p.side] = u.offensePlay;
        if (u?.defenseScheme) defenseSchemes[p.side] = u.defenseScheme;
        if (u?.screenMode) {
          screenModes[p.side] = u.screenMode;
          if (screen && p.side === state.possession) screen.pop = u.screenMode === 'fade';
        }
      }

      const owner = state.players.find(p => p.id === state.ball.ownerId);
      const ownerId = owner?.id ?? '';
      if (possession !== state.possession || state.tick < lastTick) {
        possession = state.possession;
        gained = state.tick;
        lastPasser = '';
        passes = 0;
        outletAttempted = false;
        intendedPass = undefined;
        kickout = undefined;
      }
      if (holder !== ownerId || state.tick < lastTick || state.phase !== 'live') {
        if (ownerId && intendedPass?.receiver === ownerId && holder !== ownerId) {
          lastPasser = intendedPass.sender;
          passes++;
        }
        holder = ownerId;
        received = state.tick;
        release = -1;
        attempt = undefined;
        screen = undefined;
        screenCalled = false;
        lastScreenEnded = -999;
      }
      if (state.ball.kind !== 'pass' && (state.ball.kind !== 'held' || ownerId !== intendedPass?.sender)) {
        intendedPass = undefined;
      }
      if (kickout && state.tick > kickout.until) kickout = undefined;
      if (state.phase !== 'live' || state.ball.kind === 'shot') {
        lastPasser = '';
        passes = 0;
        outletAttempted = false;
        kickout = undefined;
      }
      lastTick = state.tick;

      const level = Math.max(0, levels.indexOf(state.config.difficulty ?? 'Pro'));
      const seed = state.config.seed ?? 1;
      const halfCourt = state.config.halfCourt ?? state.config.mode === 'blacktop';
      const sign = halfCourt ? 1 : attackSign(state.possession);
      const rim = { x: sign * COURT.rimX, z: 0 };
      const team = state.players.filter(p => p.side === state.possession);
      const foes = state.players.filter(p => p.side !== state.possession);
      const mates = team.filter(p => p !== owner).sort((a, b) => b.profile.ratings.shooting - a.profile.ratings.shooting);
      const age = state.tick - received;
      const transition = owner && !halfCourt && (owner.position.x * sign < 1 || (state.tick - gained < 125 && distance(owner.position, rim) > 9.4));
      const activePlay = offensePlays[state.possession];
      const defSide = opposite(state.possession);
      const offScore = state.score[state.possession];
      const defScore = state.score[defSide];
      const lateRegulation = state.config.mode === 'regulation' && state.period >= (state.config.periods ?? 4);
      const lateFoul = lateRegulation && defScore < offScore && offScore - defScore <= 7 && state.clock < 26;
      const milkClock = lateRegulation && offScore > defScore && offScore - defScore <= 8 && state.clock < 24 && state.shotClock >= state.clock && state.clock > 4.5;
      const activeScheme: DefenseScheme = lateFoul ? 'press' : defenseSchemes[defSide];
      const activeScreenMode = screenModes[state.possession];

      const humanCallScreen = owner && userPlayerIds.has(owner.id) && (userControls[owner.id]?.callScreen || userControls[owner.id]?.screen);
      const autoDelay = owner && userPlayerIds.has(owner.id)
        ? (owner.position.x * sign > 0.5 ? 10 : 999)
        : (activePlay === 'pickAndRoll' ? 8 : 16);
      const readyForNewScreen = !screen && (!screenCalled || state.tick >= lastScreenEnded + 95);
      if (owner && humanCallScreen && state.phase === 'live' && (!screen || !mates.some(p => p.id === screen!.screener && !userPlayerIds.has(p.id)))) {
        screen = screenCall(owner, mates.filter(p => !userPlayerIds.has(p.id)), foes, rim, state.tick, true, activeScreenMode);
        screenCalled = !!screen;
      } else if (owner && !transition && readyForNewScreen && activePlay !== 'iso' && activePlay !== 'floppy' && state.phase === 'live' && age >= autoDelay && state.shotClock > 5 && release < 0) {
        screen = screenCall(owner, mates.filter(p => !userPlayerIds.has(p.id)), foes, rim, state.tick, false, activeScreenMode);
        screenCalled = !!screen;
      }

      if (screen) {
        const screener = mates.find(p => p.id === screen?.screener);
        if (
          !screener ||
          userPlayerIds.has(screener.id) ||
          (screen.planted === undefined && state.tick > screen.started + 94) ||
          (screen.planted !== undefined && state.tick > screen.planted + 105)
        ) {
          screen = undefined;
          lastScreenEnded = state.tick;
        } else if (screen.planted === undefined && distance(screener.position, screen.spot) < 0.48) {
          screen.planted = state.tick;
        }
      }

      const activeKickout = kickout && owner?.id === kickout.targetId ? kickout : undefined;
      const defense = owner && defensiveAssignments(foes, team, owner, rim, level, activeScheme, activeKickout);

      for (const p of state.players) {
        if (userPlayerIds.has(p.id)) {
          if (ownerId === p.id) release = -1;
          continue;
        }
        let c = zeroControl();
        if (state.phase !== 'live') {
          result[p.id] = c;
          continue;
        }

        if (!owner && (state.ball.kind === 'loose' || state.ball.kind === 'shot')) {
          c = reboundControls(p, p.side === state.possession ? team : foes, p.side === state.possession ? foes : team, rim, state);
        } else if (!owner && state.ball.kind === 'pass') {
          if (p.id === intendedPass?.receiver) {
            c = { move: move(p.position, intendedPass.spot) };
          } else if (p.side !== state.possession) {
            if (kickout && intendedPass) {
              const recv = state.players.find(q => q.id === kickout!.targetId);
              const closestCloseout = foes.reduce<GamePlayer | undefined>(
                (best, d) => (!best || distance(d.position, intendedPass!.spot) < distance(best.position, intendedPass!.spot) ? d : best),
                undefined,
              );
              if (recv && p === closestCloseout && distance(p.position, intendedPass.spot) > 1.0) {
                c = { move: move(p.position, intendedPass.spot), sprint: true, handsUp: distance(p.position, intendedPass.spot) < 2.2 };
                result[p.id] = c;
                continue;
              }
            }
            if (state.ball.position.y < 2.9) {
              const point = { x: state.ball.position.x + state.ball.velocity.x * 0.075, z: state.ball.position.z + state.ball.velocity.z * 0.075 };
              if (distance(p.position, point) < 0.82 + level * 0.08 && p.profile.ratings.perimeter + level * 3 >= 64) {
                c = { move: move(p.position, point), steal: true };
              }
            }
          }
        } else if (owner && p.side !== state.possession && defense) {
          c = defend(p, owner, rim, state, level, defense, activeScheme, lateFoul);
        } else if (owner && owner.id !== p.id) {
          c = offensiveSupport(p, owner, mates, foes, rim, state.tick, screen, !!transition, activePlay);
        } else if (owner) {
          const range = distance(p.position, rim);
          const cycle = Math.floor(age / (31 - 4 * level));
          const variance = (id: string) => (noise(id, seed, cycle) - 0.5) * (0.36 - level * 0.06);
          const value = shotValue(p, p.position, foes, rim, level, state) + variance(p.id);
          const { passing, shooting } = p.profile.ratings;
          const target = milkClock
            ? { x: rim.x - sign * 8.2, z: clamp(p.position.z, -4.5, 4.5) }
            : screen && (screen.planted === undefined || state.tick < screen.planted + 34)
              ? (screen.planted === undefined ? mix(screen.spot, p.position, 0.8) : screenLane(screen, rim))
              : driveTarget(p, rim, foes, level);
          const arc = distance(p.position, rim) >= COURT.three || (Math.abs(p.position.z) >= 6.7 && p.position.x * sign >= COURT.rimX - 2.7);
          const space = closeout(p.position, foes, level);
          const urgent = Math.min(state.shotClock, state.clock) < 1.35;
          const comfortable = !milkClock && (
            (range < 2.4 && (space > 1.23 || p.profile.ratings.finishing >= 87)) ||
            (arc && range < 8.8 && shooting >= 77 && value > 1.55 + (94 - shooting) * 0.014) ||
            (!arc && range >= 2.4 && range < 6.8 && value > 1.71 && (!screen || screen.planted !== undefined))
          );

          let best: { mate: GamePlayer; lead: Vec2; lane: number; gap: number; lob: boolean; calling: boolean } | undefined;
          const opening = !outletAttempted && passes === 0 && !comfortable && age >= 24 && age < 132 && state.shotClock > 19 && range > 7.6;
          let bestValue = Math.max(value, comfortable ? 1.55 : 1.12) + 0.18 -
            level * 0.016 - (passing - 70) * 0.006 + Math.min(0.27, passes * 0.077);

          for (const mate of mates) {
            const calling = userPlayerIds.has(mate.id) && !!(userControls[mate.id]?.callPass || userControls[mate.id]?.pass);
            const gap = distance(p.position, mate.position);
            if (gap < (calling ? 1.0 : 1.7) || gap > 7.8 + passing * 0.055 || (!calling && mate.id === lastPasser && age < 80)) continue;
            const leadTime = clamp(gap / 16 * (1.14 - passing * 0.0016), 0.18, 1.05) * 0.65;
            const lead = { x: mate.position.x + mate.velocity.x * leadTime, z: mate.position.z + mate.velocity.z * leadTime };
            const read = mix(mate.position, lead, 0.58 + level * 0.084);
            if (!halfCourt && p.position.x * sign > 0 && read.x * sign < 0.35) continue;
            const lane = Math.min(passingLane(p.position, read, foes), passingLane(p.position, lead, foes) + 0.1 * (5 - level));
            const receiverSpace = closeout(read, foes, level);
            if (lane < (calling ? 0.36 : 0.44 + level * 0.09) || (!calling && p.position.x * sign < 0 && gap > 9.2 && lane < 2.15)) continue;
            const receivingRange = distance(read, rim);
            const advances = receivingRange < range - 2.3;
            const hub = passes < 2 && highPostHub(mate) && receivingRange >= 3.5 && receivingRange < 6.6 ? 0.24 : 0;
            const hitRoll = screen?.screener === mate.id && screen.planted !== undefined && state.tick >= screen.planted + 24 &&
              receiverSpace > 1.4 && lane > 1 ? 0.28 : 0;
            const safeOutlet = opening && gap >= 2.8 && gap < 10.5 && lane >= 1.14 + level * 0.035 &&
              receiverSpace > 1.6 && (advances || (!transition && Math.abs(read.z - p.position.z) > 2.8));
            const outlet = safeOutlet ? 0.7 + (mate.profile.ratings.handling - 65) * 0.009 : 0;
            const catchAndShootBonus = receiverSpace > 1.8 && receivingRange >= 6.5 && receivingRange <= 8.6 && mate.profile.ratings.shooting >= 78 ? 0.22 : 0;
            const callBonus = calling ? 1.65 : 0;
            const option = shotValue(mate, read, foes, rim, level, state) + variance(mate.id) + hub + hitRoll + outlet + catchAndShootBonus + callBonus -
              Math.max(0, 1.18 - lane) * (0.28 + level * 0.07) - gap * 0.022;
            const lobCut = (screen?.screener === mate.id && !screen.pop && receiverSpace > 1.1) ||
              (receivingRange < 3.1 && mate.profile.ratings.finishing >= 80 && lane < 1.05 && receiverSpace > 0.65);
            if (option > bestValue && (calling || !transition || advances)) {
              bestValue = option;
              best = { mate, lead, lane, gap, lob: lobCut, calling };
            }
          }

          if (release < 0 && (urgent || best?.calling || age > 24 - level * 2)) {
            if (!urgent && best && (best.calling || opening || age % (18 - 2 * level) === 0)) {
              outletAttempted = true;
              intendedPass = { receiver: best.mate.id, sender: p.id, spot: best.lead };
              if (range < 5.0 && distance(best.lead, rim) > 5.2) {
                kickout = { targetId: best.mate.id, until: state.tick + 52 };
              }
              c.pass = true;
              c.targetId = best.mate.id;
              c.passType = choosePassType(p, best.mate, best.lane, best.gap, best.lob, level, state.tick, seed);
            } else if (urgent || (!milkClock && ((comfortable && !best) || (age > 195 && range < 9.1 && (space > 1.2 || age > 285))))) {
              const timingSpread = [9.5, 6.8, 5.2, 4.4, 3.8, 2.2][level] ?? 5.2;
              const cpuErr = Math.round((noise(p.id, seed, Math.floor(state.tick / 19)) - 0.5) * 2 * timingSpread);
              const varScale = level >= 5 ? 43 : 22;
              release = state.tick + Math.max(4, Math.min(Math.round(Math.min(state.clock, state.shotClock) * 60) - 2, 37 + Math.round(variance(p.id) * varScale) + cpuErr));
              attempt = shotType(p, rim, foes);
            }
          }

          if (!c.pass && release < 0) {
            c.move = move(p.position, target);
            c.sprint = range > 9.2 && p.stamina > 24;
            const wantsDribble = (level >= 2 && p.profile.ratings.handling >= 80 && space < 1.35 && range > 3.2 && range < 8.5)
              ? (state.tick + Math.floor(noise(p.id, seed, 1) * 40)) % 45 === 0
              : space < 1.5 && p.stamina > 17;
            c.dribble = wantsDribble;
            if (wantsDribble) {
              if (p.profile.ratings.shooting >= 82 && range >= 5.2 && range < 8.4 && space < 1.65) {
                c.dribbleDir = { x: -sign, z: 0 };
              } else if (p.profile.ratings.handling >= 80 && range >= 2.8 && range < 6.8) {
                const sideZ = Math.abs(target.z - p.position.z) > 0.15 ? Math.sign(target.z - p.position.z) : (p.position.z >= 0 ? -1 : 1);
                c.dribbleDir = { x: sign * 0.25, z: sideZ };
              }
            }
          } else if (release >= 0) {
            c.shoot = state.tick < release;
            c.shotType = attempt;
          }
        }
        result[p.id] = c;
      }
      return result;
    },
  };
}
