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

  OUTPUT=$(gh pr checks "$BRANCH" -R "$REPO" --json name,state,bucket 2>/dev/null || echo "")

  if [ -z "$OUTPUT" ] || [ "$OUTPUT" = "[]" ]; then
    echo "  Checks not yet available... (${ELAPSED}s)"
    sleep "$POLL"
    continue
  fi

  PENDING=$(echo "$OUTPUT" | jq '[.[] | select(.state != "COMPLETED" and .state != "completed" and .state != "SUCCESS" and .state != "FAILURE")] | length')
  if [ "$PENDING" -gt 0 ]; then
    echo "  $PENDING check(s) still running... (${ELAPSED}s)"
    sleep "$POLL"
    continue
  fi

  FAILED=$(echo "$OUTPUT" | jq '[.[] | select(.bucket == "fail")] | length')
  if [ "$FAILED" -gt 0 ]; then
    echo "CI FAILED:"
    echo "$OUTPUT" | jq -r '.[] | select(.bucket == "fail") | "  \(.name): \(.state)"'
    exit 1
  fi

  echo "CI PASSED (${ELAPSED}s)"
  exit 0
done
