import type { Position, Ratings, Team } from './index.ts';

export function fixtureTeam(id: string, conference: Team['conference'] = 'East'): Team {
  const positions: Position[] = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SG', 'SF', 'PF', 'C'];
  const ratings: Ratings = {
    shooting: 75, finishing: 75, passing: 75, handling: 75, rebounding: 75,
    speed: 75, perimeter: 75, interior: 75, iq: 75, durability: 75,
  };
  return {
    id, conference, city: 'Test City', name: id, abbreviation: id.slice(0, 3).toUpperCase(),
    color: conference === 'East' ? '#e77834' : '#2c79dc', accent: '#ffffff',
    roster: positions.map((position, index) => ({
      id: `${id}-${index}`, name: `Player ${index + 1}`, number: index + 1, position,
      height: 1.85 + 0.055 * (index % 5), age: 24 + index % 5, overall: 75, potential: 83,
      ratings: { ...ratings }, salary: 5_000_000, years: 2,
    })),
  };
}
