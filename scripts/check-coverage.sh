#!/usr/bin/env bash
# scripts/check-coverage.sh — Per-file coverage threshold enforcement (S8)
#
# Parses `bun test --coverage` output and verifies that every source file
# has at least THRESHOLD% line coverage. Excludes barrels, .d.ts, and
# files < 10 lines. Maintains an allowlist for known under-covered files.
#
# Usage: bash scripts/check-coverage.sh [coverage_output_file]
#   If no file is provided, runs bun test --coverage to generate output.
#
# Exit codes:
#   0 — All files meet the threshold (or are allowlisted)
#   1 — One or more files below threshold and not allowlisted
#   2 — Coverage output could not be parsed (format change?)

set -euo pipefail

THRESHOLD=30  # Minimum % Lines coverage per file

# ── Allowlist: files currently below threshold ──────────────────
# Each entry is a filename (as shown in bun coverage output, e.g. "src/foo.ts").
# These are tracked for improvement — remove entries as coverage increases.
# Justification: legacy modules predating coverage requirement, or modules
# requiring Telegram/Supabase integration that are hard to unit test.
ALLOWLIST=(
  # Agent execution: requires Claude CLI spawning, not unit-testable
  "src/agent.ts"
  # Command composers: thin wrappers requiring full bot context to test
  "src/commands/documents.ts"
  "src/commands/exploration.ts"
  "src/commands/help.ts"
  "src/commands/jobs.ts"
  "src/commands/maturation.ts"
  "src/commands/memory-cmds.ts"
  "src/commands/profile.ts"
  "src/commands/project.ts"
  "src/commands/quality.ts"
  "src/commands/tasks.ts"
  "src/commands/utilities.ts"
  # src/commands/zz-messages.ts — removed: now has 34%+ coverage via zz-messages-handlers.test.ts
  # Infrastructure: requires Telegram bot context or external services
  "src/document-sharding.ts"
  "src/heartbeat.ts"
  "src/relay.ts"
  "src/transcribe.ts"
  "src/tts.ts"
  # Memory sub-module: agent-specific memory, low test coverage
  "src/memory/agent-memory.ts"
)

# ── Barrel files (re-exports only, no logic to cover) ──────────
BARRELS=(
  "src/memory.ts"
)

# ── Helper: check if value is in array ─────────────────────────
in_array() {
  local needle="$1"; shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

# ── Get coverage output ───────────────────────────────────────
if [[ "${1:-}" != "" ]] && [[ -f "$1" ]]; then
  COVERAGE_OUTPUT=$(cat "$1")
else
  echo "Running bun test --coverage..."
  COVERAGE_OUTPUT=$(bun test --coverage tests/unit tests/integration 2>&1) || true
fi

# ── Parse coverage table ──────────────────────────────────────
# Expected format:
#  src/file.ts    |   94.12 |   87.91 | 86-96
# We extract: filename, % Lines (column 3)

FAILURES=()
CHECKED=0
SKIPPED=0

while IFS= read -r line; do
  # Skip header, separator, and summary lines
  [[ "$line" =~ ^[[:space:]]*File ]] && continue
  [[ "$line" =~ ^[-|]+ ]] && continue
  [[ "$line" =~ All\ files ]] && continue
  [[ -z "$line" ]] && continue

  # Only process lines that look like coverage data (contain |)
  [[ "$line" != *"|"* ]] && continue

  # Extract filename and % Lines
  filename=$(echo "$line" | awk -F'|' '{ gsub(/^[ \t]+|[ \t]+$/, "", $1); print $1 }')
  pct_lines=$(echo "$line" | awk -F'|' '{ gsub(/[ %]/, "", $3); print $3 }')

  # Skip non-src files (test fixtures, etc.)
  [[ "$filename" != src/* ]] && continue

  # Skip .d.ts files
  [[ "$filename" == *.d.ts ]] && continue

  # Skip barrel files
  if in_array "$filename" "${BARRELS[@]}"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Skip if % Lines is empty or not a number
  if [[ -z "$pct_lines" ]] || ! [[ "$pct_lines" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    continue
  fi

  CHECKED=$((CHECKED + 1))

  # Check threshold (using awk instead of bc for portability)
  below=$(awk "BEGIN { print ($pct_lines < $THRESHOLD) ? 1 : 0 }")
  if [[ "$below" == "1" ]]; then
    # Check allowlist
    if in_array "$filename" "${ALLOWLIST[@]}"; then
      echo "  ALLOWLISTED: $filename ($pct_lines% < $THRESHOLD%)"
    else
      FAILURES+=("$filename ($pct_lines% < $THRESHOLD%)")
    fi
  fi
done <<< "$COVERAGE_OUTPUT"

# ── Report ────────────────────────────────────────────────────

echo ""
echo "Per-file coverage check (S8): threshold=$THRESHOLD%"
echo "  Files checked: $CHECKED"
echo "  Files skipped (barrels/non-src): $SKIPPED"

if [[ "$CHECKED" -eq 0 ]]; then
  echo ""
  echo "WARNING: No source files found in coverage output."
  echo "This may indicate a change in bun's coverage output format."
  echo "Coverage output sample:"
  echo "$COVERAGE_OUTPUT" | head -20
  exit 2
fi

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "  Result: ALL PASS"
  exit 0
else
  echo ""
  echo "FAILURES (${#FAILURES[@]} files below ${THRESHOLD}% line coverage):"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  echo ""
  echo "To fix: add tests for these files, or add them to the ALLOWLIST in scripts/check-coverage.sh"
  echo "with a justification comment."
  exit 1
fi
