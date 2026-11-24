import assert from 'node:assert/strict';
import test from 'node:test';
import { control, roomConfig } from '../apps/multiplayer-server/validate.ts';
import { createCareer } from '../packages/career/index.ts';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { Player } from '../packages/contracts/index.ts';
import {
  appearanceFor,
  FACIAL_HAIR_STYLES,
  HAIR_STYLES,
  HAIR_TONES,
  SKIN_TONES,
} from '../packages/rendering/appearance.ts';
import { resolveKitPalette } from '../packages/rendering/jerseys.ts';
import { makeMotion } from '../packages/rendering/motion.ts';
import { loadNbaRosters } from '../packages/roster-data/nba.ts';

const basePlayer = fixtureTeam('home').roster[0];
const makePlayer = (id: string, patch: Partial<Player> = {}): Player => ({ ...basePlayer, id, ...patch });

test('appearanceFor reflects true height, counter-scaled head, independent wingspan, BMI bulk, overrides, and bio fallbacks', () => {
  const shortGuard = appearanceFor(makePlayer('g', { height: 1.78, weight: 78, wingspan: 1.82 }));
  const tallCenter = appearanceFor(makePlayer('c', { height: 2.24, weight: 122, wingspan: 2.44 }));

  assert.ok(tallCenter.stature > shortGuard.stature * 1.2);
  assert.ok(tallCenter.headScale < shortGuard.headScale, 'taller players counter-scale heads so proportions remain lifelike');

  const leanWing = appearanceFor(makePlayer('lean', { height: 2.01, weight: 82, wingspan: 2.08 }));
  const bulkyForward = appearanceFor(makePlayer('bulky', { height: 2.01, weight: 122, wingspan: 2.08 }));
  assert.ok(bulkyForward.shoulderScale > leanWing.shoulderScale);
  assert.ok(bulkyForward.limbBulk > leanWing.limbBulk);

  const shortArmSameHeight = appearanceFor(makePlayer('a1', { height: 2.01, weight: 98, wingspan: 1.96 }));
  const longArmSameHeight = appearanceFor(makePlayer('a2', { height: 2.01, weight: 98, wingspan: 2.24 }));
  assert.equal(shortArmSameHeight.stature, longArmSameHeight.stature);
  assert.ok(longArmSameHeight.armScale > shortArmSameHeight.armScale + 0.08);

  const custom = appearanceFor(makePlayer('custom', {
    appearance: {
      skinTone: SKIN_TONES[6],
      hairTone: HAIR_TONES[4],
      hairstyle: 'afro',
      facialHair: 'fullBeard',
      headband: true,
      armSleeve: 'both',
      legSleeve: 'left',
      shoeColor: '#d97706',
    },
  }));
  assert.equal(custom.hair, 'afro');
  assert.equal(custom.facialHair, 'fullBeard');
  assert.equal(custom.headband, true);
  assert.equal(custom.armSleeve, 'both');
  assert.equal(custom.legSleeve, 'left');
  assert.equal(custom.shoeColor, '#d97706');

  const invalid = appearanceFor(makePlayer('bad', { height: Number.NaN, weight: -10, wingspan: Number.NaN }));
  assert.ok(Number.isFinite(invalid.stature) && invalid.stature > 0.8);
  assert.ok(Number.isFinite(invalid.armScale) && invalid.armScale > 0.8);
  assert.ok(SKIN_TONES.length >= 8 && HAIR_STYLES.length === 10 && FACIAL_HAIR_STYLES.length === 5);
});

test('loadNbaRosters hydrates all 30 clubs with jersey patterns and curated player likeness/wingspan data', async () => {
  const pack = await loadNbaRosters();
  assert.equal(pack.modelVersion, 3);
  const teams = pack.teams;
  assert.equal(teams.length, 30);

  for (const team of teams) {
    assert.ok(team.jerseyPattern, `expected jerseyPattern on ${team.abbreviation}`);
    assert.ok(team.tertiaryColor, `expected tertiaryColor on ${team.abbreviation}`);
  }

  const allPlayers = teams.flatMap(t => t.roster);
  const byName = new Map(allPlayers.map(p => [p.name, p]));

  const wemby = byName.get('Victor Wembanyama');
  assert.ok(wemby && (wemby.wingspan ?? 0) >= 2.40);
  const jokic = byName.get('Nikola Jokic');
  assert.ok(jokic?.appearance?.skinTone === SKIN_TONES[6]);
  const curry = byName.get('Stephen Curry');
  assert.ok(curry?.appearance?.facialHair === 'goatee' && curry.appearance.armSleeve === 'right');
  const lebron = byName.get('LeBron James');
  assert.ok(lebron?.appearance?.facialHair === 'fullBeard' && lebron.appearance.armSleeve === 'left');
  const harden = byName.get('James Harden');
  assert.ok(harden?.appearance?.facialHair === 'fullBeard' && harden.appearance.hairstyle === 'braids');
  const allen = byName.get('Jarrett Allen');
  assert.ok(allen?.appearance?.hairstyle === 'afro' && allen.appearance.headband === true);
  const rui = byName.get('Rui Hachimura');
  assert.ok(rui?.appearance?.skinTone === SKIN_TONES[3]);
  const caruso = byName.get('Alex Caruso');
  assert.ok(caruso?.appearance?.hairstyle === 'shaved' && caruso.appearance.headband === true);
  const yang = byName.get('Yang Hansen');
  if (yang) assert.ok(yang.appearance?.skinTone === SKIN_TONES[5]);
});

