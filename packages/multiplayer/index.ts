import type { ClientMessage, Control, GameState, RoomConfig, RoomInfo, ServerMessage } from '../contracts/index.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type RoomCallbacks = {
  onRoom?(room: RoomInfo): void;
  onState?(state: GameState, ready: boolean, ack: number): void;
  onStatus?(status: ConnectionStatus): void;
  onError?(message: string): void;
};
type Ticket = Pick<RoomInfo, 'code' | 'token'>;
type Handshake = Exclude<ClientMessage, { type: 'input' }>;

export function createRoomClient(url: string, callbacks: RoomCallbacks = {}) {
  const key = 'hardwood.room.v1:' + url;
  let socket: WebSocket | undefined;
  let ticket: Ticket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let seq = 0;
  let admitted = false;
  const saved = () => {
    try {
      const item = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Ticket | null;
      if (item && typeof item.code === 'string' && typeof item.token === 'string') return item;
    } catch { /* Private browsing can disable storage. */ }
    return undefined;
  };
  const remember = (item?: Ticket) => {
    ticket = item;
    try {
      if (item) sessionStorage.setItem(key, JSON.stringify(item));
      else sessionStorage.removeItem(key);
    } catch { /* The live session can still reconnect using its in-memory ticket. */ }
  };
  function stop() {
    clearTimeout(retry);
    const old = socket;
    socket = undefined;
    admitted = false;
    if (old && old.readyState < 2) old.close();
  }
  function connect(handshake: Handshake, retrying = false) {
    stop();
    callbacks.onStatus?.(retrying ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch { callbacks.onError?.('Invalid multiplayer server address.'); callbacks.onStatus?.('closed'); return; }
    socket = ws;
    ws.onopen = () => { if (socket === ws) ws.send(JSON.stringify(handshake)); };
    ws.onmessage = event => {
      if (socket !== ws) return;
      const msg = JSON.parse(event.data as string) as ServerMessage;
      if (msg.type === 'room') {
        remember({ code: msg.room.code, token: msg.room.token });
        attempts = 0;
        admitted = true;
        callbacks.onStatus?.('connected');
        callbacks.onRoom?.(msg.room);
      } else if (msg.type === 'state') {
        callbacks.onState?.(msg.state, msg.ready, msg.ack);
      } else if (msg.type === 'error') {
        if (!admitted) { remember(); stop(); callbacks.onStatus?.('closed'); }
        callbacks.onError?.(msg.message);
      }
    };
    ws.onclose = event => {
      if (socket !== ws) return;
      admitted = false;
      if (event.code === 4001) {
        remember();
        callbacks.onError?.('This seat opened in another connection.');
      }
      if (ticket) {
        callbacks.onStatus?.('reconnecting');
        retry = setTimeout(() => { if (ticket) connect({ type: 'resume', ...ticket }, true); }, Math.min(4000, 250 * 2 ** Math.min(attempts++, 4)));
      } else {
        if (event.code === 1006) callbacks.onError?.('Multiplayer server unavailable. Check the server address and connection.');
        callbacks.onStatus?.('closed');
      }
    };
  }
  return {
    create(config: RoomConfig) { attempts = seq = 0; remember(); connect({ type: 'create', config }); },
    join(code: string) { attempts = seq = 0; remember(); connect({ type: 'join', code: code.trim().toUpperCase() }); },
    resume() {
      const item = ticket ?? saved();
      if (!item) return false;
      ticket = item;
      connect({ type: 'resume', ...item });
      return true;
    },
    input(playerId: string, control: Control) {
      if (admitted && socket?.readyState === 1 && socket.bufferedAmount < 32768) socket.send(JSON.stringify({ type: 'input', seq: ++seq, playerId, control }));
    },
    close(forget = false) { stop(); if (forget) remember(); callbacks.onStatus?.('closed'); },
  };
}
