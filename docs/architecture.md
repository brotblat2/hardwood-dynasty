# Architecture and release status

## Runtime structure

| Component | Implementation |
| --- | --- |
| Shared contracts | TypeScript roster, ratings, player, input, event, game state, save, and room schemas |
| Local games | Deterministic 60 Hz engine and CPU coach, synchronized with the frame loop |
| Presentation | Three.js renderer and perspective Canvas fallback. Both use articulated player models and share the court, clock, and score data |
| Game controls | Keyboard, standard gamepad, touch joystick and buttons, and team/player selection |
| League management | Standalone deterministic schedules, game simulation, postseason, prospect scouting, offseason, expansion, and transactions |
| Career | User-created player, showcase, combine, draft, training, rookie and pro game progression |
| Realtime | Node WebSocket server runs the engine, checks control ownership, and persists rooms on a writable volume |
| Hosting | Vercel hosts the frontend. A separate Node host provides a persistent WebSocket process for deployed multiplayer |

The browser and multiplayer server consume the same engine. The score and possession are owned by that engine. On the finish event, the browser maps the game events into a box score and commits the result into the franchise or career save. The simulation can also finish a league game independently without drawing a court.

## Workstreams

Independent branches were implemented in overlapping waves. Routine data and QA work used Luna. Sol handled UI controls, rendering, and franchise. Astra handled game simulation, coaching, multiplayer, and ratings calibration. Career used an already-running agent from the coaching lane. API models are listed here by tier because individual cost and token totals are unavailable.

| Lane | Delivered |
| --- | --- |
| Integration | Shared contracts, React site, data and game integration, browser and Vercel verification |
| Gameplay | Fixed-tick regulation, Blacktop, training, shot timing, fouls and free throws, possession, subs, and timeouts |
| Coaching and career | Off-ball AI and defense, six difficulty levels, playable prospect and pro progression |
| Graphics | Articulated players in WebGL and perspective Canvas, arena and street court, five cameras |
| Controls | Keyboard and rebinding, standard gamepad, multi-touch, and screen switching |
| Franchise | Full schedules and playoffs, season awards and player stats, expansion, draft/lottery, scouting, cap and trade checks |
| Online | Authoritative private head-to-head, seat tickets, connection pause, and process-restart recovery |
| Rosters and QA | NBA data integration, data validation, event analytics, and test coverage |

## Release scope

- The game uses original stylized 3D figures. Height and weight affect the character models. Face scans and motion-capture animations are outside this build.
- The franchise financial model approximates cap, tax, apron, guarantees, and matching rules. Full CBA exceptions, rights and protected-pick or multi-team trade rules remain open.
- Multiplayer head-to-head runs with the supplied server. Online co-op, online leagues, tournaments and cross-device accounts are open. Local franchise and career saves stay in browser storage.
- Career includes playable showcases and pro games. Branching stories and endorsements remain open.
- All-Star Weekend, Hall of Fame, possession-level franchise sim, advanced on/off and lineup analytics, and full jersey/court creation remain open.

The renderer is designed to fall back to software perspective, even when a browser refuses WebGL. Physical iPhone and physical gamepad verification have yet to be run.
