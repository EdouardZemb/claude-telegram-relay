# SDD Spec — S26 Smart Notifications

## Overview

Transformer le systeme de notifications fire-and-forget en un systeme intelligent avec batching, quiet hours et boutons inline. Aujourd'hui, chaque evenement (PR, tache, idee, alerte) envoie un message Telegram immediat sans consideration du contexte utilisateur. S26 introduit une file d'attente qui regroupe les notifications, respecte les heures de silence, et ajoute des boutons d'action rapide sur les notifications proactives.

Objectif: reduire le bruit (moins de messages, plus pertinents) tout en augmentant l'actionabilite (boutons inline pour agir directement depuis Telegram).

Depend de: S25 (parallel execution merge), infrastructure notifications existante (notifications.ts, alerts.ts, alert-cron.ts).


## User Stories

US-001: As a developer receiving notifications at night, I want the bot to hold non-urgent messages until morning so that I'm not disturbed outside work hours.

US-002: As a developer checking Telegram after a break, I want to see a single digest message grouping all recent events instead of 10 individual messages so that I can catch up quickly.

US-003: As a developer receiving a task notification, I want inline buttons (Start, View, Dismiss) so that I can take action directly from the notification without typing a command.

US-004: As a developer, I want to configure my quiet hours and notification preferences so that the bot adapts to my schedule.

US-005: As a developer receiving alerts, I want critical alerts to bypass quiet hours so that truly urgent issues reach me immediately.


## Functional Requirements

FR-001: Notification queue with batching
  Buffer notifications in a queue and flush them as a single digest message after a configurable interval (default 5 minutes) or when batch size reaches a threshold (default 5 messages).
  Acceptance Criteria:
  - AC-001: GIVEN 3 task notifications within 2 minutes WHEN the batch interval (5min) elapses THEN a single digest message is sent containing all 3 notifications
  - AC-002: GIVEN 5 notifications within 1 minute WHEN the batch size threshold (5) is reached THEN the batch is flushed immediately without waiting for the interval
  - AC-003: GIVEN a single notification WHEN no other notifications arrive within the batch interval THEN it is sent as a standalone message (no unnecessary "digest of 1")
  - AC-004: GIVEN a batch flush WHEN the digest is formatted THEN it groups notifications by type (tasks, PRs, ideas, alerts) with counts and timestamps

FR-002: Quiet hours
  Suppress non-critical notifications during configurable quiet periods. Queued messages are delivered at the end of quiet hours as a morning digest.
  Acceptance Criteria:
  - AC-005: GIVEN quiet hours 20h-9h WHEN a non-critical notification arrives at 23h THEN it is queued and not sent
  - AC-006: GIVEN quiet hours ending at 9h WHEN 9h arrives THEN all queued notifications are flushed as a morning digest
  - AC-007: GIVEN a critical alert (severity "critical") WHEN it arrives during quiet hours THEN it is sent immediately, bypassing quiet hours
  - AC-008: GIVEN a user in Europe/Paris WHEN quiet hours are evaluated THEN the timezone from USER_TIMEZONE is used (not UTC)

FR-003: Inline action buttons on notifications
  Add contextual InlineKeyboard buttons to proactive notifications so users can act directly from Telegram.
  Acceptance Criteria:
  - AC-009: GIVEN a task status notification WHEN sent THEN it includes buttons: "Demarrer" (if backlog), "Terminer" (if in_progress), "Voir details"
  - AC-010: GIVEN a PR notification WHEN sent THEN it includes a button "Voir la PR" linking to the PR URL
  - AC-011: GIVEN an idea notification WHEN sent THEN it includes buttons: "Promouvoir en tache", "Archiver"
  - AC-012: GIVEN an alert notification WHEN sent THEN it includes buttons depending on type: "Voir tache" (stuck_task), "Voir sprint" (behind_schedule), "Ignorer" (all)
  - AC-013: GIVEN a user clicks an inline button WHEN the callback is received THEN the action is executed and the button message is updated with the result

FR-004: Notification preferences
  Configurable per-type notification settings: enabled/disabled, batch/immediate, quiet hours override.
  Acceptance Criteria:
  - AC-014: GIVEN the default config WHEN no preferences are set THEN all notification types are enabled with batching ON and quiet hours ON
  - AC-015: GIVEN a /notify command WHEN the user runs "/notify quiet 22h-8h" THEN quiet hours are updated to 22:00-08:00
  - AC-016: GIVEN a /notify command WHEN the user runs "/notify alerts immediate" THEN alert notifications switch to immediate delivery (skip batching)
  - AC-017: GIVEN a /notify command WHEN the user runs "/notify off ideas" THEN idea notifications are disabled entirely
  - AC-018: GIVEN a /notify command WHEN the user runs "/notify status" THEN the current preferences are displayed

FR-005: Digest formatting
  Format batch notifications as a readable digest with structure, counts, and priority ordering.
  Acceptance Criteria:
  - AC-019: GIVEN a digest with mixed types WHEN formatted THEN alerts appear first, then tasks, then PRs, then ideas
  - AC-020: GIVEN a morning digest after quiet hours WHEN formatted THEN it includes a header with the time range covered (e.g. "Resume 20h-9h, 7 notifications")
  - AC-021: GIVEN a digest with >10 notifications WHEN formatted THEN low-priority items are collapsed with a count (e.g. "+ 4 autres notifications")


## Edge Cases

EC-001: Bot restarts during quiet hours with queued notifications — Expected behavior: queue is persisted to filesystem (JSON file), reloaded on restart, no notifications lost.

EC-002: Quiet hours span midnight (e.g., 22h-8h) — Expected behavior: correctly handles cross-midnight ranges using timezone-aware comparison.

