# Hardwood Dynasty

Hardwood Dynasty is a browser basketball game with five-on-five, practice, configurable Blacktop, multi-season franchise management, a player career, and a separate private-room server.

## Play

Open the [game](https://hardwood-dynasty-chi.vercel.app/). Use **Play Now** to choose teams and period length. In **Rosters**, open a player's card to compare attributes and inspect their grade.

- Move with WASD or the arrow keys. Hold Space and release near the marker to shoot.
- J passes, K throws a bounce pass, and L lobs. C contests, X attempts a steal, Q switches players, E sets a screen, and F triggers a dribble move. Hold Shift to sprint.
- On a phone, rotate to landscape for more court area and use the joystick and action buttons. A standard gamepad is also supported.
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
