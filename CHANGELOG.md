# Changelog

All notable changes to Dueboard are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are grouped by type (Added, Changed, Deprecated, Removed, Fixed, Security)
and tagged with the commit scope: `api`, `ui`, `db`, `auth`, `core`, `infra`.

## [Unreleased]

### Changed
- `ui`: The whole interface, server messages, Telegram bot and Chrome extension are in Ukrainian; dates use the Ukrainian format. Fonts switched to IBM Plex Sans and Mono, which have Cyrillic.

### Security
- `auth`: Limits on password guessing: 5 wrong passwords per account and address in 15 min, 30 per account in an hour, 100 logins and 20 sign-ups per address; the real address is read from Caddy's `X-Forwarded-For`.

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
- `api`: AI practice questions from uploaded slides: Claude reads PDF, PPTX, DOCX, TXT and MD materials and writes 3–5 practical questions per topic (needs `ANTHROPIC_API_KEY`, 10 runs per user a day).
- `ui`: "Questions from your slides" panel on the exam page; each AI question shows the file, slide and quote it comes from.
- `db`: `question_sources` table (slide behind each AI question) and `ai_runs` table (daily limit).
- `api`: AI questions work with Claude, Gemini or DeepSeek (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`); the provider is picked from the key when not set.
- `ui`: Diagnostic test one question at a time: a wrong pick turns red and the right answer green at once, with the slide it comes from; a results screen with score, per-topic bars and a review of mistakes. Answers in the topic list are hidden until opened.
- `ui`: Generate any number of AI questions (1–30) without adding topics first; the model names the topics and new ones are created.

### Fixed
- `api`: Telegram reminder times are shown in Kyiv time instead of the server's time zone (UTC on AWS).
- `api`: A chat that blocked the bot is unlinked instead of failing every minute.
- `api`: The bot ignores group chats, so personal deadlines are never posted to a group.