test('resolveKitPalette renders home/away/statement/city kits and prevents kit clashes automatically', () => {
  const celtics = { ...fixtureTeam('home', 'East'), abbreviation: 'BOS', name: 'Boston Celtics', color: '#008348', accent: '#ba9653', jerseyPattern: 'classic' as const };
  const lakers = { ...fixtureTeam('away', 'West'), abbreviation: 'LAL', name: 'Los Angeles Lakers', color: '#552583', accent: '#fdb927', jerseyPattern: 'sidePanel' as const };
  const bucks = { ...fixtureTeam('away', 'East'), abbreviation: 'MIL', name: 'Milwaukee Bucks', color: '#00471b', accent: '#eee1c6', jerseyPattern: 'hoopBand' as const };

  const lalHome = resolveKitPalette(lakers, 0, 'home');
  assert.equal(lalHome.base, '#fdb927', 'Lakers wear iconic Forum gold at home');

  const bosHome = resolveKitPalette(celtics, 0, 'home');
  const bosAway = resolveKitPalette(celtics, 1, 'away');
  const bosStmt = resolveKitPalette(celtics, 1, 'statement');
  const bosCity = resolveKitPalette(celtics, 1, 'city');
  assert.equal(bosHome.base, '#f4f1ea');
  assert.equal(bosAway.base, '#008348');
  assert.notEqual(bosStmt.base, bosHome.base);
  assert.ok(bosCity.wordmark.length > 0);

  // If visitor picks 'home' white vs home 'home' white, clash resolution swaps visitor off white!
  const clashResolved = resolveKitPalette(bucks, 1, 'home', bosHome.base);
  assert.notEqual(clashResolved.base, bosHome.base);
  assert.notEqual(clashResolved.kit, 'home');
});

test('createCareer persists wingspan & appearance, and server validators accept kits & postUp', () => {
  const appearance = {
    skinTone: SKIN_TONES[4],
    hairTone: HAIR_TONES[1],
    hairstyle: 'locs' as const,
    facialHair: 'goatee' as const,
    headband: true,
    armSleeve: 'left' as const,
    legSleeve: 'both' as const,
  };
  const career = createCareer({
    name: 'Jalen Mercer',
    position: 'SF',
    height: 2.01,
    weight: 98,
    wingspan: 2.17,
    appearance,
    archetype: 'Two-way wing',
    path: 'College',
    seed: 77,
  });
  assert.equal(career.player.wingspan, 2.17);
  assert.deepEqual(career.player.appearance, appearance);

  assert.equal(roomConfig({ teams: [fixtureTeam('home'), fixtureTeam('away', 'West')], game: { mode: 'regulation', kits: ['city', 'away'] } }), true);
  assert.equal(roomConfig({ teams: [fixtureTeam('home'), fixtureTeam('away', 'West')], game: { kits: ['invalid', 'away'] } }), false);

  assert.equal(control({ move: { x: 0.4, z: -0.2 }, postUp: true }), true);
  assert.equal(control({ move: { x: 0, z: 0 }, postUp: 'yes' }), false);
});

test('makeMotion produces finite transforms without NaN across idle, dribble, postUp, and shoot states', () => {
  const motion = makeMotion(2.01, 1, 7, 1.04);
  const scenarios = [
    { pose: 'idle' as const, action: undefined, held: undefined, charge: 0 },
    { pose: 'dribble' as const, action: {}, held: { x: 1, y: 0.9, z: 0.3 }, charge: 0 },
    { pose: 'postUp' as const, action: { postUp: true }, held: { x: 1, y: 1.0, z: 0.2 }, charge: 0 },
    { pose: 'shoot' as const, action: { shotStyle: 'jump' as const }, held: { x: 0.5, y: 2.1, z: 0.1 }, charge: 0.5 },
  ];
  let tick = 1;
  for (const s of scenarios) {
    for (let i = 0; i < 4; i++) {
      const pose = motion({
        id: 'p1', profile: basePlayer, side: 0, position: { x: 1, z: 0 },
        velocity: { x: 0.8, z: -0.2 }, facing: 0.25, stamina: 92, pose: s.pose,
        ...(s.action ? { action: s.action } : {}),
      }, tick++, s.held, s.charge, undefined);
      for (const n of [pose.facing, pose.rise, pose.crouch, pose.tilt, pose.roll, pose.twist]) {
        assert.ok(Number.isFinite(n), `expected finite scalar for pose ${s.pose}`);
      }
      for (const chain of [...pose.arms, ...pose.legs]) {
        for (const n of [chain.pitch, chain.start.x, chain.start.y, chain.start.z, chain.joint.x, chain.joint.y, chain.joint.z, chain.end.x, chain.end.y, chain.end.z]) {
          assert.ok(Number.isFinite(n), `expected finite limb coord for pose ${s.pose}`);
        }
      }
    }
  }
});