EC-003: User sends a command during quiet hours — Expected behavior: command responses are NEVER affected by quiet hours (only proactive notifications are batched).

EC-004: All notifications in a batch are dismissed via inline buttons before flush — Expected behavior: batch is discarded, no empty digest sent.

EC-005: Rapid-fire notifications (>20 in 1 minute, e.g., parallel pipeline) — Expected behavior: batch flushes at threshold (5), sends multiple digests of 5 if needed, no message loss.

EC-006: Notification preference file missing or corrupted — Expected behavior: fall back to defaults (all enabled, batch ON, quiet 20h-9h), log warning.

EC-007: Inline button clicked after message is old (>24h) — Expected behavior: attempt the action, show "Action effectuee" or "Action expiree" if the target no longer exists (e.g., task already done).


## Success Criteria

SC-001: All 611+ existing tests pass (no regression).
SC-002: 25+ new tests covering queue, batching, quiet hours, inline buttons, preferences, digest formatting.
SC-003: Notifications during quiet hours are held and delivered as morning digest.
SC-004: 3+ rapid notifications are batched into a single digest message.
SC-005: Inline buttons on task/PR/idea/alert notifications trigger the correct action.
SC-006: /notify command allows viewing and modifying preferences.
SC-007: Critical alerts bypass quiet hours.
SC-008: Queue survives bot restart (persistence).


## Out of Scope

- Push notification priority levels (Telegram doesn't support granular notification control)
- Per-topic notification routing changes (existing DEV_THREAD_ID/SPRINT_THREAD_ID routing unchanged)
- Notification analytics/dashboard (deferred)
- Multi-user notification preferences (single user system)
- Notification sounds customization (Telegram limitation)
- Database-backed queue (file-based is sufficient for single-user)


## Dependencies

- S25: Parallel execution (merged) — parallel pipelines generate burst notifications
- Existing: notifications.ts, alerts.ts, alert-cron.ts, relay.ts callback handler
- Existing: InlineKeyboard patterns in relay.ts (PRD, gate, retro buttons)
- Bun: fs APIs for queue persistence


## Architecture Decisions

AD-001: File-based queue (not database)
  Notification queue persisted as JSON file (notification-queue.json). For a single-user bot, a database table adds unnecessary complexity. The queue is small (<100 entries max) and rarely read. On flush, file is cleared.

AD-002: Batch timer + threshold dual trigger
  Batch flushes on whichever comes first: interval (5min default) or count (5 messages default). This prevents both delayed single messages and overwhelming bursts.

AD-003: Quiet hours as time ranges with critical bypass
  Quiet hours defined as start-end pair in user timezone. Critical alerts (severity "critical") always bypass. Non-critical are queued. Morning flush at quiet end time via scheduled timer.

AD-004: Inline buttons via existing callback infrastructure
  Extend the existing bot.on("callback_query:data") handler in relay.ts with new prefixes (notif_task_, notif_idea_, notif_alert_). Reuse InlineKeyboard from grammy.

AD-005: Preferences as local config file
  Store notification preferences in config/notification-prefs.json. Simpler than a DB table for single-user. Loaded once on startup, updated via /notify command.

AD-006: Digest formatting as plain text
  Digests are plain text (no markdown per project convention). Structured with line breaks, counts, and timestamps. Priority ordering: critical alerts > warnings > tasks > PRs > ideas.


## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [x] AC-001: Batch flushes after interval with grouped notifications
- [x] AC-002: Batch flushes immediately when threshold reached
- [x] AC-003: Single notification sent standalone (no "digest of 1")
- [x] AC-004: Digest groups by type with counts and timestamps
- [x] AC-005: Non-critical notification queued during quiet hours
- [x] AC-006: Morning digest sent at quiet hours end
- [x] AC-007: Critical alert bypasses quiet hours
- [x] AC-008: Timezone-aware quiet hours evaluation
- [x] AC-009: Task notification includes correct inline buttons
- [x] AC-010: PR notification includes "Voir la PR" button
- [x] AC-011: Idea notification includes promote/archive buttons
- [x] AC-012: Alert notification includes type-specific buttons
- [x] AC-014: Default preferences applied when none set
- [x] AC-015: /notify quiet updates quiet hours
- [x] AC-016: /notify alerts immediate switches delivery mode
- [x] AC-017: /notify off disables notification type
- [x] AC-019: Digest orders alerts first, then tasks, PRs, ideas
- [x] AC-020: Morning digest includes time range header
- [x] AC-021: Large digest collapses low-priority items
- [x] EC-001: Queue reloaded after restart (persistence)
- [x] EC-002: Cross-midnight quiet hours handled correctly
- [x] EC-005: Rapid-fire sends multiple batches at threshold
- [x] EC-006: Corrupted prefs file falls back to defaults

Integration Tests:
- [x] AC-013: Inline button callback executes action and updates message
- [x] SC-003: End-to-end quiet hours hold + morning flush
- [x] SC-004: Rapid notifications batched into digest
- [x] SC-007: Critical alert sent during quiet hours

Acceptance Tests:
- [x] FR-001: All batching AC satisfied (AC-001 to AC-004)
- [x] FR-002: All quiet hours AC satisfied (AC-005 to AC-008)
- [x] FR-003: All inline buttons AC satisfied (AC-009 to AC-013)
- [x] FR-004: All preferences AC satisfied (AC-014 to AC-018)
- [x] FR-005: All digest AC satisfied (AC-019 to AC-021)

Adversarial Verification:
- [x] Spec vs implementation drift check
- [x] All FR-XXX traceable to code
- [x] All AC-XXX traceable to tests
