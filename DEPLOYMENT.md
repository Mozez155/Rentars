# Rentars Deployment Guide

This document describes how to deploy the Rentars platform for both Stellar testnet and Stellar mainnet, including contracts, backend, frontend, monitoring, alerting, rollback, and validation.

## 1. Deployment Overview

Rentars is composed of three deployment layers:

- **Smart contracts**: Soroban contracts deployed on Stellar testnet or mainnet.
- **Backend**: Bun/Node API in `apps/backend` with Supabase/PostgreSQL and Redis.
- **Frontend**: Next.js application in `apps/web`, typically deployed to Vercel.

This guide assumes you have a working local repo clone and the following prerequisites installed:

- `bun`
- `node` / `npm`
- `rustup` + `cargo`
- `wasm32-unknown-unknown` Rust target
- `stellar-cli`
- A Supabase project or PostgreSQL database
- A Redis instance or managed Redis provider

---

## 2. Pre-Deployment Checklist

Before you deploy, confirm each item below:

- [ ] `apps/backend/.env` configured with production values
- [ ] `apps/web/.env.local` or Vercel environment variables configured
- [ ] Supabase database schema created and migrations applied
- [ ] Redis instance provisioned and reachable
- [ ] Stellar accounts created and funded for deployment
- [ ] Contract artifacts built in `apps/contracts/target/wasm32-unknown-unknown/release`
- [ ] Contract IDs recorded and stored securely
- [ ] Contract version registry updated with contract IDs, WASM hashes, and ABI versions for the target network
- [ ] Backend health endpoint (`/health`) returns success
- [ ] Frontend can connect to backend and Stellar RPC endpoints
- [ ] Wallet network, backend `STELLAR_NETWORK`, and frontend `NEXT_PUBLIC_STELLAR_NETWORK` all match
- [ ] Secrets are stored in an encrypted secrets manager, not in Git

### 2.1 Preflight checks

Run these before touching staging or testnet. Every command is read-only and
safe to run repeatedly.

```bash
# 1. Runtime versions match the pinned toolchain (.nvmrc / .tool-versions)
node --version && bun --version && rustc --version
bash scripts/check-engines.sh

# 2. Environment files parse and required keys are present (values are NOT printed)
node -e "const r=require('./apps/backend/.env.example');"  # placeholder check only
grep -q '^SUPABASE_URL=' apps/backend/.env || echo "MISSING: SUPABASE_URL"
grep -q '^JWT_SECRET='  apps/backend/.env || echo "MISSING: JWT_SECRET"

# 3. Database is reachable and migrations are current
psql "$DATABASE_URL" -c '\q' && echo "DB reachable"

# 4. Redis is reachable
redis-cli -u "$REDIS_URL" ping

# 5. Contract artifacts exist for the target network
ls apps/contracts/target/wasm32-unknown-unknown/release/*.wasm

# 5a. Configured contract IDs are known to the version registry for this network
#     (fails on unknown contract ID, ABI mismatch, or missing registry entry)
cd apps/backend && bun run contracts:validate
cd ..

# 5b. Network configuration is explicit and consistent (no silent testnet default)
grep -q '^STELLAR_NETWORK=' apps/backend/.env || echo "MISSING: STELLAR_NETWORK"
grep -q '^NEXT_PUBLIC_STELLAR_NETWORK=' apps/web/.env.local || echo "MISSING: NEXT_PUBLIC_STELLAR_NETWORK"

# 6. Dependency trees install cleanly from lockfiles
cd apps/backend && bun install --frozen-lockfile
cd ../web && yarn install --frozen-lockfile
```

Never paste secret values into tickets, chat, or logs. Record only the key name
and whether it is present.

### 2.2 Post-deployment verification

After deploying to staging or testnet, confirm every item below and record the
observed output. Failures must be resolved before promotion.

```bash
# Backend liveness + dependency health
curl -sf "$BACKEND_URL/health" | jq .
curl -sf "$BACKEND_URL/health/deep" | jq .

# API contract compatibility against the published OpenAPI document
cd apps/backend && API_BASE_URL="$BACKEND_URL" bun run test:contract

# A real read path and an authentication guard
curl -sf "$BACKEND_URL/api/v1/properties?limit=1" | jq '.data | length'
curl -s -o /dev/null -w '%{http_code}\n' "$BACKEND_URL/api/v1/bookings"  # expect 401

# Frontend reachable and serving the expected build
curl -sfI "$FRONTEND_URL" | head -1
```

