#!/usr/bin/env bash
# Fails if ABI files, the contract version registry, or migration SQL files
# changed in this PR/push but CHANGELOG.md does not contain a new entry
# mentioning the change type.
#
# Rationale: contract ABI and database schema changes can break deployed
# clients or require coordinated rollout.  This gate ensures every such
# change is explicitly acknowledged in the changelog so release reviewers
# can reason about compatibility.
#
# Additionally, every ABI version recorded in the contract version registry
# must be documented in CHANGELOG.md; a release is blocked when a deployed
# ABI version has no corresponding changelog entry.
#
# CI usage (inside release-validation job):
#   bash scripts/check-abi-migration-changelog.sh
#
# Local usage:
#   BASE_SHA=origin/main bash scripts/check-abi-migration-changelog.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Resolve base commit ───────────────────────────────────────────────────────
# In a GitHub Actions pull_request event, GITHUB_BASE_REF is the target branch.
# On push to main/master/develop, diff against the previous commit.
if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  BASE_SHA=$(git merge-base HEAD "origin/${GITHUB_BASE_REF}" 2>/dev/null || git rev-parse HEAD~1)
elif [[ -n "${BASE_SHA:-}" ]]; then
  BASE_SHA="${BASE_SHA}"
else
  BASE_SHA=$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)
fi

echo "Comparing against base: $BASE_SHA"

# ── Detect ABI file changes ───────────────────────────────────────────────────
ABI_CHANGES=$(git diff --name-only "$BASE_SHA" HEAD -- 'apps/contracts/*.json' 2>/dev/null || true)

# ── Detect contract version registry changes ─────────────────────────────────
# The registry records contract ID, network, WASM hash, ABI version and
# initialization dependencies.  Any change to it is an ABI/version change.
REGISTRY_CHANGES=$(git diff --name-only "$BASE_SHA" HEAD -- \
  'apps/contracts/version-registry*.json' \
  'apps/contracts/versions/*.json' \
  'apps/contracts/contract-versions.json' 2>/dev/null || true)

# ── Detect new migration files ────────────────────────────────────────────────
MIGRATION_CHANGES=$(git diff --name-only "$BASE_SHA" HEAD -- 'apps/backend/database/migrations/*.sql' 2>/dev/null || true)

if [[ -z "$ABI_CHANGES" && -z "$REGISTRY_CHANGES" && -z "$MIGRATION_CHANGES" ]]; then
  echo -e "${GREEN}No ABI, version registry, or migration changes detected — no changelog check required.${NC}"
  exit 0
fi

echo ""
if [[ -n "$ABI_CHANGES" ]]; then
  echo -e "${YELLOW}ABI files changed:${NC}"
  echo "$ABI_CHANGES" | sed 's/^/  /'
fi
if [[ -n "$REGISTRY_CHANGES" ]]; then
  echo -e "${YELLOW}Contract version registry changed:${NC}"
  echo "$REGISTRY_CHANGES" | sed 's/^/  /'
fi
if [[ -n "$MIGRATION_CHANGES" ]]; then
  echo -e "${YELLOW}Migration files changed:${NC}"
  echo "$MIGRATION_CHANGES" | sed 's/^/  /'
fi
echo ""

# ── Verify CHANGELOG has a new entry in [Unreleased] ─────────────────────────
CHANGELOG_DIFF=$(git diff "$BASE_SHA" HEAD -- CHANGELOG.md 2>/dev/null || true)

if [[ -z "$CHANGELOG_DIFF" ]]; then
  echo -e "${RED}✗ ABI, version registry, or migration files changed but CHANGELOG.md was not updated.${NC}" >&2
  echo "" >&2
  echo "  Add an entry under ## [Unreleased] describing the ABI or schema change." >&2
  echo "  See docs/releases/compatibility.md for required content." >&2
  exit 1
fi

# Check that the diff adds (not only removes) lines in the [Unreleased] section
ADDED_UNRELEASED=$(echo "$CHANGELOG_DIFF" | grep '^+' | grep -v '^+++' | head -1 || true)
if [[ -z "$ADDED_UNRELEASED" ]]; then
  echo -e "${RED}✗ CHANGELOG.md changed but no new lines were added.${NC}" >&2
  echo "  The [Unreleased] section must contain a new entry for this ABI/migration change." >&2
  exit 1
fi

# ── Verify every registry ABI version is documented in CHANGELOG ─────────────
# Collect ABI versions declared in the version registry.  Each version must
# appear in CHANGELOG.md so operators can trace a deployed ABI back to a
# documented release.  Missing documentation blocks the release.
REGISTRY_FILES=$(ls apps/contracts/version-registry*.json \
  apps/contracts/versions/*.json \
  apps/contracts/contract-versions.json 2>/dev/null || true)

if [[ -n "$REGISTRY_FILES" ]]; then
  UNDOCUMENTED=()
  while IFS= read -r version; do
    [[ -z "$version" ]] && continue
    if ! grep -qF "$version" CHANGELOG.md; then
      UNDOCUMENTED+=("$version")
    fi
  done < <(grep -hoE '"abiVersion"[[:space:]]*:[[:space:]]*"[^"]+"' $REGISTRY_FILES 2>/dev/null \
    | sed -E 's/.*"abiVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | sort -u || true)

  if [[ ${#UNDOCUMENTED[@]} -gt 0 ]]; then
    echo -e "${RED}✗ Contract ABI version(s) missing from CHANGELOG.md:${NC}" >&2
    for v in "${UNDOCUMENTED[@]}"; do
      echo "  - ABI version $v" >&2
    done
    echo "" >&2
    echo "  Document each deployed ABI version in CHANGELOG.md before releasing." >&2
    echo "  See docs/releases/compatibility.md for migration sequencing." >&2
    exit 1
  fi
fi

echo -e "${GREEN}✓ CHANGELOG.md updated to cover ABI/version/migration changes.${NC}"
