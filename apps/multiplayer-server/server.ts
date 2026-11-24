import { randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createEngine } from '../../packages/game-engine/index.ts';
import { createCoach } from '../../packages/basketball-ai/index.ts';
import { TICK_RATE } from '../../packages/contracts/index.ts';
import type { ClientMessage, Control, Engine, GameState, ServerMessage, Side } from '../../packages/contracts/index.ts';
import { roomConfig, control } from './validate.ts';

type Input = Extract<ClientMessage, {type:'input'}>;
type Seat = { token: string; socket?: WebSocket; pending: Input[]; held?: Input; ack: number; lastInput: number };
type Room = { code: string; engine: Engine; coach: ReturnType<typeof createCoach>; seats: [Seat, Seat?]; saved: number };
type Persisted = { v: 1; state: GameState; tokens: string[] };
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const seat = (token = randomBytes(24).toString('hex')): Seat => ({ token, pending: [], ack: 0, lastInput: 0 });
const ready = (room: Room) => room.seats[0].socket?.readyState === WebSocket.OPEN && room.seats[1]?.socket?.readyState === WebSocket.OPEN;
const send = (ws: WebSocket, msg: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const sides = [0, 1] as const;
const day = 86400000;

export function createRoomServer(options: { dir?: string; origins?: string[]; maxRooms?: number } = {}) {
  const dir = resolve(options.dir ?? process.env.ROOM_STORE ?? '.data/rooms');
  const origins = options.origins ?? (process.env.ROOM_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const maxRooms = options.maxRooms ?? 128;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rooms = new Map<string, Room>();
  const filename = (code: string) => join(dir, code + '.json');
  function prune() {
    for (const name of readdirSync(dir)) {
      if (!/^[A-Z2-9]{6}\.json$/.test(name) || rooms.has(name.slice(0,6))) continue;
      if (Date.now() - statSync(join(dir,name)).mtimeMs > 7 * day) rmSync(join(dir,name));
    }
  }
  prune();
  function persist(r: Room) {
    const path = filename(r.code);
    const snapshot: Persisted = { v: 1, state: r.engine.state, tokens: r.seats.flatMap(s => s ? [s.token] : []) };
    writeFileSync(path + '.tmp', JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(path + '.tmp', path);
    r.saved = Date.now();
  }
  function lookup(code: unknown) {
    if (typeof code !== 'string' || !/^[A-Z2-9]{6}$/.test(code)) return undefined;
    if (rooms.has(code)) return rooms.get(code);
    let data: Persisted;
    try { data = JSON.parse(readFileSync(filename(code),'utf8')); } catch { return undefined; }
    if (data.v !== 1 || !data.tokens[0]) return undefined;
    const r: Room = { code, engine: createEngine(data.state.teams, data.state.config, data.state),
      coach: createCoach(), seats: [seat(data.tokens[0]), data.tokens[1] ? seat(data.tokens[1]) : undefined], saved: Date.now() };
    return r;
  }
  function snapshots(r: Room) {
    const { simulation: _private, ...state } = r.engine.state as GameState & { simulation?: unknown };
    for (const s of r.seats) if (s?.socket && s.socket.bufferedAmount < 131072)
      send(s.socket, { type: 'state', state, ready: ready(r), ack: s.ack });
  }
  const http = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', tickRate: TICK_RATE })); }
    else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: { threshold: 1024 } });
  http.on('upgrade', (req, sock, head) => {
    if (!['/room', '/'].includes(req.url ?? '') || (origins.length && !origins.includes(req.headers.origin ?? '')) || wss.clients.size >= maxRooms * 3) {
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws));
  });
  const alive = new Set<WebSocket>();
  wss.on('connection', ws => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => ws.terminate());
    let room: Room | undefined, side: Side = 0, count = 0, start = Date.now();
    const timeout = setTimeout(() => { if (!room) ws.close(1008, 'Room handshake timed out'); }, 10000);
    const reject = (message: string) => send(ws, { type: 'error', message });
    ws.on('message', (raw, binary) => {
      const now = Date.now();
      if (now - start >= 1000) { count = 0; start = now; }
      if (++count > 180 || binary) { ws.close(1008,'Invalid message rate or format'); return; }
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch { reject('Invalid JSON message.'); return; }
      if (!msg || typeof msg !== 'object') { reject('Invalid room message.'); return; }
      if (msg.type === 'input') {
        const s = room?.seats[side];
        if (!room || !s || s.socket !== ws) { reject('Join a room first.'); return; }
        if (!ready(room)) return;
        if (!Number.isSafeInteger(msg.seq) || msg.seq < 1 || !control(msg.control)) { reject('Invalid controls.'); return; }
        const players = room.engine.state.players;
        if (!players.some(p => p.side === side && p.id === msg.playerId) ||
            (msg.control.targetId && !players.some(p => p.side === side && p.id === msg.control.targetId))) { reject('Select a player on your team.'); return; }
        if (msg.seq <= (s.pending.at(-1)?.seq ?? s.ack)) return;
        if (s.pending.length >= 8) s.pending.pop();
        s.pending.push(msg); s.lastInput = now;
        return;
      }
      if (room) { reject('Already in a room.'); return; }
      let found: Room | undefined;
      if (msg.type === 'create') {
        if (rooms.size >= maxRooms) { reject('Room server is full.'); return; }
        if (!roomConfig(msg.config)) { reject('Invalid team roster or game settings.'); return; }
        let code: string;
        do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (lookup(code));
        found = { code, engine: createEngine(msg.config.teams, msg.config.game), coach: createCoach(), seats: [seat()], saved: 0 };
      } else if (msg.type === 'join' || msg.type === 'resume') {
        found = lookup(msg.code);
        if (!found) { reject('Room not found. Check the six-character code.'); return; }
        if (msg.type === 'resume') {
          const index = found.seats.findIndex(s => s && s.token === msg.token);
          if (index === -1) { reject('This reconnect ticket is invalid.'); return; }
          side = index as Side;
        } else {
          if (found.seats[1]) { reject('Both seats are reserved.'); return; }
          side = 1; found.seats[1] = seat();
        }
      } else { reject('Unknown room command.'); return; }
      room = found;
      rooms.set(room.code, room);
      const s = room.seats[side]!;
      s.socket?.close(4001, 'Seat resumed elsewhere');
      s.socket = ws; s.held = undefined; s.pending = []; s.ack = 0;
      clearTimeout(timeout);
      persist(room);
      send(ws, { type: 'room', room: { code: room.code, slot: side, token: s.token, ready: ready(room) } });
      snapshots(room);
    });
    ws.on('close', () => {
      clearTimeout(timeout); alive.delete(ws);
      if (!room || room.seats[side]?.socket !== ws) return;
      for (const s of room.seats) if (s) { s.held = undefined; s.pending = []; }
      room.seats[side]!.socket = undefined;
      persist(room); snapshots(room);
      if (!room.seats.some(s => s?.socket)) rooms.delete(room.code);
    });
  });
  const healthCheck = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.delete(ws)) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 15000);
  const cleanup = setInterval(prune, day);
  let previous = performance.now(), lag = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    lag += Math.min(now - previous, 100); previous = now;
    while (lag >= 1000 / TICK_RATE) {
      lag -= 1000 / TICK_RATE;
      for (const r of rooms.values()) {
        if (!ready(r) || r.engine.state.phase === 'final') continue;
        const users = new Set<string>();
        const humanControls: Record<string, Control> = {};
        for (const s of r.seats) if (s) {
          const next = s.pending.shift();
          if (next) { s.held = next; s.ack = next.seq; }
          if (Date.now() - s.lastInput > 500) s.held = undefined;
          if (s.held) {
            users.add(s.held.playerId);
            humanControls[s.held.playerId] = s.held.control;
          }
        }
        const controls = r.coach.controls(r.engine.state, users, humanControls);
        for (const side of sides) {
          const held = r.seats[side]?.held;
          if (held) controls[held.playerId] = held.control;
        }
        const state = r.engine.step(controls);
        if (state.tick % 3 === 0 || state.phase === 'final') snapshots(r);
        if (Date.now() - r.saved >= 5000 || state.phase === 'final') persist(r);
      }
    }
  }, 8);
  async function close() {
    clearInterval(ticker); clearInterval(healthCheck); clearInterval(cleanup);
    for (const room of rooms.values()) persist(room);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    if (http.listening) await new Promise<void>((ok, bad) => http.close(e => e ? bad(e) : ok()));
  }
  return { http, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createRoomServer();
  server.http.listen(Number(process.env.PORT ?? 8787), '0.0.0.0');
  process.once('SIGTERM', () => void server.close());
  process.once('SIGINT', () => void server.close());
}
