# Hardwood Dynasty

Hardwood Dynasty is a browser basketball game with five-on-five, practice, configurable Blacktop, multi-season franchise management, a player career, and a separate private-room server.

## Play

Open the [game](https://hardwood-dynasty-chi.vercel.app/). Use **Play Now** to choose teams and period length. In **Rosters**, open a player's card to compare attributes and inspect their grade.

- **Desktop** — Move with WASD or arrows and sprint with Shift. Left-click the court or press Space to shoot. Tap for an assisted release or hold to time it. Right-click a teammate to pass directly, or press E or J for a pass in your movement direction. On defense, left-click to block and right-click to switch.
- **Phone** — Touch the lower-left movement area and drag from where your thumb lands. Push past the ring to sprint. Tap Shoot or hold and release. Tap Pass for a quick pass, swipe from Pass toward a teammate, or tap a teammate directly. More opens advanced moves.
- **Dribbling** — While moving with the ball, cut sharply across your body to bounce it into the outside hand. Players keep dribbling on the same side through small corrections. A standard gamepad is also supported.
- **Settings** changes controls, camera, and graphics. **Courtside** and **Player lock** offer closer views.

Franchise, MyPlayer, downloaded rosters, settings, and suspended exhibition games are saved in the current browser. Export roster packs in **Rosters**. A franchise keeps its own roster as trades and seasons progress.

## Run locally

```sh
npm ci
npm run dev
```

Node 24 is required. To enable private multiplayer, run the following in a second terminal.

```sh
npm run server
```

Open **Online** in each browser, create a room in one browser, and join with its code in the other. The frontend uses the local service on port 8787 in development. Production clients require a secure WebSocket address in **Settings** or in `VITE_MULTIPLAYER_URL` at build time. The [server guide](apps/multiplayer-server/README.md) covers container deployment and persistent room saves.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

[Architecture, contributors, and release status](docs/architecture.md)

## NBA data

The roster includes 30 teams and 529 players. ESPN supplies player bios and reported contracts. BoxScore Lab season totals through November 23, 2026 are used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The game converts the season totals into its own ratings. The player card explains how each stat contributes. Strength, potential, and abilities without tracking data are estimated. [BoxScore Lab downloads](https://www.boxscorelab.com/downloads/)