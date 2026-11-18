# Dueboard

Every course deadline in one list, and a study coach for the week before the exam.

Dueboard is a web app for university students (built at UCU, interface in Ukrainian). It pulls deadlines from Moodle,
lets a study group share the ones Moodle does not know about, reminds you in Telegram before each one, and helps you
prepare for an exam: a diagnostic test on your own questions or on questions an AI writes from your lecture slides,
a day-by-day plan counted back from the exam date, and progress across attempts.

**Live:** https://dueboard.xyz

## Repository layout

```
backend/     Node.js server: HTTP API, SQLite, Moodle sync, Telegram bot, AI features
  src/         main.js starts the server; app.js holds the routes; one module per concern (ics, reminders, ai, ...)
  test/        node:test suites (API, logic, security), run with npm test
  package.json
frontend/
  web/         the site: a single-page app in plain JavaScript (no build step), styles, service worker, icons
  extension/   Chrome extension that syncs Moodle from the student's browser (see below)
infra/       production: setup.sh (install or update a server), autodeploy.sh, systemd units
CHANGELOG.md what changed, by release
```

Each part has its own README with a map of its files: [backend](backend/README.md),
[frontend](frontend/README.md), [infra](infra/README.md).

The backend serves `frontend/web/` itself, so one process is the whole app. There are no npm dependencies: the server
uses only Node.js built-ins (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), and the frontend is plain
HTML, CSS and JavaScript.

## Run locally

Requires Node.js 22.13 or newer (for the built-in `node:sqlite`). Nothing to install.

```sh
cd backend
npm start      # http://127.0.0.1:3000, data in backend/data/dueboard.db
npm test       # all test suites
```

Open http://127.0.0.1:3000, register an account and import an `.ics` file or paste a Moodle calendar link in Settings.
The Telegram bot and AI questions stay off until their keys are set (see below); everything else works without them.

### Configuration

All settings are environment variables; on a server they live in `/etc/dueboard.env`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DB_PATH` | `data/dueboard.db` | SQLite file (relative to where the server starts) |
| `COOKIE_SECURE` | `0` | `1` adds `Secure` to the session cookie; set it when the site is served over HTTPS |
| `TELEGRAM_BOT_TOKEN` | none | Turns on the Telegram bot: account linking, reminders, the morning digest, deadlines from forwarded messages, password reset codes |
| `TEAM_CHAT_ID` | none | Telegram chat of the team: `/support` questions from students arrive there; answer with `/reply <chat id> text`. Add the bot to the chat and send `/chatid` there to get the id |
| `AI_API_KEY` | none | Turns on the AI features (questions from slides, explanations, reading forwarded messages). A Claude, Gemini or DeepSeek key; `ANTHROPIC_API_KEY` also works |
| `AI_PROVIDER` | from the key | `claude`, `gemini` or `deepseek`. Without it: `sk-ant-…` is Claude, `AIza…` is Gemini, any other key is DeepSeek |
| `AI_MODEL` | per provider | Model id; defaults `claude-opus-5-5`, `gemini-3-flash-preview`, `deepseek-flash` |
| `STORAGE_MB_PER_USER` | `100` | Uploaded files one account may keep, across all its exams |
| `PAYWALL` | off | `1` puts exam prep behind Dueboard Prep (149 грн / 30 days). The checkout is a demo with test cards only: no real money moves. Deleting exams and files stays free |

## Deploy

Production runs on one AWS Lightsail instance (Ubuntu 24.04, eu-central-1): the Node.js server as a systemd service
behind Caddy, which gets and renews the HTTPS certificate. The SQLite file lives in `/var/lib/dueboard`.

**First install, or a manual update**, on a fresh Ubuntu 24.04 server:

```sh
curl -fsSL https://raw.githubusercontent.com/MasterDay3/0GG00nAdv1s3r/main/infra/setup.sh -o setup.sh
sudo bash setup.sh                                                # no domain yet: HTTP on the server's IP
sudo SITE_ADDRESS="dueboard.xyz, www.dueboard.xyz" bash setup.sh  # with a domain: HTTPS
```

`setup.sh` is safe to re-run. It installs Node.js 22, Caddy, git and sqlite3, clones the repository to
`/opt/dueboard`, creates `/etc/dueboard.env` on the first run (then keeps it), writes the Caddy config, installs the
systemd units from `infra/` and starts everything. Put the bot token and the AI key into `/etc/dueboard.env` and run
`sudo systemctl restart dueboard`. Logs: `journalctl -u dueboard -f`.

**Auto-deploy.** Merging into `main` is the deploy. Every minute the server checks GitHub; on a new commit it:

1. runs the tests on it in a scratch copy, as an unprivileged user, and skips the commit if they fail;
2. copies the database to `/var/lib/dueboard-autodeploy/before-<commit>.db` (the last 5 are kept);
3. runs that commit's `infra/setup.sh` and checks that the app answers;
4. if it does not, rolls back to the previous commit with that commit's own setup (units and Caddy included). A deploy
   that fails although its tests passed is tried 3 times.

Running `setup.sh` by hand with `BRANCH` or `COMMIT` pins that version; auto-deploy waits until `setup.sh` runs again
without them. Logs: `journalctl -u dueboard-autodeploy`.

## Moodle sync through the Chrome extension

UCU Moodle (`learn.ucu.edu.ua`) sits behind a Cloudflare bot check, so the server cannot download the calendar link
itself. `frontend/extension/` is a Chrome extension that downloads it from the student's browser instead:

1. Paste the Moodle calendar link in Dueboard → Settings (Moodle: Calendar → Export → Get calendar URL).
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `frontend/extension/`.
3. Reload Dueboard → Settings → **Connect extension**.

It then syncs every hour and every time a Moodle page is opened. It authenticates with its own key, which can only
read the calendar link and upload the calendar. It is set up for `learn.ucu.edu.ua` and a Dueboard on
`https://dueboard.xyz` or `localhost`; for other hosts change `host_permissions` and `matches` in
`frontend/extension/manifest.json` and `DUEBOARD_ORIGIN` in `frontend/extension/background.js`.

