import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import {
  ensureIndexes,
  type ConversationDoc,
  type InboundMessageDoc,
  type OutboundMessageDoc,
} from './store.js';

const app = express();

app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

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

const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});
