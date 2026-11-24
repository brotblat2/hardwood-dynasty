import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createRoomServer } from '../apps/multiplayer-server/server.ts';
import { control as validateControl } from '../apps/multiplayer-server/validate.ts';
import { fixtureTeam } from '../packages/contracts/fixtures.ts';
import type { ClientMessage, ServerMessage } from '../packages/contracts/index.ts';
import { createRoomClient } from '../packages/multiplayer/index.ts';

async function peer(url: string) {
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((ok,bad) => { ws.once('open',ok); ws.once('error',bad); });
  return {
    ws,
    send(msg: ClientMessage) { ws.send(JSON.stringify(msg)); },
    async next<T extends ServerMessage['type']>(type:T, filter?: (m:Extract<ServerMessage,{type:T}>) => boolean) {
      for (let i=0; i<300; i++) {
        const idx = messages.findIndex(m => m.type === type && (!filter || filter(m as Extract<ServerMessage,{type:T}>)));
        if (idx >= 0) return messages.splice(idx,1)[0] as Extract<ServerMessage,{type:T}>;
        await new Promise(ok => setTimeout(ok,10));
      }
      throw Error('Timed out waiting for ' + type);
    },
    disconnect() { return new Promise<void>(ok => { ws.once('close',() => ok()); ws.close(); }); }
  };
}
async function boot(dir:string) {
  const server = createRoomServer({dir});
  await new Promise<void>(ok => server.http.listen(0,'127.0.0.1',ok));
  const port = (server.http.address() as AddressInfo).port;
  return { ...server, url:'ws://127.0.0.1:' + port + '/room' };
}
const config = {teams: [fixtureTeam('alpha'),fixtureTeam('bravo','West')] as [ReturnType<typeof fixtureTeam>,ReturnType<typeof fixtureTeam>]};

test('private seats, delayed input, disconnect pause and durable reconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(),'hardwood-net-'));
  let server = await boot(dir);
  t.after(async () => { await server.close(); await rm(dir,{recursive:true,force:true}); });
  const a = await peer(server.url), b = await peer(server.url);
  a.send({type:'create',config});
  const host = (await a.next('room')).room;
  assert.equal(host.slot,0); assert.equal(host.ready,false);
  assert.equal((await a.next('state')).state.tick,0);
  b.send({type:'join',code:host.code});
  const visitor = (await b.next('room')).room;
  assert.equal(visitor.slot,1); assert.notEqual(visitor.token,host.token);
  const stranger = await peer(server.url);
  stranger.send({type:'resume',code:host.code,token:'incorrect'});
  assert.match((await stranger.next('error')).message,/ticket/);
  stranger.send({type:'join',code:host.code});
  assert.match((await stranger.next('error')).message,/reserved/);
  const base = await a.next('state',m => m.ready);
  const homePlayer = base.state.players.find(p => p.side === 0)!;
  const otherPlayer = base.state.players.find(p => p.side === 1)!;
  const command = {type:'input', seq:2, playerId:homePlayer.id, control:{move:{x:0,z:1}}} as const;
  a.send({...command,playerId:otherPlayer.id});
  assert.match((await a.next('error')).message,/your team/);
  a.send({...command,control:{move:{x:5,z:0}}});
  assert.match((await a.next('error')).message,/controls/);
  await new Promise(ok => setTimeout(ok,90));
  a.send(command);
  a.send({...command,seq:1});
  const applied = await a.next('state',m => m.ack === 2);
  assert.ok(applied.state.tick > base.state.tick);
  const mirror = await b.next('state',m => m.state.tick === applied.state.tick);
  assert.deepEqual(mirror.state,applied.state);
  assert.equal(mirror.ack,0);
  await b.disconnect();
  const paused = await a.next('state',m => !m.ready);
  await new Promise(ok => setTimeout(ok,75));
  await server.close();
  server = await boot(dir);
  const restored = await peer(server.url);
  restored.send({type:'resume',code:host.code,token:host.token});
  assert.equal((await restored.next('room')).room.slot,0);
  const recovered = await restored.next('state');
  assert.deepEqual(recovered.state, paused.state);
  const visitorAgain = await peer(server.url);
  visitorAgain.send({type:'resume',code:host.code,token:visitor.token});
  const active = await restored.next('state',m => m.ready && m.state.tick > paused.state.tick);
  assert.equal(active.state.teams[1].id,'bravo');
});

test('browser client restores its seat from session storage after reload', async t => {
  const dir = await mkdtemp(join(tmpdir(),'hardwood-browser-'));
  const server = await boot(dir);
  const previous = Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const kv = new Map<string,string>();
  Object.defineProperty(globalThis,'sessionStorage',{ configurable:true, value:{
    getItem:(key:string) => kv.get(key) ?? null,
    setItem:(key:string,v:string) => kv.set(key,v),
    removeItem:(key:string) => kv.delete(key)
  }});
  t.after(async () => {
    if (previous) Object.defineProperty(globalThis,'sessionStorage',previous);
    else Reflect.deleteProperty(globalThis,'sessionStorage');
    await server.close(); await rm(dir,{recursive:true,force:true});
  });
  function openClient(resume: boolean) {
    return new Promise<{client: ReturnType<typeof createRoomClient>; token: string}>((ok, bad) => {
      const client = createRoomClient(server.url, { onRoom:r => ok({client, token:r.token}), onError:bad });
      if (resume) assert.equal(client.resume(),true);
      else client.create(config);
    });
  }
  const first = await openClient(false);
  first.client.close();
  const second = await openClient(true);
  assert.equal(second.token,first.token);
  second.client.close(true);
  assert.equal(second.client.resume(),false);
});

test('control validator accepts new gameplay fields and rejects invalid enums', () => {
  assert.equal(validateControl({
    move: { x: 0.5, z: -0.5 },
    shotType: 'fadeaway',
    pumpFake: true,
    callScreen: true,
    callPass: false,
    offensePlay: 'fiveOut',
    defenseScheme: 'zone23',
  }), true);
  assert.equal(validateControl({ move: { x: 0, z: 0 }, shotType: 'skyhook' }), false);
  assert.equal(validateControl({ move: { x: 0, z: 0 }, offensePlay: 'triangle' }), false);
  assert.equal(validateControl({ move: { x: 0, z: 0 }, defenseScheme: 'box1' }), false);
  assert.equal(validateControl({ move: { x: 0, z: 0 }, pumpFake: 1 }), false);
});
