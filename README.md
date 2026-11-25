# Switchboard

Switchboard is a shared team inbox for customer support. Support agents can log in, view real-time customer conversations across their assigned workspaces, claim tickets, reply to customers, and track message delivery states.

## Architecture

- **Backend**: Express + TypeScript server (`scaffold/server`), MongoDB 7+, Redis 7+
- **Frontend**: Vite + React 19 inbox application (`scaffold/web`)
- **Simulators**: Pigeon (messaging provider on port 4010), Mock IdP (OIDC provider on port 4020)

## Quick Start from a Clean Clone

### 1. Start Services
Ensure Docker is installed and running:
```bash
npm run up          # Starts MongoDB, Redis, and simulators in Docker
npm run doctor      # Verifies all services and ports
```

*(Alternatively, without Docker: `npm run mocks` starts the Node simulators; set `MONGO_URL` and `REDIS_URL` to local instances.)*

### 2. Install Dependencies
```bash
npm run scaffold:install
```

### 3. Run Development Servers
In separate terminal windows:
```bash
# Server runs on http://localhost:4000
npm run scaffold:server

# Web app runs on http://localhost:5173
npm run scaffold:web
```

Open [http://localhost:5173](http://localhost:5173) in your browser. Click **"Sign in with Switchboard IdP"** and choose any test user (e.g. `Ben Ortiz` or `Asha Rao`).

---

## Running Verification & Grader Checks

Before running checks, make sure your dev server is stopped (the test harness starts and load balances server instances automatically).

```bash
# Level 1 only (Bad network, chaos, rate limits, claim race, outage)
npm run check

# Full check (Levels 1, 2, 3, and 5)
npm run check:full

# Run specific levels (e.g. Level 5)
npm run check -- --levels 5
```

Reports are written to `CHECK_REPORT.json`.

---

## Helpful Development Commands

```bash
npm run inbound     # Simulate an inbound customer message
npm run chaos       # Trigger a burst of chaos traffic from Pigeon
npm run quiet       # Disable background message drizzle
npm run drizzle     # Re-enable message drizzle
npm run report      # View Pigeon delivery and status report
```
