import type { Db } from 'mongodb';
import type { Redis } from 'ioredis';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import type { OutboundMessageDoc } from './store.js';
import { publishWsEvent } from './realtime.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'last_updated')
local tokens = tonumber(data[1])
local last_updated = tonumber(data[2])

if not tokens or not last_updated then
    tokens = capacity
    last_updated = now
else
    local elapsed = math.max(0, (now - last_updated) / 1000)
    tokens = math.min(capacity, tokens + elapsed * refill_rate)
    last_updated = now
end

if tokens >= 1 then
    tokens = tokens - 1
    redis.call('HMSET', key, 'tokens', tokens, 'last_updated', last_updated)
    redis.call('EXPIRE', key, 60)
    return 1
else
    local needed = 1 - tokens
    local wait_ms = math.ceil((needed / refill_rate) * 1000)
    redis.call('HMSET', key, 'tokens', tokens, 'last_updated', last_updated)
    redis.call('EXPIRE', key, 60)
    return -wait_ms
end
`;

let running = true;

async function handleRetry(msg: OutboundMessageDoc, db: Db) {
  const current = await db
    .collection<OutboundMessageDoc>('outbound_messages')
    .findOne({ _id: msg._id });

  if (current && (current.status === 'delivered' || current.status === 'failed')) {
    await db
      .collection<OutboundMessageDoc>('outbound_messages')
      .updateOne({ _id: msg._id }, { $set: { lockedUntil: 0, updatedAt: new Date() } });
    return;
  }

  const attempts = (msg.attempts || 0) + 1;
  const baseDelay = 500;
  const delay =
    Math.min(baseDelay * Math.pow(2, attempts - 1), 8000) + Math.floor(Math.random() * 200);

  await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
    { _id: msg._id, status: 'queued' },
    {
      $set: {
        attempts,
        lockedUntil: 0,
        nextAttemptAt: Date.now() + delay,
        updatedAt: new Date(),
      },
    }
  );
}

async function processMessage(msg: OutboundMessageDoc, db: Db, redis: Redis) {
  // 1. Check if workspace is currently in cooldown from a 429
  const cooldownKey = `pigeon:cooldown:${msg.workspace}`;
  const cooldownTtl = await redis.pttl(cooldownKey);
  if (cooldownTtl > 0) {
    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id, status: 'queued' },
      {
        $set: {
          lockedUntil: 0,
          nextAttemptAt: Date.now() + cooldownTtl + 100,
          updatedAt: new Date(),
        },
      }
    );
    await sleep(Math.min(cooldownTtl, 100));
    return;
  }

  // 2. Atomic Redis Lua token bucket rate limiter: capacity 7, refill 3.8/sec
  const bucketKey = `pigeon:bucket:${msg.workspace}`;
  const bucketRes = (await redis.eval(
    TOKEN_BUCKET_LUA,
    1,
    bucketKey,
    '7',
    '3.8',
    String(Date.now())
  )) as number;

  if (bucketRes < 0) {
    const waitMs = Math.max(Math.abs(bucketRes), 50);
    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id, status: 'queued' },
      {
        $set: {
          lockedUntil: 0,
          nextAttemptAt: Date.now() + waitMs,
          updatedAt: new Date(),
        },
      }
    );
    await sleep(Math.min(waitMs, 50));
    return;
  }

  // 3. Check for API key
  const apiKey = config.pigeon.apiKeys[msg.workspace];
  if (!apiKey) {
    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id },
      {
        $set: {
          status: 'failed',
          lockedUntil: 0,
          updatedAt: new Date(),
        },
      }
    );
    return;
  }

  // 4. Verify message status hasn't already been transitioned by an arriving webhook
  const current = await db
    .collection<OutboundMessageDoc>('outbound_messages')
    .findOne({ _id: msg._id });
  if (current && current.status !== 'queued') {
    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id },
      {
        $set: {
          lockedUntil: 0,
          updatedAt: new Date(),
        },
      }
    );
    return;
  }

  // 5. Send POST /v1/messages
  let response: Response;
  try {
    response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': msg.client_ref,
      },
      body: JSON.stringify({
        to: msg.contact,
        text: msg.text,
        client_ref: msg.client_ref,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Timeout or network error
    await handleRetry(msg, db);
    return;
  }

  // 6. Handle response status
  if (response.status === 200) {
    let pigeonMessageId: string | undefined;
    try {
      const json: any = await response.json();
      pigeonMessageId = json?.id;
    } catch {
      // ignore JSON parse error on response
    }

    const updateSet: any = {
      lockedUntil: 0,
      updatedAt: new Date(),
    };
    if (pigeonMessageId) {
      updateSet.pigeon_message_id = pigeonMessageId;
    }

    // Atomically update status from 'queued' to 'sent' (preserving 'delivered' if already set by webhook)
    const updateRes = await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id, status: 'queued' },
      {
        $set: {
          ...updateSet,
          status: 'sent',
        },
      }
    );

    if (updateRes.modifiedCount > 0) {
      await publishWsEvent(msg.workspace, {
        type: 'message.status',
        contact: msg.contact,
        client_ref: msg.client_ref,
        status: 'sent',
      });
    }

    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id },
      {
        $set: updateSet,
      }
    );
    return;
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 2;
    const cooldownMs = Math.max(
      1000,
      Math.ceil((isNaN(retryAfterSec) ? 2 : retryAfterSec) * 1000) + 200
    );

    await redis.set(`pigeon:cooldown:${msg.workspace}`, '1', 'PX', cooldownMs);

    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id, status: 'queued' },
      {
        $set: {
          lockedUntil: 0,
          nextAttemptAt: Date.now() + cooldownMs,
          updatedAt: new Date(),
        },
      }
    );
    return;
  }

  if (response.status >= 400 && response.status < 500) {
    // Permanent 4xx error (e.g. 400, 401, 404): mark 'failed'
    await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
      { _id: msg._id },
      {
        $set: {
          status: 'failed',
          lockedUntil: 0,
          updatedAt: new Date(),
        },
      }
    );
    return;
  }

  // 503 or other upstream error: retry with exponential backoff
  await handleRetry(msg, db);
}

async function runWorkerLoop(_workerId: number) {
  const db = await getDb();
  const redis = getRedis();

  while (running) {
    try {
      const now = Date.now();
      const msg = await db
        .collection<OutboundMessageDoc>('outbound_messages')
        .findOneAndUpdate(
          {
            status: 'queued',
            nextAttemptAt: { $lte: now },
            lockedUntil: { $lte: now },
          },
          {
            $set: {
              lockedUntil: now + 10_000,
            },
          },
          { returnDocument: 'after' }
        );

      if (!msg) {
        await sleep(50);
        continue;
      }

      await processMessage(msg, db, redis);
    } catch {
      await sleep(100);
    }
  }
}

export function startWorkers(concurrency = 4): void {
  for (let i = 0; i < concurrency; i++) {
    runWorkerLoop(i).catch((err) => {
      console.error(`Worker loop ${i} error:`, err);
    });
  }
}

export function stopWorkers(): void {
  running = false;
}