| Check | Expected | Rollback trigger |
|---|---|---|
| `/health` | `status: ok` | non-200 or degraded dependency |
| `/health/deep` | all dependencies `connected` | any dependency down |
| Contract tests | all pass | any undocumented change |
| `GET /properties` | 200 + JSON array | 5xx or malformed body |
| `GET /bookings` unauthenticated | 401 | unexpected 200 |
| `GET /version/contracts` | registry entries match deployed IDs/hashes | unknown or mismatched contract |
| `GET /health/deep` `stellar.network` | equals configured `STELLAR_NETWORK` | network mismatch |

---

## 3. Stellar Testnet Setup

### 3.1 Create and fund testnet accounts

1. Generate a Stellar keypair for your deployment admin account.
2. Fund the account using the Stellar testnet Friendbot:

```bash
stellar keys generate --output json > testnet-admin.json
export TESTNET_ADMIN_ADDRESS=$(jq -r '.address' testnet-admin.json)
stellar friendbot fund --address "$TESTNET_ADMIN_ADDRESS" --network testnet
```

3. Verify the account balance:

```bash
stellar account show --account "$TESTNET_ADMIN_ADDRESS" --network testnet
```

### 3.2 Build Soroban contract artifacts

From the workspace root:

```bash
cd apps/contracts
cargo build --target wasm32-unknown-unknown --release
```

The generated WASM files will be in:

- `apps/contracts/target/wasm32-unknown-unknown/release/property-listing.wasm`
- `apps/contracts/target/wasm32-unknown-unknown/release/booking.wasm`
- `apps/contracts/target/wasm32-unknown-unknown/release/review-contract.wasm`

### 3.3 Deploy testnet contracts

Deploy each contract to the Stellar testnet using `stellar contract deploy`:

```bash
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/property-listing.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/booking.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/review-contract.wasm --source "$TESTNET_ADMIN_ADDRESS" --network testnet
```

Save the contract IDs returned by each command.

### 3.4 Initialize the booking contract

The booking contract must be initialized with the property listing contract ID.

```bash
PROPERTY_LISTING_CONTRACT_ID=<property_listing_contract_id>
BOOKING_CONTRACT_ID=<booking_contract_id>
stellar contract invoke \
  --id "$BOOKING_CONTRACT_ID" \
  --source "$TESTNET_ADMIN_ADDRESS" \
  --network testnet \
  -- initialize \
  --admin "$TESTNET_ADMIN_ADDRESS" \
  --property_listing_contract_id "$PROPERTY_LISTING_CONTRACT_ID"
```

### 3.5 Record contract IDs

Update the backend environment with the deployed values:

```env
PROPERTY_LISTING_CONTRACT_ID=<property_listing_contract_id>
BOOKING_CONTRACT_ID=<booking_contract_id>
REVIEW_CONTRACT_ID=<review_contract_id>
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
```

If the frontend needs any contract metadata or network endpoints, ensure it is configured through the backend API or Vercel environment values.

### 3.6 Contract version registry

Every deployed contract must be recorded in the version registry
(`apps/contracts/versions.json`, generated at build/deploy time and validated at
backend startup). Each entry records:

| Field | Description |
|---|---|
| `contract_id` | Deployed Soroban contract ID |
| `network` | `testnet` or `mainnet` |
| `wasm_hash` | SHA-256 hash of the deployed WASM artifact |
| `abi_version` | ABI version the contract exposes |
| `init_dependencies` | Contract IDs that must be initialized first (e.g. booking → property-listing) |
| `app_releases` | Application release versions known to be compatible with this entry |

Generate the registry entry during deployment (the deploy script writes it
automatically; do not hand-edit hashes):

```bash
cd apps/contracts
bun run versions:record --network testnet \
  --contract booking --id "$BOOKING_CONTRACT_ID" \
  --wasm target/wasm32-unknown-unknown/release/booking.wasm \
  --abi-version 1 \
  --init-dependency "$PROPERTY_LISTING_CONTRACT_ID"
```

