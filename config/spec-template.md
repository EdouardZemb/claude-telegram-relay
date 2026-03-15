# SDD Spec — [Sprint] [Title]

## Overview

Brief description of what this sprint delivers and why.

## User Stories

US-001: As a [role], I want [action] so that [benefit].
US-002: ...

## Functional Requirements

FR-001: [Requirement description]
  Acceptance Criteria:
  - AC-001: GIVEN [context] WHEN [action] THEN [expected result]
  - AC-002: ...

FR-002: [Requirement description]
  Acceptance Criteria:
  - AC-003: ...

## Edge Cases

EC-001: [Edge case description] — Expected behavior: [behavior]
EC-002: ...

## Success Criteria

SC-001: [Measurable criterion, e.g. "All 508+ tests pass"]
SC-002: [e.g. "Migration applies cleanly on Supabase"]
SC-003: [e.g. "Command responds correctly on Telegram"]

## Out of Scope

- [Explicitly excluded items]

## Dependencies

- [External dependencies, e.g. "S22 structured message passing"]

## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [ ] AC-001: [test description]
- [ ] AC-002: ...
- [ ] EC-001: [test description]

Integration Tests:
- [ ] SC-002: [live DB verification]
- [ ] SC-003: [Telegram command verification]

Acceptance Tests:
- [ ] FR-001: All AC satisfied
- [ ] FR-002: All AC satisfied

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
