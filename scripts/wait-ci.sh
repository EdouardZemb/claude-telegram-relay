#!/bin/bash
# Wait for CI checks to pass on a PR branch.
# Usage: ./scripts/wait-ci.sh [branch-name]
# If no branch given, uses current branch.

set -euo pipefail

BRANCH="${1:-$(git branch --show-current)}"
REPO="EdouardZemb/claude-telegram-relay"
MAX_WAIT=600  # 10 minutes
POLL=15       # seconds

echo "Waiting for CI on branch: $BRANCH"

START=$(date +%s)
while true; do
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "TIMEOUT: CI did not complete within ${MAX_WAIT}s"
    exit 1
  fi

  # Use gh pr checks with --watch to wait for completion (timeout 10min)
  # Fallback: poll with plain text output if --watch unavailable
  OUTPUT=$(gh pr checks "$BRANCH" -R "$REPO" 2>/dev/null || echo "")

  if [ -z "$OUTPUT" ] || echo "$OUTPUT" | grep -q "no checks"; then
    echo "  Checks not yet available... (${ELAPSED}s)"
    sleep "$POLL"
    continue
  fi

  # Check for pending/in_progress checks
  if echo "$OUTPUT" | grep -qiE "pending|in_progress|queued|running"; then
    PENDING=$(echo "$OUTPUT" | grep -ciE "pending|in_progress|queued|running" || echo "0")
    echo "  $PENDING check(s) still running... (${ELAPSED}s)"
    sleep "$POLL"
    continue
  fi

  # All checks completed — check for failures
  if echo "$OUTPUT" | grep -qi "fail"; then
    echo "CI FAILED:"
    echo "$OUTPUT" | grep -i "fail"
    exit 1
  fi

  echo "CI PASSED (${ELAPSED}s)"
  echo "$OUTPUT"
  exit 0
done
