# Changelog

All notable changes to Dueboard are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are grouped by type (Added, Changed, Deprecated, Removed, Fixed, Security)
and tagged with the commit scope: `api`, `ui`, `db`, `auth`, `core`, `infra`.

## [Unreleased]

### Security
- `api`: Exam prep is no longer behind the paywall unless the server sets `PAYWALL=1` (the checkout is a demo, so the paywall took no money but locked students out of their own exams); deleting exams, topics and files never needs Dueboard Prep; orders are limited to 20 an hour.
- `api`: Deadlines the AI finds in a forwarded message go through the same checks as ones typed on the site (title and link length, link format, a date between 2000 and 2100) and past dates are not offered; at most 3 messages per student are read at once.
- `api`: A crafted .pptx can no longer freeze the server for hours (slide text is read in linear time).
- `auth`: A new password revokes the extension key and any pending Telegram link code; "log out everywhere" also turns off the calendar link and unlinks Telegram.
- `auth`: Wrong password-reset codes add up across codes (10 a day per account), so asking for new codes no longer buys new guesses.
- `api`: Links with line breaks are refused (they could inject lines into group members' calendar feeds); dates must lie between 2000 and 2100 (a date like 1e300 broke digests, exports and feeds for others).
- `api`: The SSRF guard also reads IPv4 hidden in IPv6 written in hex (NAT64, 6to4, mapped, compatible) and blocks Teredo.
- `api`: Group codes are 12 characters and wrong codes are limited to 10 an hour; at most 4 big uploads are read at once; failed AI runs count toward the daily limit.
- `api`: The Moodle calendar link can no longer make the server call internal addresses (localhost, the local network, the cloud metadata service): every address is checked when connecting, on each redirect too, and the download is capped at 5 MB. Manual syncs are limited to 10 per 10 minutes.
- `infra`: HSTS when served over HTTPS; `Permissions-Policy` and `Cross-Origin-Opener-Policy` headers.
- `auth`: Change password (signs out every other device), log out on all devices, delete the account with everything in it.
- `auth`: Forgotten password: a one-time 6-digit code goes to the linked Telegram chat (15 min, 5 tries, 3 codes per 15 min); the answer never reveals whether a username exists.
- `auth`: Limits on password guessing: 5 wrong passwords per account and address in 15 min, 30 per account in an hour, 100 logins and 20 sign-ups per address; the real address is read from Caddy's `X-Forwarded-For`.

### Changed
- `core`: The code is split into modules. Backend: `backend/src/app.js` (1600 lines) became a 170-line composition root plus `routes/` (one file per API area), `services/` (sessions, board, exam prep), `bot/`, `clients/` (AI, Telegram), `lib/` and `jobs.js`; parts share one context and call each other through it. Frontend: `frontend/web/app.js` (1900 lines) became 12 ES modules in `frontend/web/js/`, preloaded in parallel and cached for offline use. No behaviour changed: every original line is accounted for, all tests pass, every API route was checked with bad input and every screen in a browser. A new test stops a file named like a test (such as `test.js`) from appearing outside `backend/test/`, because the server runs `node --test` from the repository root.
- `infra`: `backend/`, `frontend/` and `infra/` each have a README with a map of their files.
- `infra`: The repository has three parts: `backend/` (server, tests, package.json), `frontend/` (`web/`, the site, and `extension/`, the Chrome extension) and `infra/` (setup, auto-deploy, systemd units). The server runs `backend/src/main.js`; run it locally from `backend/` with `npm start`. Auto-deploy finds `setup.sh` in `infra/` and still in `deploy/` for older commits, so rollbacks across the move keep working. The README now explains the product, the layout, running, configuration and deploying.
- `infra`: `deploy/autodeploy.sh` takes `APP_DIR` and `STATE_DIR` from the environment.
- `ui`: Design polish: plain Ukrainian punctuation instead of dashes, arrows and dot-joined strings; no emoji in the interface; no toast for what you already see on screen; a Ukrainian file picker; the phone menu on one row; Edit before Delete on the exam; one filled button per settings screen; the progress bar animates by transform.
- `ui`: The whole interface, server messages, Telegram bot and Chrome extension are in Ukrainian; dates use the Ukrainian format. Fonts switched to IBM Plex Sans and Mono, which have Cyrillic.
- `ui`: New look (warm paper, ink rules, Red Hat type, light and dark): the board is a ledger grouped by day with the next deadline open as a card, settings sit in labelled rows, exams are a ruled list; emoji icons replaced by text labels; one filled button per screen.

### Added
- `ui`: Privacy page (`#/privacy`, readable without an account, linked from the login screen and Settings → Акаунт): what Dueboard stores, which services get what (the AI provider in use, Telegram, Moodle, Google Fonts, AWS), the one cookie, how long data stays (backups included) and how to export, disconnect or delete everything.
- `api`: `/support <питання>` in the Telegram bot forwards the question to the team chat (`TEAM_CHAT_ID`); the team answers with `/reply <chat id> текст`. `/chatid` in a group shows the id to set. 5 questions an hour per chat.
- `api`: Dueboard Prep, the paid package: 149 грн for 30 days unlocks the whole exam prep section (the board, Telegram and Moodle sync stay free). Payment is a built-in demo checkout with test cards only, no real money and no external service; paying again adds 30 days on top of the time left. Settings shows the package and the payment history. `PAYWALL=0` opens exam prep to everyone.
- `db`: `users.premium_until` column and `payments` table.
- `api`: Forward the Telegram bot a message with a deadline: the AI reads it and the bot offers "add for me", "add for my group" or "cancel". Telegram updates are no longer handled one after another, so a slow AI call does not hold up other users.
- `ui`: "Why" after a wrong answer: AI questions come with an explanation; for the rest the AI writes one on the first mistake and it is kept (100 a day per user). Questions written by hand can carry their own explanation.
- `ui`: Guest page: what Dueboard does in three lines and a link to the Telegram bot, next to the sign-in form.
- `ui`: New exam: the Course field suggests the full names of your Moodle courses, and fills itself from the exam name (e.g. «Матаналіз», «ООП», «АСД»); you can still type anything.
- `api`: Optional exam theme (what the exam covers), set when creating or editing an exam; AI questions keep to it.
- `db`: `exams.theme` column.
- `api`: Download all your data (deadlines, notes, exams, questions, test results) as one JSON file from Settings → Account.
- `api`: The morning Telegram digest also says what to study today for each coming exam, following its day-by-day plan; it comes on study days even when nothing is due that week.
- `api`: Choose when Telegram reminders come: 3 days, 1 day and/or 3 hours before (Settings → Telegram); only the closest one is sent if several are due at once.
- `api`: A failing Moodle sync is no longer silent: the board and Settings show why, and the Telegram bot tells you once when background sync starts failing.
- `db`: Hourly cleanup of expired sessions and reset codes, day-old AI run counters and reminder marks of deadlines that are gone or a week past.
- `ui`: Install Dueboard on a phone as an app (web app manifest, icons, safe areas); a service worker opens the last saved board and exams offline and shows that it is offline. Saved data is cleared on log out.
- `api`: Storage limit for uploaded files: 100 MB per account across all exams (`STORAGE_MB_PER_USER`); the materials block shows how much is used.
- `ui`: Progress: every diagnostic attempt is kept; the exam page charts the score per attempt and each topic's first vs. last result.
- `ui`: Practise your mistakes: a round with only the questions the last test got wrong (from the exam page or the results screen); it does not change the diagnostic.
- `api`: Calendar feed: a secret link (shown once, can be replaced or turned off) that Google, Apple or Outlook calendars subscribe to; open deadlines and exams, refreshed hourly.
- `ui`: Search the board by title, course or note, and filter it by course; while searching, past and done deadlines are searched too.
- `ui`: Edit a deadline you added (title, course, date, link); a new date brings its reminders back.
- `ui`: Edit an exam (name, course, date), rename a topic, edit a question (text, options, right answer, topic) or a practice problem, AI questions included.
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
- `ui`: A second click on "Pay" during the bank pause no longer sends a second payment; reopening the checkout continues the same unpaid order instead of starting a new one each time.
- `ui`: Background requests (AI explanations, the bot link, payment history) no longer keep a just-submitted form locked; a test summary asks for at most 2 AI explanations at a time instead of all at once (the server allows 3 per student).
- `api`: The data export includes question explanations, Dueboard Prep's end date and the payment history, as the privacy page promises.
- `api`: `/reply` from the team chat says when the answer could not be delivered; a team chat that is someone's private chat with the bot keeps working as a normal chat; the guest and privacy pages stop asking Telegram for the bot name for 5 minutes after a failure.
- `ui`: The guest page lists its points without emoji; the Dueboard Prep panel lists its features as a ruled list instead of cards in a card; the "why" note after a wrong answer has no side stripe; no long dashes on the checkout.
- `api`: Gemini: a busy model falls back to the other Gemini model, each attempt waits up to 150 s instead of hanging for 5 minutes, and keys starting with `AQ.` are recognised as Gemini keys.
- `api`: AI questions from files without slides (DOCX, TXT, MD) are kept instead of dropped.
- `api`: The data export leaves out the Moodle calendar link, includes exam notes and ids, and downloads more safely.
- `ui`: Guest page columns shrink with the screen instead of following the longest line.
- `api`: Reading a forwarded message no longer leaves the chat silent for minutes: the bot answers "reading…" at once, the AI gets 30 s per model (1 min in all), and a timeout gets a clear message. Explanations use the same short timeout.
- `api`: The bot's welcome, /help and /digest texts name the reminders the user actually picked (or say they are off) instead of always "3 days and 1 day".
- `ui`: Course hints no longer depend on capital letters: the Course field suggests matches in any case, any apostrophe and anywhere in the name (its own list instead of the browser's, which in Safari matched only exact case from the start), and abbreviations like «асд» or «ооад» guess the course like «АСД».
- `ui`: Design audit: on a phone the deadline title gets the full width (it was squeezed to a few letters per line); the time column fits "через 11 днів"; no orange box around the page heading after each navigation; text fields are as tall as the buttons beside them; the exam form has room between fields; the exam list date stays on one line; task boxes inside exam panels are a tinted well, not a second card; "Download all my data" is a real button.
- `ui`: The test has its own address (`#/prep/<id>/test`): Back, the menu or closing the tab asks before dropping answers already given, instead of leaving silently.
- `api`: A Moodle assignment that leaves the feed is hidden, not deleted: when the teacher shows it again it comes back with your note and done mark; after 60 days hidden it is removed.
- `api`: All-day and zoneless Moodle times are read as Kyiv time whatever the server's time zone (the tests now pass in UTC and New York too); an event without a title is "Без назви".
- `infra`: Auto-deploy backs up the database before each deploy, rolls back with the previous commit's whole setup, retries a deploy that failed for a passing reason, reads the health-check port from the settings, and leaves a version pinned by a manual `setup.sh` run alone; `setup.sh` takes the deploy lock, skips `apt` when the packages are there and fixes the settings file's permissions on every run.
- `api`: Reminders come again when Moodle moves a deadline; an empty Moodle feed no longer deletes deadlines with their notes; a background job that takes longer than a minute no longer starts a second copy that sends everything twice; one user's error no longer stops reminders and digests for everyone after them; Telegram messages are cut to Telegram's limit instead of failing every minute; plan days follow Kyiv time whatever the server's time zone; a group deadline whose author deleted the account can be removed by any member; two sign-ups with one name at once give 409, not 500; database migrations add each column on its own.
- `ui`: Log out offline no longer pretends to sign out while the session stays valid; another account's saved offline data is cleared on log in; coming back online no longer wipes a running test or a half-typed form; a slow screen can no longer draw over a newer one; a double Enter or double click no longer creates two deadlines or saves a test twice; focus moves to the new screen's heading and the page is no longer re-read by screen readers on every change; reminder checkboxes show the real state after a failed save; a failed extension connect no longer shows Connected.
- `infra`: The extension no longer shows an error badge for the hourly background sync when a Moodle visit synced within the day; the popup is fully Ukrainian.
- `api`: Telegram reminder times are shown in Kyiv time instead of the server's time zone (UTC on AWS).
- `api`: A chat that blocked the bot is unlinked instead of failing every minute.
- `api`: The bot ignores group chats, so personal deadlines are never posted to a group.