## Features

- **Deadline board.** Deadlines from Moodle (read-only calendar link, re-synced every 6 hours, or an imported `.ics`
  file) in one list grouped by day and coloured by urgency: red under 48 h, amber under 7 days, grey later. Search by
  title, course or note, filter by course, personal notes, and "done" that is personal even for group deadlines.
- **Own and group deadlines.** Add a deadline Moodle does not know about, for yourself or your whole group (join with
  a code). The author can edit it; a new date brings its reminders back.
- **Telegram bot.** Reminders 3 days, 1 day and/or 3 hours before each deadline (chosen in Settings), a morning digest
  at 08:00 Kyiv time, a ✅ button that marks a deadline done, and a message when a groupmate adds a group deadline.
  Forward it a message from a course chat (or type «лаба з ООП до 25.11 18:00») and the AI finds the deadlines and
  offers to add them for you or your group. Commands: `/deadlines`, `/digest`, `/help`, `/stop`, `/support`.
- **Exam prep.** Add an exam (it appears on the board), its topics, questions and practice problems, and upload
  lecture slides. A diagnostic test marks each topic strong (≥ 70 %) or weak and builds a day-by-day plan to the exam.
  Every attempt is kept: the exam page charts the score per attempt and each topic's first vs. last result, and
  "practise mistakes" reruns only the questions the last test got wrong.
- **AI questions from slides.** The AI reads uploaded PDF, PPTX, DOCX, TXT or MD files and writes 1 to 30
  multiple-choice questions sorted into topics, each showing the file, slide and quote it comes from, and an
  explanation shown after a wrong answer. Only practice questions that apply the ideas to new cases, never copies of
  quiz or exam questions. Up to 10 runs per user a day.
- **Calendar feed.** A secret link (`/cal/<token>.ics`) that Google or Apple Calendar subscribes to: open deadlines
  and exams, refreshed by the calendar app. A new link turns the old one off.
- **Phone app.** "Add to Home Screen" opens it full screen; without a connection it shows the last saved board.
- **Account and privacy.** Change the password (other devices are signed out), log out everywhere, download all your
  data as JSON, delete the account; a forgotten password is reset with a code from the Telegram bot. The privacy page
  (`#/privacy`) says what is stored and who else sees it.
- **Security.** Passwords hashed with scrypt; login, reset and sync rate limits; the Moodle link cannot make the server
  call internal addresses (every address and redirect is checked); a strict Content Security Policy with no inline
  scripts; HSTS behind HTTPS.
