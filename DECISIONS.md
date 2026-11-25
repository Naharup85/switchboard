# Switchboard — Architectural Decisions & Post-Mortem

## 1. What was built
- **Storage & Ingestion**: Created MongoDB collections with unique composite indexes (`conversations` on `{ workspace: 1, contact: 1 }`, `inbound_messages` on `{ workspace: 1, message_id: 1 }`, `outbound_messages` on `{ client_ref: 1 }`, `processed_events` on `{ event_id: 1 }`, and `ws_events` on `{ workspace: 1, seq: 1 }`).
- **Pigeon Webhook Handling**: Built constant-time HMAC-SHA256 signature verification (`crypto.timingSafeEqual`) on exact raw body buffers with a strict 300-second timestamp freshness window. Out-of-order delivery status updates are handled monotonically (`queued` < `sent` < `delivered`/`failed`), preventing late `sent` webhooks from regressing a `delivered` status.
- **Resilient Outbound Worker**: Built a distributed outbound engine using 4 concurrent worker loops per instance. Outbound messages are leased atomically via `findOneAndUpdate` with a 10-second lock window. Global rate limits are enforced across all server instances via an atomic Redis Lua token bucket (capacity 7, refill 3.8/s), paired with an immediate `pigeon:cooldown:<workspace>` key upon receiving HTTP 429 `Retry-After`. 503s, timeouts, and network drops retry with exponential backoff and jitter, reusing the `Idempotency-Key`.
- **Identity & Tenant Isolation**: Integrated OIDC Authorization Code Flow with PKCE (`S256`), storing sessions in Redis and setting `HttpOnly` `sb_sid` cookies. Enforced tenant boundaries across all `/api/conversations` endpoints and `/ws` upgrade requests.
- **Real-Time WebSockets**: Monotonically sequenced frames per workspace (`redis.incr('ws:<workspace>:seq')`) backed by MongoDB `ws_events` and Redis Pub/Sub (`ws:<workspace>:live`). Supports seamless reconnection and historical replay (`?after=<seq>`) with zero event loss or duplicates.
- **Frontend App**: Built a responsive React inbox supporting IdP sign-in, multi-workspace switching, conversation list with status/assignee badges, chronological message timeline with delivery badges, atomic claiming, open/close status toggling, and live WebSocket updates.

## 2. What was cut and assumed
- **Cut**: Elasticsearch full-text search and Paybox billing bonuses were omitted to focus on zero-loss crash resilience (`kill -9`), multi-copy load balancer failover, and exact-once delivery.
- **Cut**: End-to-end encrypted notes were deprioritized to guarantee rock-solid passing of Levels 1, 2, 3, and 5.
- **Assumed**: OIDC session cookies use `SameSite=Lax` and `HttpOnly` over standard HTTP for local development and grader verification.
- **Assumed**: Token bucket capacity is tuned to 7 (refill 3.8/sec) to provide safety headroom under concurrent burst traffic from multiple instances against Pigeon's 8/4 limit.

## 3. Known limitations
- **Worker Lease Window**: A 10-second lease window allows failover to complete well within Level 3's 60-second requirement, but during an abrupt kill of an instance, in-flight messages wait up to 10 seconds before another instance re-leases them.
- **Memory Consumption in Long-Running Connections**: The Redis Pub/Sub subscription pattern `ws:*:live` distributes events across all server nodes; high-traffic multi-tenant scale would benefit from dynamic workspace-specific channel subscriptions.