The backend validates configured contract IDs against the registry at startup
and refuses to serve critical traffic if an ID is unknown, its ABI version is
incompatible with the running application, or its `init_dependencies` are not
satisfied. Non-sensitive version health data is exposed at
`GET /version/contracts` (contract ID, network, WASM hash, ABI version,
compatibility status — never secrets).

### 3.7 Network validation rules

Freighter signing, backend submission, contract IDs, and RPC configuration must
all refer to the same Stellar network. The backend enforces this independently
of the frontend:

- **Connection:** the wallet's reported network must equal `STELLAR_NETWORK`.
- **Quote:** quotes are tagged with the active network; a quote created on one
  network cannot be used on another.
- **Signing:** the frontend displays the active network before requesting
  authorization and refuses to sign if the wallet network differs.
- **Submission:** intents carry their network tag; the backend rejects any
  intent whose tag does not match `STELLAR_NETWORK` before broadcast.
- **Reconciliation:** reconciliation jobs only consider transactions on the
  configured network and RPC URL.

A mismatch must produce an actionable error (e.g. "Wallet is on mainnet but
Rentars is configured for testnet — switch networks in Freighter") and must
prevent signing or submission.

### 3.8 Production network policy

- `STELLAR_NETWORK` and `NEXT_PUBLIC_STELLAR_NETWORK` are **required** in
  production. The backend and frontend fail fast at startup if they are unset;
  there is no silent default to testnet.
- Production (`NODE_ENV=production`) must not use testnet RPC or Horizon URLs;
  startup validation rejects `*-testnet.stellar.org` endpoints in production.
- Mainnet contract IDs must be present in the registry for `network: mainnet`
  before the backend will accept traffic.

### 3.9 Staging-first upgrade sequencing

Contract upgrades must be proven on staging before production rollout:

1. Deploy the new contract version to testnet/staging and record its registry
   entry (`wasm_hash`, `abi_version`, `init_dependencies`).
2. Deploy the application release to staging and run `bun run contracts:validate`
   plus the post-deployment verification in §2.2.
3. Confirm the staging upgrade is compatible (ABI version, cross-contract calls,
   initialization) and record the result.
4. Only then deploy the same contract version and application release to
   mainnet, recording the mainnet registry entry.
5. If a compatibility check fails, roll back the staging application release and
   do not promote.

---

## 4. Backend Deployment

### 4.1 Required backend environment variables

Use `apps/backend/.env.example` as a template and populate the following values:

- `PORT` — backend port, typically `3000`
- `NODE_ENV` — `production`
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `JWT_SECRET` — secure JWT signing secret
- `CORS_ORIGIN` — frontend origin URL
- `REDIS_URL` — Redis connection string
- `STELLAR_NETWORK` — `testnet` or `mainnet` (required in production; no default)
- `STELLAR_RPC_URL` — Soroban RPC URL (must match `STELLAR_NETWORK`)
- `PROPERTY_LISTING_CONTRACT_ID` — on-chain contract ID
- `BOOKING_CONTRACT_ID` — on-chain contract ID
- `REVIEW_CONTRACT_ID` — on-chain contract ID
- `TRUSTLESS_WORK_API_URL` — escrow API URL
- `TRUSTLESS_WORK_API_KEY` — escrow API key
- `GEOCODING_API_KEY` — optional geocoding API key
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` — optional email settings

### 4.2 Database migration

The backend schema is managed under `apps/backend/database`. All migrations are
applied in the canonical order defined in
[`apps/backend/database/MIGRATIONS_NAMING.md`](apps/backend/database/MIGRATIONS_NAMING.md)
and listed in `setup.sql`. **Do not apply individual migration files by hand** —
always run the canonical entrypoint so ordering, duplicate-prefix handling, and
idempotency rules are preserved:

```bash
cd apps/backend/database
# DATABASE_URL may be a direct PostgreSQL connection string or a Supabase pooler URL.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql
```

`-v ON_ERROR_STOP=1` makes `psql` abort on the first SQL error, matching the CI
pipeline (`.github/workflows/ci.yml`, job `rls-tests`). This is the only supported
migration path for staging and production.

If the backend is deployed inside Docker, ensure the DB credentials in
`SUPABASE_URL` or `DATABASE_URL` are reachable from the container.

### 4.3 Redis setup

Provide a managed Redis URL or run Redis locally.

For local Docker-based development, the repo includes `apps/backend/docker-compose.yml` and root `docker-compose.yml`:

- `redis` service is `redis:7-alpine`
- backend environment may use `REDIS_URL=redis://redis:6379`

For production, use a Redis provider and set `REDIS_URL` to the provider’s secure URL.

### 4.4 Backend startup commands

Local development:

```bash
cd apps/backend
yarn install
bun run dev
```

Docker-based startup:

```bash
docker compose -f docker-compose.yml up --build
```

Production deployment should use your preferred container or VM tooling, ensuring environment variables and health checks are configured.

---

## 5. Frontend Deployment

### 5.1 Vercel configuration

Deploy `apps/web` as a Next.js application.

In Vercel:

- Set the root directory to `apps/web`
- Select `yarn install` or `npm install` as build step if needed
- Build command: `yarn build`
- Output directory: `.next`

### 5.2 Frontend environment variables

Configure the following Vercel environment variables for production or preview:

- `NEXT_PUBLIC_API_URL` — backend API endpoint (e.g. `https://api.rentars.app`)
- `NEXT_PUBLIC_STELLAR_NETWORK` — `testnet` or `mainnet` (required in production; must match backend `STELLAR_NETWORK`)
- `NEXT_PUBLIC_HORIZON_URL` — `https://horizon-testnet.stellar.org` or `https://horizon.stellar.org`
- `NEXT_PUBLIC_SOROBAN_RPC_URL` — `https://soroban-testnet.stellar.org` or `https://soroban-mainnet.stellar.org`
- `NEXT_PUBLIC_PASSKEY_RP_ID` — WebAuthn relying party ID for your domain
- `NEXT_PUBLIC_PASSKEY_RP_NAME` — `Rentars`
- `NEXT_PUBLIC_PASSKEY_ORIGIN` — frontend origin URL

If you deploy to Vercel, ensure the production values are set in the Production environment and preview values are set in Preview environments.

### 5.3 Frontend deployment validation

After deployment, verify:

- The site loads without console errors
- The API requests resolve correctly to the backend
- Stellar network selection uses the expected network and is displayed before authorization
- Wallet integration can connect to Freighter or other supported Stellar wallet
- A wallet on the wrong network is blocked from signing with an actionable message
- `GET /version/contracts` reports the deployed contract IDs, WASM hashes, and ABI versions

---

## 6. Mainnet Deployment Checklist

Before switching from testnet to mainnet, complete this checklist:

- [ ] Review all smart contracts for security issues
- [ ] Schedule a third-party contract audit if possible
- [ ] Confirm admin keys are stored offline and rotated securely
- [ ] Confirm all production environment variables use `mainnet` values
- [ ] Confirm `STELLAR_NETWORK` and `NEXT_PUBLIC_STELLAR_NETWORK` are explicitly set to `mainnet` (production must not default to testnet)
- [ ] Confirm no production RPC/Horizon URL points at `*-testnet.stellar.org`
- [ ] Confirm mainnet contract IDs, WASM hashes, and ABI versions are recorded in the version registry
- [ ] Confirm the staging upgrade of the same contract and app release passed compatibility checks
- [ ] Update `STELLAR_NETWORK` to `mainnet`
- [ ] Update `STELLAR_RPC_URL` to `https://soroban-mainnet.stellar.org`
- [ ] Update `NEXT_PUBLIC_HORIZON_URL` to `https://horizon.stellar.org`
- [ ] Update `NEXT_PUBLIC_SOROBAN_RPC_URL` to `https://soroban-mainnet.stellar.org`
- [ ] Deploy and fund a mainnet Stellar admin account
- [ ] Deploy contracts and capture mainnet contract IDs
- [ ] Validate backend and frontend integration in a staging environment
- [ ] Confirm backup and rollback procedures are tested

### 6.1 Contract and key management

- Keep mainnet deployment keys offline when not in active use.
- Use dedicated Stellar accounts for contract deployment and administration.
- Never expose the secret seed in Git or logs.
- Restrict access to production secrets in your secrets manager.

### 6.2 Security and audit

Perform the following before mainnet launch:

- Static analysis for Smart Contract code
- Review backend input validation and authentication flows
- Verify CORS origins and JWT secret policies
- Conduct a security review of network access and firewall rules
- Confirm database permissions and Supabase RLS policies if used

---

## 7. Rollback Procedures

### 7.1 Backend rollback

- Use a previously tested backend release image or commit
- Redeploy the prior backend version to your hosting platform
- Restore the database from a recent backup if schema or data is corrupted
- For Docker deployments, use `docker compose down` and bring up the previous image tag

### 7.2 Frontend rollback

- In Vercel, promote a previous successful deployment from the deployment history
- Revert environment variable changes if the rollback requires the prior configuration

### 7.3 Contract rollback

Smart contracts on Stellar are immutable. If a contract bug is discovered in production:

- Deploy a new contract version with a patched ABI
- Record the new version in the registry (`wasm_hash`, `abi_version`, `init_dependencies`) and prove compatibility on staging first
- Update `PROPERTY_LISTING_CONTRACT_ID`, `BOOKING_CONTRACT_ID`, and `REVIEW_CONTRACT_ID` in the backend
- Verify cross-contract calls and initialization again

If contract addresses are updated, also update any frontend endpoints or settings that rely on them.

### 7.4 Database rollback

- Restore the latest clean backup using Supabase restore tools or PostgreSQL restore commands
- Use manual rollback SQL carefully if you understand schema dependencies
- If using `setup.sql`, restore the DB state from a backup rather than re-running DDL on live data

---

## 7.5 Release State Machine

Define a release state machine to track deployment and rollback states:

```
IDLE
  ↓ (deploy initiated)
DEPLOYING
  ↓ (deploy complete)
CANARY (optional 5% traffic)
  ↓ (gates pass)
STABLE (100% traffic)
  ↓ (rollback triggered)
ROLLING_BACK
  ↓ (rollback complete)
ROLLED_BACK
```

**State Transitions:**
- `IDLE → DEPLOYING`: Deployment initiated, health checks armed
- `DEPLOYING → CANARY`: Version deployed, canary traffic (5%) routed to new version
- `CANARY → STABLE`: Health gates pass for 15 min, traffic ramped to 100%
- `STABLE → ROLLING_BACK`: Manual rollback triggered or health gate failure
- `ROLLING_BACK → ROLLED_BACK`: Previous version restored, traffic restored

**State Storage:**
- Record current release state in a `releases` table or external system (e.g., Datadog, LaunchDarkly)
- Include fields: `version`, `state`, `timestamp`, `error_count`, `latency_p99`, `transaction_failure_rate`

---

## 7.6 Rollback Health Gates

Automated health gates determine if a rollout should pause or roll back.

The thresholds below are also kept in machine-readable form in [`docs/releases/health-gates.json`](docs/releases/health-gates.json). `scripts/release-health-gate.ts` evaluates a metrics snapshot against that file and exits `0` (proceed), `10` (pause), or `20` (rollback). If this section and the JSON file disagree, the JSON file is authoritative. Ownership of pause and rollback decisions, and the irreversible operations that limit rollback, are in [`docs/releases/rollback.md`](docs/releases/rollback.md).

### 7.6.1 Error Rate Gate

- **Threshold:** Error rate (5xx responses) exceeds 5% for 2 consecutive 1-minute windows
- **Action:** Pause canary traffic increase; alert ops; proceed to manual review
- **Recovery:** If error rate drops below 2% for 5 minutes, resume rollout

### 7.6.2 Latency Gate

- **Threshold:** Request latency (p99) exceeds 1000ms for 2 consecutive 1-minute windows
- **Action:** Pause canary traffic increase; alert ops
- **Recovery:** If p99 latency drops below 500ms for 5 minutes, resume rollout

### 7.6.3 Transaction Failure Rate Gate

- **Threshold:** Booking or payment transaction failures exceed 2% for 2 consecutive 1-minute windows
- **Action:** Immediate rollback; alert ops and finance team
- **Recovery:** None; manual investigation required before re-deploy

### 7.6.4 Database Connection Pool Gate

- **Threshold:** Connection pool usage exceeds 90% of max connections for 1 minute
- **Action:** Pause canary; alert ops
- **Recovery:** If usage drops below 70% for 5 minutes, resume rollout

### 7.6.5 Cache (Redis) Eviction Gate

- **Threshold:** Redis eviction rate exceeds 10 evictions/sec for 1 minute
- **Action:** Pause canary; alert ops
- **Recovery:** If eviction rate drops below 1 eviction/sec for 5 minutes, resume rollout

### 7.6.6 Stellar Contract Invocation Gate

- **Threshold:** Contract invocation failure rate exceeds 1% for 2 consecutive 1-minute windows
- **Action:** Immediate rollback; alert ops
- **Recovery:** Manual review of contract ABI and cross-contract calls before re-deploy

### Health Gate Implementation

```yaml
# Example health gate configuration (pseudocode)
health_gates:
  - name: error_rate
    metric: http_5xx_count / http_total_count
    threshold: 0.05
    window: 1m
    consecutive_windows: 2
    action: pause_rollout
    
  - name: latency_p99
    metric: request_latency_p99
    threshold: 1000ms
    window: 1m
    consecutive_windows: 2
    action: pause_rollout
    
  - name: transaction_failure
    metric: transaction_failures / total_transactions
    threshold: 0.02
    window: 1m
    consecutive_windows: 2
    action: rollback  # immediate, no pause
    
  - name: db_pool_usage
    metric: active_connections / max_connections
    threshold: 0.90
    window: 1m
    consecutive_windows: 1
    action: pause_rollout
    
  - name: redis_eviction
    metric: evictions_per_second
    threshold: 10
    window: 1m
    consecutive_windows: 1
    action: pause_rollout
    
  - name: contract_invocation
    metric: contract_failures / contract_invocations
    threshold: 0.01
    window: 1m
    consecutive_windows: 2
    action: rollback  # immediate
```

---

## 7.7 Schema Compatibility Rules

Ensure backward and forward compatibility during rollouts:

### Backward Compatibility (Old → New)

- **Add columns:** Always add with `DEFAULT` value; never make `NOT NULL` without back-fill
- **Remove columns:** Deprecate first; never remove in same release
- **Rename columns:** Create new column, migrate data, deprecate old, remove in next release
- **Rename tables:** Create new table, populate, deprecate old, remove in next release
- **Data type changes:** Create new column with new type, migrate data, swap names in next release

### Forward Compatibility (New → Old)

- **New features behind feature flags:** Allow easy disablement if rollback needed
- **RLS policy changes:** Test with both old and new policies before removing old
- **Contract ABI changes:** Deploy new contract, update backend to support both ABIs, remove old ABI in next release

### Schema Compatibility Testing

```sql
-- Test backward compatibility: migrate, then downgrade schema
BEGIN;
-- Run all migrations for new version
SELECT * FROM information_schema.tables WHERE table_schema = 'public';
-- Verify old app can still query
SELECT id, email FROM users LIMIT 1;
ROLLBACK;
```

---

## 7.8 Cache Invalidation During Rollback

Clear application cache to avoid stale data during rollback:

```bash
# Flush Redis cache completely (careful: affects all users)
redis-cli FLUSHDB

# Or: selective cache invalidation by key pattern
redis-cli KEYS "session:*" | xargs redis-cli DEL

# Verify cache is cleared
redis-cli DBSIZE
```

**Cache invalidation strategy:**
- On rollback, flush or invalidate all feature-flag and configuration caches
- Do NOT flush user session caches (preserves login state)
- Restart backend services after cache flush to clear in-memory caches

---

## 7.9 Rollback Runbook

### Quick Rollback (Backend)

```bash
# 1. Identify current release
CURRENT_VERSION=$(curl https://api.rentars.app/version | jq -r '.version')
PREVIOUS_VERSION=$(git describe --tags --abbrev=0 --exclude="$CURRENT_VERSION")

# 2. Check health gate status
curl https://ops.rentars.app/health-gates | jq '.status'

# 3. Trigger manual rollback (requires 2 approvers for prod)
curl -X POST https://ops.rentars.app/rollback \
  -H "Authorization: Bearer $ROLLBACK_TOKEN" \
  -d '{"target_version": "'$PREVIOUS_VERSION'", "reason": "health gate failure"}'

# 4. Monitor rollback progress
watch -n 5 'curl https://api.rentars.app/health | jq .'

# 5. Verify functionality
curl https://api.rentars.app/health -v
curl https://api.rentars.app/properties?limit=1

# 6. Clear cache
redis-cli -h $REDIS_HOST FLUSHDB

# 7. Document incident
# Create an incident report and notify team
```

### Rollback with Database Migration

```bash
# 1. Identify last good database state
BACKUP_ID=$(psql -h $DB_HOST -U $DB_USER -d rentars \
  -t -c "SELECT backup_id FROM backups ORDER BY created_at DESC LIMIT 2;" | tail -1)

# 2. Test restore in isolated DB
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER \
  -c "CREATE DATABASE rentars_rollback_test;"

# 3. Restore backup
pg_restore -h $VERIFY_DB_HOST -U $VERIFY_DB_USER \
  -d rentars_rollback_test backup_${BACKUP_ID}.dump

# 4. Verify schema and data
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_rollback_test \
  -c "SELECT version FROM schema_versions ORDER BY applied_at DESC LIMIT 1;"

# 5. Switch primary database (requires downtime)
# Backup current prod DB first
pg_dump -h $DB_HOST -U $DB_USER rentars > backup_prerollback_$(date +%s).dump

# Restore from backup
pg_restore -h $DB_HOST -U $DB_USER -d rentars backup_${BACKUP_ID}.dump

# 6. Cleanup test DB
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -c "DROP DATABASE rentars_rollback_test;"

# 7. Restart backend services
docker compose restart rentars-backend
```

### Rollback Stellar Contracts

```bash
# 1. Identify previous contract versions
stellar contract list --account $ADMIN_ACCOUNT --network mainnet

# 2. Update backend environment variables
# PROPERTY_LISTING_CONTRACT_ID=<previous_contract_id>
# BOOKING_CONTRACT_ID=<previous_contract_id>
# REVIEW_CONTRACT_ID=<previous_contract_id>

# 3. Restart backend to pick up new contract IDs
docker compose restart rentars-backend

# 4. Test contract interactions
curl -X POST https://api.rentars.app/bookings \
  -H "Content-Type: application/json" \
  -d '{"property_id": "test", "check_in": "2024-01-01"}'

# 5. Monitor for errors
curl https://api.rentars.app/contract-invocations?limit=10 | jq '.failures'
```

### Rollback Approvals

- **Rollback trigger:** Senior ops engineer or on-call engineering manager
- **Approval 1:** CTO or infrastructure lead
- **Approval 2:** Product lead or engineering manager
- **Documentation:** Incident post-mortem required within 24 hours

**Commands NEVER expose signing secrets:**

```bash
# ✗ WRONG: Never pass secrets via CLI args or env
psql -h $DB_HOST -U $DB_USER -p $DB_PASSWORD  # EXPOSED

# ✓ RIGHT: Use .pgpass or PGPASSWORD in secure manner
export PGPASSWORD="$DB_PASSWORD"  # Set only for command
psql -h $DB_HOST -U $DB_USER
unset PGPASSWORD

# ✓ RIGHT: Use AWS Secrets Manager or HashiCorp Vault
aws secretsmanager get-secret-value --secret-id prod/db/password | jq -r '.SecretString'
```

---

## 8. Monitoring and Alerting

### 8.1 Release State Tracking

Operators must be able to identify the active release at any time:

```bash
# Check currently deployed version
curl https://api.rentars.app/version | jq '.'
# Response: { "version": "v1.2.3", "deployed_at": "2024-01-15T10:30:00Z", "commit": "abc123..." }

# Check active migration version
psql -h $DB_HOST -U $DB_USER -d rentars \
  -c "SELECT migration_version FROM schema_versions ORDER BY applied_at DESC LIMIT 1;"

# Check active contract IDs, WASM hashes, and ABI versions
curl https://api.rentars.app/version/contracts | jq '.contracts[] | {name, network, contract_id, wasm_hash, abi_version, compatible}'

# Check the active network reported by the backend
curl https://api.rentars.app/health/deep | jq '.dependencies.stellar.network'

# Check cache version
redis-cli INFO replication | grep role
redis-cli GET "config:cache_version"
```

### 8.2 Release Health Gates Monitoring

Monitor the health gates in real-time:

```bash
# Check all active health gates
curl https://ops.rentars.app/health-gates | jq '.'

# Check specific gate status
curl https://ops.rentars.app/health-gates/error_rate | jq '.{status, current_value, threshold}'

# Get rollback decision history
curl https://ops.rentars.app/rollback-decisions | jq '.[] | {timestamp, gate, decision, reason}' | head -20
```

**Expected response format:**
```json
{
  "status": "green",
  "release_state": "STABLE",
  "gates": [
    {
      "name": "error_rate",
      "status": "pass",
      "current_value": "0.002",
      "threshold": "0.05",
      "window": "1m",
      "last_check": "2024-01-15T10:35:12Z"
    },
    {
      "name": "latency_p99",
      "status": "pass",
      "current_value": "425ms",
      "threshold": "1000ms",
      "window": "1m",
      "last_check": "2024-01-15T10:35:12Z"
    }
  ]
}
```

### 8.3 Health checks

Expose and monitor the backend health endpoint:

- `GET /health` — returns service health and version info
- `GET /health/deep` — includes database, Redis, contract connectivity checks
- `GET /health-gates` — returns current status of all rollout health gates

For Docker or hosted environments, configure uptime checks and automatic restarts if health checks fail.

**Health check response format:**
```json
{
  "status": "ok",
  "version": "v1.2.3",
  "uptime_seconds": 3600,
  "dependencies": {
    "database": "connected",
    "redis": "connected",
    "stellar": "connected"
  }
}
```

### 8.4 Logging and error monitoring

- Send backend logs to a centralized provider (e.g. Datadog, Logflare, Papertrail)
- Alert on repeated 5xx API errors and contract invocation failures
- Monitor Redis errors and connection failures
- Monitor Supabase database errors and slow queries

### 8.5 Metrics to monitor

**Health Gate Metrics (Rollout Monitoring):**
- HTTP 5xx error rate (target: < 5% for 2 consecutive 1-minute windows)
- Request latency p99 (target: < 1000ms)
- Transaction failure rate (target: < 2% for critical operations)
- Database connection pool usage (target: < 90%)
- Redis eviction rate (target: < 10 evictions/sec)
- Stellar contract invocation success rate (target: > 99%)

**System Metrics:**
- API request rate and error rate
- Backend latency (p50, p95, p99)
- Redis memory usage and connection counts
- Database connection pool usage and query performance
- Stellar transaction failure rate
- Contract invocation latency

### 8.6 Alerting

Set alerts for health gates:

- Error rate exceeds 5% (pause rollout)
- Latency p99 exceeds 1000ms (pause rollout)
- Transaction failure rate exceeds 2% (immediate rollback)
- Database pool usage exceeds 90% (pause rollout)
- Redis eviction rate exceeds 10 evictions/sec (pause rollout)
- Contract invocation failure rate exceeds 1% (immediate rollback)

**Operational alerts:**
- Backend service down or unhealthy
- `REDIS_URL` or database connectivity errors
- Spike in API 500 responses
- Contract initialization failures
- Unexpected drops in booking or listing traffic
- Rollback triggered (manual notification to on-call)

### 8.7 Platform-specific monitoring

- Vercel: use deployment notifications and uptime checks
- Supabase: use database metrics, query performance charts, and alerts
- Redis provider: configure memory, CPU, and eviction alerts

---

## 9. Validation Steps

To confirm deployments are production-ready, verify:

1. ✅ `DEPLOYMENT.md` documents testnet setup, backend deployment, frontend deployment, and mainnet checklist
2. ✅ Release state machine (IDLE → DEPLOYING → CANARY → STABLE → ROLLED_BACK) defined
3. ✅ Health gates configured with error rate, latency, transaction failure, and infrastructure thresholds
4. ✅ Schema compatibility rules documented for add/remove/rename operations
5. ✅ Cache invalidation procedure defined for rollback scenarios
6. ✅ Rollback runbook includes backend, database, and contract rollback steps
7. ✅ All operators can identify: current version, active migration, contract IDs, WASM hashes, ABI versions, and cache version
8. ✅ Staging rollback drill completed and documented in CI/CD pipeline
9. ✅ Health gates monitoring configured in observability platform
10. ✅ Rollback approval process requires 2 approvers for production
11. ✅ No commands expose signing secrets in logs or CLI arguments
12. ✅ Contract version registry validated at startup; unknown or incompatible contract configuration blocks critical traffic
13. ✅ Wallet/backend network mismatches are rejected before signing or submission with an actionable message
14. ✅ Production cannot silently default to testnet; missing network configuration fails fast
15. ✅ Staging upgrade proves contract/ABI compatibility before production rollout

If all checks are satisfied, deployment automation is production-ready.
