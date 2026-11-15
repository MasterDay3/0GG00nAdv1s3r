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

- **Deadline board.** Connect Moodle with its read-only calendar link (Calendar → Export → Get calendar URL), or import an `.ics` file. One list colour-coded by urgency: red under 48 h, amber under 7 days, grey later. Re-syncs every 6 hours.
- **Own and group deadlines.** Add a deadline Moodle does not know about, for yourself or your whole group (join with a code).
- **Personal notes** on any deadline.
- **Telegram reminders** 3 days and 1 day before each deadline.
- **Exam prep.** Add an exam (it appears on the board), its topics, quiz questions and practice problems, and upload lecture slides. A diagnostic test marks each topic strong (≥ 70 %) or weak, shows practice problems for weak topics, and builds a day-by-day plan counted back from the exam date.
