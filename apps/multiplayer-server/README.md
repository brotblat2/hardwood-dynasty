# Private head-to-head server

From the repository root, use Node 24 and run `npm ci && npm run server`. The process serves WebSocket rooms at `ws://localhost:8787/room` and health checks at `http://localhost:8787/health`. Supply `VITE_MULTIPLAYER_URL` to the frontend build. HTTPS sites require a secure `wss://` endpoint.

Build a container from the repository root with `docker build -f apps/multiplayer-server/Dockerfile -t hardwood-rooms .`. On a WebSocket-capable host, run one replica with a persistent writable volume mounted at `/data`, expose the `PORT` environment variable, and route HTTPS and WebSocket upgrades to that port. The container runs as UID 1000. For a local Docker instance use `docker run --rm -p 8787:8787 -v hardwood-rooms:/data hardwood-rooms`.

Set `ROOM_ORIGINS` to a comma-separated list of trusted frontend origins. Set `ROOM_STORE` to override the save directory. The server runs the simulation at 60 Hz and sends snapshots at 20 Hz. Losing either connection pauses the clock, and the browser automatically retries with its private seat ticket. Reloading the same tab restores the seat through session storage. Atomic saves capture active rooms every five seconds and on disconnect, shutdown, and final score. Offline rooms expire after seven days during daily cleanup. Each installation needs its own storage and a stable endpoint.
