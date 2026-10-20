# Compatibility Requirements for ABI and Schema Changes

## Why this matters

Rentars deploys three independently versioned components:

- **Backend** (`apps/backend`) — Express API, Bun runtime
- **Frontend** (`apps/web`) — Next.js, Yarn
- **Contracts** (`apps/contracts`) — Soroban/Stellar WASM, immutable after deployment

A database migration or contract ABI change can silently break a deployed client
or block a rollback.  Every such change therefore requires explicit release notes
and passing compatibility checks before merging.

## What triggers the check

The `check-abi-migration-changelog.sh` CI script fails a PR if any of the
following files change without a corresponding CHANGELOG.md update:

| Changed files | Category |
|---|---|
| `apps/contracts/*.json` | Contract ABI |
| `apps/backend/database/migrations/*.sql` | Database schema |

## What to write in the changelog

Add an entry under `## [Unreleased]` with at least one of these headings:

### Additive changes (backwards-compatible)

These are safe to deploy without coordination.  Label them under `### Added`.

```markdown
### Added
- Migration 00025: add `cancelled_at` column to `bookings` (nullable, defaults
  to NULL for existing rows — backwards compatible with the deployed backend).
```

### Breaking changes (require coordinated rollout)

Label them under `### Changed` or `### Removed` and include:

1. **What changed** — the field, table, or contract entrypoint affected.
2. **Incompatible client versions** — which deployed version of backend/web/contract
   is no longer compatible after this change.
3. **Rollout order** — which component must be deployed first.
4. **Rollback boundary** — whether rolling back crosses this migration boundary
   (if so, a data migration or contract re-deploy may be required).

```markdown
### Changed
- Contract ABI: `create_booking` entrypoint now requires `escrow_agent` parameter.
  Incompatible with backend < 1.4.0.  Deploy backend 1.4.0 before this contract.
  Rolling back the contract is not possible post-deploy; rollback requires
  re-deploying the prior WASM from the release manifest.
```

## Release manifest

Every release generates `docs/releases/manifest-<version>.json` via:

```bash
bun run release:manifest --version X.Y.Z
```

The manifest records:
- `release.commit` — exact git SHA
- `database.latest_migration` — last applied migration filename
- `contracts.abi_sha256` — SHA-256 of each ABI file at release time
- `components.*` — per-component version

Use these fields during rollback to identify a compatible set.  See
`docs/releases/rollback.md` for the full procedure.

## Version registry

The release manifest is not the only source of truth.  A version registry
(`apps/contracts/version-registry.json`, generated during build and deployment)
records, for every network, the deployed contract identity:

| Field | Description |
|---|---|
| `network` | `testnet`, `futurenet`, or `mainnet` |
| `contract_id` | Stellar contract address (`C...`) |
| `wasm_hash` | SHA-256 of the deployed WASM blob |
| `abi_version` | Semver of the ABI the contract exposes |
| `init_dependencies` | Contracts/state that must be initialized before this one |
| `compatible_releases` | Backend/frontend release ranges known to work with this entry |

Example entry:

```json
{
  "network": "testnet",
  "contract_id": "CABC...XYZ",
  "wasm_hash": "9f2c...e41d",
  "abi_version": "1.4.0",
  "init_dependencies": ["token:CXYZ...123"],
  "compatible_releases": {
    "backend": ">=1.4.0 <2.0.0",
    "web": ">=1.4.0 <2.0.0"
  }
}
```

At startup the backend and web apps validate the configured contract ID
against the registry for their target network.  An unknown contract ID, a
missing registry entry, or an ABI version outside the app's supported range
fails fast before serving critical traffic.  A non-sensitive health endpoint
(`GET /health/version`) exposes the resolved `contract_id`, `wasm_hash`,
`abi_version`, and compatibility status for operators.

## Compatibility matrix

Each release documents the exact set of components it was validated against.
The matrix below is illustrative; the authoritative values live in the
version registry and the generated release manifest.

| App release | Network | Contract ID | ABI version | WASM hash (short) | Notes |
|---|---|---|---|---|---|
| 1.3.x | mainnet | `CABC...XYZ` | 1.3.0 | `9f2c...e41d` | Pre-`escrow_agent` ABI |
| 1.4.x | mainnet | `CDEF...UVW` | 1.4.0 | `7a10...b3c9` | Requires `escrow_agent` param |
| 1.4.x | testnet | `CTST...TST` | 1.4.0 | `7a10...b3c9` | Staging validation target |

Rules:

- A backend/frontend release may only target contract entries whose
  `abi_version` falls inside its `compatible_releases` range.
- A contract entry may only be promoted to `mainnet` after the same
  `wasm_hash` and `abi_version` have been exercised on `testnet` by the
  candidate app release.
- `init_dependencies` must be deployed and initialized before the dependent
  contract; the registry records the ordering.

## Migration sequencing for upgrades

Upgrades follow a fixed order so that no component ever talks to an
incompatible peer:

1. **Stage on testnet.** Deploy the new WASM to `testnet`, record its
   `wasm_hash` and `abi_version` in the registry, and run the candidate
   backend/web against it.  Confirm `GET /health/version` reports a
   compatible status.
2. **Prove compatibility.** Run the staging upgrade test suite against the
   testnet entry.  A staging upgrade must pass before any production rollout.
3. **Deploy additive backend changes.** Ship backwards-compatible backend
   migrations and code that can read both old and new ABI shapes.
4. **Promote the contract.** Deploy the new WASM to `mainnet`, update the
   registry entry, and verify the reported `wasm_hash` matches the manifest.
5. **Deploy dependent clients.** Roll out backend/frontend releases whose
   `compatible_releases` range includes the new `abi_version`.
6. **Retire the old entry.** Mark the previous registry entry as superseded
   only after all clients have moved to the new range.

Rolling back across a contract boundary requires re-deploying the prior WASM
from the release manifest and restoring the matching registry entry; see
`docs/releases/rollback.md`.

## Suppressing the check

If the ABI or migration change is already covered by a prior changelog entry
(e.g., a stacked PR), set the `BASE_SHA` environment variable to the commit
that already includes the changelog update:

```bash
BASE_SHA=<prior-commit> bash scripts/check-abi-migration-changelog.sh
```

Do not bypass the check with `git commit --no-verify`.
