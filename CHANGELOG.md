# Changelog

All notable changes to Dueboard are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are grouped by type (Added, Changed, Deprecated, Removed, Fixed, Security)
and tagged with the commit scope: `api`, `ui`, `db`, `auth`, `core`, `infra`.

## [Unreleased]

### Changed
- `ui`: New look (warm paper, ink rules, Red Hat type, light and dark): the board is a ledger grouped by day with the next deadline open as a card, settings sit in labelled rows, exams are a ruled list; emoji icons replaced by text labels; one filled button per screen.

### Added
- `infra`: CHANGELOG.md to track changes from the first commit.
- `infra`: Zero-dependency Node.js server (`node:http`, `node:sqlite`), `npm start` / `npm test`.
- `auth`: Username + password accounts (scrypt hashes, HttpOnly session cookies).
- `api`: Moodle calendar import from the read-only iCal link or a pasted `.ics` file; re-sync every 6 hours.
- `ui`: Deadline board colour-coded by urgency (red < 48 h, amber < 7 days, grey later) with links to assignments.
- `api`: Personal deadlines and group deadlines shared through a group join code.
- `ui`: Personal notes on any deadline.
- `api`: Telegram bot linking and reminders 3 days and 1 day before each deadline (needs `TELEGRAM_BOT_TOKEN`).
- `ui`: Exam prep: exams on the board, topics, hand-written quiz questions and practice problems, slide uploads.
- `api`: Clear message when Moodle is behind a bot check, pointing to the alternatives.
- `infra`: Dueboard Sync Chrome extension that syncs the Moodle calendar from the browser every hour and on every Moodle visit.
- `auth`: Separate extension key that can only read the calendar link and upload the calendar.
- `core`: Diagnostic test scoring (strong ≥ 70 % / weak per topic) and a day-by-day study plan counted back from the exam date.
- `infra`: Deploy to AWS Lightsail: `deploy/setup.sh` installs Node.js, Caddy (automatic HTTPS) and a systemd service.
- `auth`: `COOKIE_SECURE=1` marks the session cookie `Secure` when served over HTTPS.
- `infra`: Dueboard Sync extension also works with the production site https://dueboard.xyz.
- `api`: Telegram bot commands `/deadlines`, `/digest`, `/help`, `/stop`, shown in the bot's command menu.
- `api`: Morning Telegram digest at 08:00 Kyiv time with deadlines due in the next 7 days (can be turned off with `/digest`).
- `api`: Telegram message to group members when someone adds a group deadline.
- `infra`: Auto-deploy: the server checks GitHub `main` every minute, tests new commits, deploys them and rolls back if the app does not start.
- `ui`: Mark a deadline done (and undo it); done deadlines leave the board and stop reminders, shown under "Show done".
- `api`: ✅ Done button under Telegram reminders.
- `ui`: Bee logo as the site icon and in the header.

### Fixed
- `api`: Telegram reminder times are shown in Kyiv time instead of the server's time zone (UTC on AWS).
- `api`: A chat that blocked the bot is unlinked instead of failing every minute.
- `api`: The bot ignores group chats, so personal deadlines are never posted to a group.
