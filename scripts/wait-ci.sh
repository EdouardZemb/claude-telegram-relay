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

  OUTPUT=$(gh pr checks "$BRANCH" -R "$REPO" --json name,state,conclusion 2>/dev/null || echo "")

  if [ -z "$OUTPUT" ] || [ "$OUTPUT" = "[]" ]; then
    echo "  Checks not yet available... (${ELAPSED}s)"
    sleep "$POLL"
    continue
  fi

  PENDING=$(echo "$OUTPUT" | jq '[.[] | select(.state != "COMPLETED" and .state != "completed")] | length')
  if [ "$PENDING" -gt 0 ]; then
    echo "  $PENDING check(s) still running... (${ELAPSED}s)"
    sleep "$POLL"
    continue
  fi

  FAILED=$(echo "$OUTPUT" | jq '[.[] | select(.conclusion != "SUCCESS" and .conclusion != "success" and .conclusion != "NEUTRAL" and .conclusion != "neutral")] | length')
  if [ "$FAILED" -gt 0 ]; then
    echo "CI FAILED:"
    echo "$OUTPUT" | jq -r '.[] | select(.conclusion != "SUCCESS" and .conclusion != "success" and .conclusion != "NEUTRAL" and .conclusion != "neutral") | "  \(.name): \(.conclusion)"'
    exit 1
  fi

  echo "CI PASSED (${ELAPSED}s)"
  exit 0
done
