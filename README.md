# Dueboard

Every course deadline in one list, and a study coach for the week before the exam.

## Run locally

Requires Node.js 22.13+ (uses the built-in `node:sqlite`). No `npm install` needed: there are no dependencies.

```sh
npm start          # http://127.0.0.1:3000
npm test
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DB_PATH` | `data/dueboard.db` | SQLite file |
| `TELEGRAM_BOT_TOKEN` | — | Turns on the Telegram bot (account linking and reminders 3 days / 1 day ahead) |
| `COOKIE_SECURE` | `0` | `1` adds `Secure` to the session cookie; set it when the site is served over HTTPS |
| `AI_API_KEY` | — | Turns on AI practice questions generated from uploaded slides. A Claude, Gemini or DeepSeek key (`ANTHROPIC_API_KEY` also works) |
| `AI_PROVIDER` | from the key | `claude`, `gemini` or `deepseek`. Without it: `sk-ant-…` is Claude, `AIza…` is Gemini, any other key is DeepSeek |
| `AI_MODEL` | per provider | Model id; defaults `claude-opus-5-5`, `gemini-3.8-flash`, `deepseek-flash` |

## Deploy (AWS Lightsail)

Live at **https://dueboard.xyz**.

Production runs on one AWS Lightsail instance (`nano_3_0`, Ubuntu 24.04, eu-central-1): Node.js as a systemd service
behind Caddy, which gets and renews the HTTPS certificate. The SQLite file lives in `/var/lib/dueboard`, and Lightsail
takes a daily snapshot of the disk.

```sh
# on the server, first install or any update
curl -fsSL https://raw.githubusercontent.com/MasterDay3/0GG00nAdv1s3r/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh                                  # no domain yet: HTTP on the server's IP
sudo SITE_ADDRESS="dueboard.xyz, www.dueboard.xyz" bash setup.sh   # with the domain: HTTPS
```

Settings live in `/etc/dueboard.env` (kept between runs). Logs: `journalctl -u dueboard -f`.

**Auto-deploy.** Merging into `main` is enough: every minute the server checks GitHub, runs `npm test` on a new
commit, deploys it and checks that the app answers. If the tests fail the commit is skipped; if the new version does not
start, the server rolls back to the previous commit. Logs: `journalctl -u dueboard-autodeploy`.

## Moodle sync through the Chrome extension

UCU Moodle (`learn.ucu.edu.ua`) sits behind a Cloudflare bot check, so the server cannot download the calendar link itself.
The `extension/` folder is a Chrome extension that downloads it from the student's browser instead:

1. Paste the Moodle calendar link in Dueboard → Settings.
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension/` folder.
3. Reload Dueboard → Settings → **Connect extension**.

It then syncs every hour and every time a Moodle page is opened. It authenticates with its own key, which can only read
the calendar link and upload the calendar. The extension is set up for `learn.ucu.edu.ua` and a Dueboard running on
`https://dueboard.xyz` or `localhost`/`127.0.0.1`; for other hosts change `host_permissions` and `matches` in `extension/manifest.json` and `DUEBOARD_ORIGIN` in `extension/background.js`.

## Features

- **Deadline board.** Connect Moodle with its read-only calendar link (Calendar → Export → Get calendar URL), or import an `.ics` file. One list colour-coded by urgency: red under 48 h, amber under 7 days, grey later. Re-syncs every 6 hours. Search by title, course or note and filter by course.
- **Own and group deadlines.** Add a deadline Moodle does not know about, for yourself or your whole group (join with a code). The author can edit it later; a new date brings its reminders back.
- **Calendar feed.** Settings → Google or Apple Calendar makes a secret link (`/cal/<token>.ics`) that a phone calendar subscribes to: open deadlines and exams, refreshed by the calendar app. A new link turns the old one off.
- **Personal notes** on any deadline.
- **Account.** Change the password (other devices are signed out), log out everywhere, delete the account. A forgotten password is reset with a code the Telegram bot sends to the linked chat.
- **Brute-force limits.** 5 wrong passwords per account and address in 15 minutes, 30 per account in an hour; behind Caddy the real address comes from `X-Forwarded-For`.
- **Done.** Mark a deadline done on the board or with the ✅ button under a Telegram reminder: it leaves the board and gets no more reminders. Done is personal, also for group deadlines, and can be undone.
- **Telegram bot** (needs `TELEGRAM_BOT_TOKEN`). Link from Settings → Connect Telegram. Reminders 3 days and 1 day before each deadline, a morning digest at 08:00 Kyiv time when something is due within 7 days, and a message when a groupmate adds a group deadline. Commands: `/deadlines`, `/digest` (on/off), `/help`, `/stop`. It only answers in private chats, and a chat that blocks the bot is unlinked automatically.
- **Exam prep.** Add an exam (it appears on the board), its topics, quiz questions and practice problems, and upload lecture slides. Everything can be edited afterwards, AI-written questions too. A diagnostic test marks each topic strong (≥ 70 %) or weak, shows practice problems for weak topics, and builds a day-by-day plan counted back from the exam date.
- **Progress and mistakes.** Every test attempt is kept: the exam page charts the score per attempt and each topic's first vs. last result. "Practise mistakes" runs only the questions the last test got wrong, without changing the diagnostic.
- **AI questions from slides** (needs `AI_API_KEY`). Exam → Questions from your slides → **Generate questions**: Claude, Gemini or DeepSeek reads the uploaded PDF, PPTX, DOCX, TXT or MD files and writes as many multiple-choice questions as you ask for (1–30), sorted into topics it names itself (no topics needed up front), each showing the file, slide and a short quote it comes from. Only practice questions that apply the ideas to new cases, never copies of quiz or exam questions from the slides, so they cannot be used on graded Moodle quizzes. Up to 10 runs per user a day.
