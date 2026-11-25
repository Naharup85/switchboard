import express from 'express';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import {
  ensureIndexes,
  type ConversationDoc,
  type InboundMessageDoc,
  type OutboundMessageDoc,
  type ProcessedEventDoc,
} from './store.js';
import { startWorkers } from './worker.js';

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Helper for Pigeon webhook signature verification
function verifyPigeonSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const parts = signatureHeader.split(',').map((p) => p.trim());
  let tStr: string | undefined;
  let v1: string | undefined;

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (key === 't') tStr = value;
    else if (key === 'v1') v1 = value;
  }

  if (!tStr || !v1) {
    return false;
  }

  if (!/^\d+$/.test(tStr)) {
    return false;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(v1)) {
    return false;
  }

  const t = Number(tStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > 300) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${tStr}.`);
  hmac.update(rawBody);
  const computedHex = hmac.digest('hex');

  const v1Buf = Buffer.from(v1, 'hex');
  const compBuf = Buffer.from(computedHex, 'hex');

  if (v1Buf.length !== 32 || compBuf.length !== 32) {
    return false;
  }

  return crypto.timingSafeEqual(v1Buf, compBuf);
}

// POST /webhooks/pigeon must be registered before express.json()
app.post('/webhooks/pigeon', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(req.body || '');

  // 1. Signature validation - 401 if missing, malformed or invalid (never 5xx)
  let sigValid = false;
  try {
    const sigHeader = req.headers['x-pigeon-signature'];
    sigValid = typeof sigHeader === 'string' && verifyPigeonSignature(rawBody, sigHeader, config.pigeon.webhookSecret);
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Parse JSON body after signature validation - 400 on invalid JSON (never 5xx)
  let body: any;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }

  const { id: event_id, type, workspace, occurred_at, data } = body;

  // 3. Return 200 and ignore unknown workspace or unknown type
  if (!workspace || !(workspace in config.pigeon.apiKeys)) {
    return res.status(200).json({ ok: true, ignored: 'unknown workspace' });
  }

  if (type !== 'message.inbound' && type !== 'message.status') {
    return res.status(200).json({ ok: true, ignored: 'unknown type' });
  }

  try {
    const db = await getDb();

    // 4. Handle message.inbound
    if (type === 'message.inbound') {
      const contact = data?.from;
      const message_id = data?.message_id;
      const text = data?.text ?? '';

      if (!contact || !message_id) {
        return res.status(200).json({ ok: true, ignored: 'missing contact or message_id' });
      }

      // Upsert conversation
      try {
        await db.collection<ConversationDoc>('conversations').updateOne(
          { workspace, contact },
          {
            $setOnInsert: {
              workspace,
              contact,
              assignee: null,
              createdAt: new Date(),
            },
            $set: {
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (err: any) {
        if (err.code !== 11000) throw err;
      }

      // Idempotently insert inbound message
      try {
        await db.collection<InboundMessageDoc>('inbound_messages').insertOne({
          workspace,
          contact,
          message_id,
          text,
          occurred_at: occurred_at ?? new Date().toISOString(),
          createdAt: new Date(),
        });
      } catch (err: any) {
        if (err.code !== 11000) throw err;
      }

      // Record event_id in processed_events
      if (event_id) {
        try {
          await db.collection<ProcessedEventDoc>('processed_events').insertOne({
            event_id,
            processed_at: new Date(),
          });
        } catch (err: any) {
          if (err.code !== 11000) throw err;
        }
      }

      return res.status(200).json({ ok: true });
    }

    // 5. Handle message.status
    if (type === 'message.status') {
      const client_ref = data?.client_ref;
      const pigeonMessageId = data?.message_id;
      const newStatus = data?.status;

      if (!client_ref && !pigeonMessageId) {
        return res.status(200).json({ ok: true, ignored: 'no client_ref or message_id' });
      }

      const query: any = {};
      if (client_ref && pigeonMessageId) {
        query.$or = [{ client_ref }, { pigeon_message_id: pigeonMessageId }];
      } else if (client_ref) {
        query.client_ref = client_ref;
      } else {
        query.pigeon_message_id = pigeonMessageId;
      }

      const existing = await db.collection<OutboundMessageDoc>('outbound_messages').findOne(query);
      if (!existing) {
        return res.status(200).json({ ok: true, ignored: 'message not in outbound_messages' });
      }

      const updateSet: any = { updatedAt: new Date() };
      if (pigeonMessageId && !existing.pigeon_message_id) {
        updateSet.pigeon_message_id = pigeonMessageId;
      }

      // Advance status monotonically: queued < sent < delivered/failed
      if (newStatus === 'delivered' || newStatus === 'failed') {
        updateSet.status = newStatus;
        await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
          { _id: existing._id, status: { $in: ['queued', 'sent'] } },
          { $set: updateSet }
        );
      } else if (newStatus === 'sent') {
        updateSet.status = newStatus;
        await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
          { _id: existing._id, status: 'queued' },
          { $set: updateSet }
        );
      } else if (pigeonMessageId && !existing.pigeon_message_id) {
        await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
          { _id: existing._id },
          { $set: { pigeon_message_id: pigeonMessageId, updatedAt: new Date() } }
        );
      }

      // Record event_id in processed_events
      if (event_id) {
        try {
          await db.collection<ProcessedEventDoc>('processed_events').insertOne({
            event_id,
            processed_at: new Date(),
          });
        } catch (err: any) {
          if (err.code !== 11000) throw err;
        }
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'webhook error' });
  }
});

// JSON body parser for subsequent routes
app.use(express.json());

// Grader authentication middleware
app.use('/__grader', (req, res, next) => {
  if (req.headers['x-grader-token'] !== config.graderToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// POST /__grader/reset
app.post('/__grader/reset', async (_req, res) => {
  try {
    const db = await getDb();
    await Promise.all([
      db.collection('conversations').deleteMany({}),
      db.collection('inbound_messages').deleteMany({}),
      db.collection('outbound_messages').deleteMany({}),
      db.collection('processed_events').deleteMany({}),
      db.collection('ws_events').deleteMany({}),
    ]);

    const redis = getRedis();
    const [pigeonKeys, wsKeys] = await Promise.all([
      redis.keys('pigeon:*'),
      redis.keys('ws:*'),
    ]);
    const keysToDelete = [...pigeonKeys, ...wsKeys];
    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
    }

    res.status(200).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'reset failed' });
  }
});

// GET /__grader/snapshot
app.get('/__grader/snapshot', async (_req, res) => {
  try {
    const db = await getDb();
    const [conversations, inboundMsgs, outboundMsgs] = await Promise.all([
      db.collection<ConversationDoc>('conversations').find({}).toArray(),
      db.collection<InboundMessageDoc>('inbound_messages').find({}).toArray(),
      db.collection<OutboundMessageDoc>('outbound_messages').find({}).toArray(),
    ]);

    const workspaces: Record<
      string,
      {
        contacts: Record<string, { inbound: string[]; assignee: string | null }>;
        outbound: Record<string, string>;
      }
    > = {};

    const getWorkspace = (ws: string) => {
      if (!workspaces[ws]) {
        workspaces[ws] = { contacts: {}, outbound: {} };
      }
      return workspaces[ws];
    };

    // Populate conversations
    for (const conv of conversations) {
      const wsObj = getWorkspace(conv.workspace);
      if (!wsObj.contacts[conv.contact]) {
        wsObj.contacts[conv.contact] = {
          inbound: [],
          assignee: conv.assignee ?? null,
        };
      } else {
        wsObj.contacts[conv.contact].assignee = conv.assignee ?? null;
      }
    }

    // Sort inbound messages by occurred_at ascending
    inboundMsgs.sort((a, b) => {
      const ta = typeof a.occurred_at === 'number' ? a.occurred_at : new Date(a.occurred_at).getTime();
      const tb = typeof b.occurred_at === 'number' ? b.occurred_at : new Date(b.occurred_at).getTime();
      const diff = (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
      if (diff !== 0) return diff;
      return a.message_id.localeCompare(b.message_id);
    });

    for (const msg of inboundMsgs) {
      const wsObj = getWorkspace(msg.workspace);
      if (!wsObj.contacts[msg.contact]) {
        wsObj.contacts[msg.contact] = {
          inbound: [],
          assignee: null,
        };
      }
      wsObj.contacts[msg.contact].inbound.push(msg.message_id);
    }

    // Populate outbound messages
    for (const msg of outboundMsgs) {
      const wsObj = getWorkspace(msg.workspace);
      wsObj.outbound[msg.client_ref] = msg.status;
    }

    res.json({ workspaces });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'snapshot failed' });
  }
});

// POST /__grader/claim
app.post('/__grader/claim', async (req, res) => {
  const { workspace, contact, agent } = req.body || {};
  if (!workspace || !contact || !agent) {
    return res.status(400).json({ error: 'workspace, contact, and agent are required' });
  }

  try {
    const db = await getDb();
    const result = await db.collection<ConversationDoc>('conversations').findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [{ assignee: null }, { assignee: agent }],
      },
      {
        $set: { assignee: agent, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, returnDocument: 'after' }
    );

    if (result) {
      return res.status(200).json({ ok: true, assignee: agent });
    }
    return res.status(409).json({ error: 'already held by another agent' });
  } catch (err: any) {
    if (err.code === 11000) {
      const db = await getDb();
      const existing = await db.collection<ConversationDoc>('conversations').findOne({ workspace, contact });
      if (existing && existing.assignee === agent) {
        return res.status(200).json({ ok: true, assignee: agent });
      }
      return res.status(409).json({ error: 'already held by another agent' });
    }
    return res.status(500).json({ error: err.message || 'claim failed' });
  }
});

// POST /__grader/reply
app.post('/__grader/reply', async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body || {};
  if (!workspace || !(workspace in config.pigeon.apiKeys)) {
    return res.status(400).json({ error: 'workspace not found' });
  }
  if (!contact || !client_ref) {
    return res.status(400).json({ error: 'contact and client_ref are required' });
  }

  try {
    const db = await getDb();

    // Upsert conversation
    try {
      await db.collection<ConversationDoc>('conversations').updateOne(
        { workspace, contact },
        {
          $setOnInsert: {
            workspace,
            contact,
            assignee: null,
            createdAt: new Date(),
          },
          $set: {
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (err: any) {
      if (err.code !== 11000) throw err;
    }

    // Idempotently insert into outbound_messages
    try {
      await db.collection<OutboundMessageDoc>('outbound_messages').insertOne({
        client_ref,
        workspace,
        contact,
        text: text ?? '',
        status: 'queued',
        attempts: 0,
        lockedUntil: 0,
        nextAttemptAt: Date.now(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (err: any) {
      if (err.code !== 11000) throw err;
    }

    return res.status(202).json({ ok: true, status: 'queued' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'reply failed' });
  }
});

// Initialize database indexes before listening
await ensureIndexes();

// Start outbound message workers
startWorkers(4);

const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});
