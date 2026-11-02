// Entry Cloudflare Worker: file statis dari /public, API & WebSocket diteruskan ke satu Durable Object.
import { DurableObject } from 'cloudflare:workers';
import { initDb } from './db.js';
import { createStore } from './store.js';

export class CafeStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.db = await initDb(ctx.storage, env);
      this.store = createStore({ db: this.db, broadcast: (room, event, data) => this.broadcast(room, event, data) });
    });
  }

  broadcast(room, event, data) {
    const msg = JSON.stringify({ event, data });
    for (const ws of this.ctx.getWebSockets(room || 'all')) {
      try {
        ws.send(msg);
      } catch {
        /* koneksi sudah tertutup */
      }
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Butuh WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const rooms = this.store.socketRooms(url.searchParams);
      // Tag "all" agar broadcast global (tanpa room) bisa menjangkau semua klien.
      this.ctx.acceptWebSocket(pair[1], ['all', ...rooms]);
      pair[1].serializeAttachment({ rooms });
      pair[1].send(JSON.stringify({ event: 'hello', data: { rooms } }));
      if (rooms.includes('monitor')) pair[1].send(JSON.stringify({ event: 'queue:update', data: this.store.queueSnapshot() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return this.store.api.handle(request, url.pathname.replace(/^\/api/, '') || '/');
  }

  async webSocketMessage(ws, message) {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code, 'bye');
    } catch {
      /* sudah tertutup */
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const stub = env.CAFE.get(env.CAFE.idFromName('five5star'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
