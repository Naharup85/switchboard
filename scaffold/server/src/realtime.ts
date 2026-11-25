import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { parseCookies, getSessionUserFromCookie } from './auth.js';
import type { WsEventDoc } from './store.js';

interface ClientEntry {
  ws: WebSocket;
  workspace: string;
  ready: boolean;
  lastSentSeq: number;
  buffer: string[];
}

const clientsByWorkspace = new Map<string, Set<ClientEntry>>();
let subRedisClient: any = null;

export function broadcastToLocalClients(workspace: string, message: string, seq: number): void {
  const clients = clientsByWorkspace.get(workspace);
  if (!clients || clients.size === 0) return;

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (!client.ready) {
      client.buffer.push(message);
    } else {
      if (seq > client.lastSentSeq) {
        client.ws.send(message);
        client.lastSentSeq = seq;
      }
    }
  }
}

export async function initRealtime(): Promise<void> {
  if (subRedisClient) return;

  const redis = getRedis();
  subRedisClient = redis.duplicate();

  await subRedisClient.psubscribe('ws:*:live');

  subRedisClient.on('pmessage', (_pattern: string, channel: string, message: string) => {
    // Channel format: ws:<workspace>:live
    const parts = channel.split(':');
    if (parts.length < 3) return;
    const workspace = parts[1];
    try {
      const frame = JSON.parse(message);
      broadcastToLocalClients(workspace, message, frame.seq);
    } catch {
      // ignore malformed message
    }
  });
}

export interface WsEventPayload {
  type: string;
  [key: string]: any;
}

export async function publishWsEvent(
  workspace: string,
  eventData: WsEventPayload
): Promise<any> {
  const redis = getRedis();
  const db = await getDb();

  // Monotonic seq per workspace
  const seq = await redis.incr(`ws:${workspace}:seq`);
  const frame: WsEventDoc = {
    ...eventData,
    workspace,
    seq,
    createdAt: new Date(),
  };

  // Persist in ws_events
  try {
    await db.collection<WsEventDoc>('ws_events').insertOne(frame);
  } catch (err: any) {
    if (err.code !== 11000) throw err;
  }

  const jsonStr = JSON.stringify(frame);

  // Broadcast to local clients immediately
  broadcastToLocalClients(workspace, jsonStr, frame.seq);

  // Broadcast over Redis Pub/Sub to other instances
  await redis.publish(`ws:${workspace}:live`, jsonStr);
  return frame;
}

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '', `http://${host}`);

      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const workspace = url.searchParams.get('workspace');
      const afterStr = url.searchParams.get('after');
      const after =
        afterStr !== null && afterStr !== undefined && afterStr !== ''
          ? Number(afterStr)
          : undefined;

      // 1. Authenticate cookie
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies.sb_sid;
      if (!sid) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized'
        );
        socket.destroy();
        return;
      }

      const user = await getSessionUserFromCookie(sid);
      if (!user) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized'
        );
        socket.destroy();
        return;
      }

      // 2. Validate workspace parameter and tenant isolation
      if (!workspace) {
        socket.write(
          'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Request'
        );
        socket.destroy();
        return;
      }

      const hasAccess = user.workspaces?.some((w) => w.id === workspace);
      if (!hasAccess) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden'
        );
        socket.destroy();
        return;
      }

      // 3. Upgrade to WebSocket
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleClientConnection(ws, workspace, after);
      });
    } catch {
      socket.destroy();
    }
  });

  return wss;
}

async function handleClientConnection(
  ws: WebSocket,
  workspace: string,
  after?: number
): Promise<void> {
  let clients = clientsByWorkspace.get(workspace);
  if (!clients) {
    clients = new Set();
    clientsByWorkspace.set(workspace, clients);
  }

  const client: ClientEntry = {
    ws,
    workspace,
    ready: after === undefined,
    lastSentSeq: after !== undefined ? after : -1,
    buffer: [],
  };
  clients.add(client);

  ws.on('close', () => {
    clients?.delete(client);
  });
  ws.on('error', () => {
    clients?.delete(client);
  });

  try {
    const db = await getDb();
    if (after !== undefined) {
      // Replay missed events from ws_events where seq > after
      const missed = await db
        .collection<WsEventDoc>('ws_events')
        .find({ workspace, seq: { $gt: after } })
        .sort({ seq: 1 })
        .toArray();

      for (const doc of missed) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const { _id, createdAt, ...frame } = doc;
        if (frame.seq > client.lastSentSeq) {
          ws.send(JSON.stringify(frame));
          client.lastSentSeq = frame.seq;
        }
      }
    }
  } catch (err) {
    console.error('Error replaying ws events:', err);
  } finally {
    client.ready = true;
    const pending = client.buffer;
    client.buffer = [];
    for (const msg of pending) {
      if (ws.readyState !== WebSocket.OPEN) break;
      try {
        const frame = JSON.parse(msg);
        if (frame.seq > client.lastSentSeq) {
          ws.send(msg);
          client.lastSentSeq = frame.seq;
        }
      } catch {
        // ignore
      }
    }
  }
}
