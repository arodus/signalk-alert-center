# Changelog

All notable user-visible changes are recorded here. The project follows Semantic
Versioning while it remains pre-1.0.

## [Unreleased]

- Persist and display aggregate and per-satellite signalk-wyoming playback
  outcomes separately from notification delivery acceptance, including restart
  reconciliation and explicit unknown results when confirmation is lost.
- Added complete Signal K App Store metadata, reproducible desktop and tablet
  screenshots, privacy and first-run guidance, an operator-focused README, and a
  separate developer guide.
- Added signalk-wyoming notification sounds with a configurable sound for every
  alert severity, per-alert sound overrides, and independent per-alert sound and
  speech switches. When both are enabled, the sound is queued before speech.
- Repeat-while-active delivery is configured per notification service, persisted
  across restarts, and continues while the Signal K alert remains active even if
  its source sends no additional updates.
- Added Telegram Bot API notifications with chat, forum-topic, silent-delivery,
  manual-test, and durable retry support.
- Added signalk-wyoming as an optional notification service for durable spoken
  alerts, including global satellite, voice, severity, and urgency settings;
  per-alert speech templates, severity thresholds, optional clear announcements;
  and manual speech tests. Alert Center does not require Wyoming when this service
  type is not configured.
- Added validated npm package creation, clean-install smoke testing, and protected
  tag-based npm and GitHub release automation.
- Renamed the package, Signal K plugin, dashboard, and API to Signal K Alert
  Center as a clean version-one installation.
- Removed all pre-release database and package-name migrations. Signal K Alert
  Center now initializes one complete schema in `alert-center.sqlite`.
- Added a modern, sectioned Signal K settings panel with service-type controls,
  a configured-service default picker, unsaved-change handling, and a confirmed
  database-reset action.

Future changes intended for the next release belong here until a release pull
request moves them into a dated version section.
