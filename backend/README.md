# Backend

The Dueboard server: HTTP API, SQLite storage, Moodle sync, the Telegram bot and the AI features. It also serves the
site from `../frontend/web/`. Node.js 22.13+ built-ins only, no npm dependencies.

```sh
npm start   # http://127.0.0.1:3000 (settings: see the table in the root README)
npm test    # all suites in test/
```

## src/

| File | What it does |
|---|---|
| `main.js` | Entry point: reads the environment, starts the HTTP server, the Telegram polling and the timers (reminders, digests, Moodle sync, cleanup) |
| `app.js` | `createApp()`: every API route, sessions, rate limits, static files, background jobs and the Telegram bot's handlers |
| `db.js` | Opens SQLite, creates the schema and runs the column migrations |
| `validate.js` | Input checks for API bodies (text, links, timestamps) and `HttpError` |
| `limiter.js` | In-memory rate limiter and the client IP behind Caddy |
| `safe-fetch.js` | Fetch for user-given links that refuses internal addresses (SSRF guard) |
| `ics.js` | Reads Moodle iCalendar exports (Kyiv time for zoneless dates) |
| `ics-export.js` | Writes the calendar feed that Google or Apple Calendar subscribes to |
| `urgency.js` | Time constants and the red / amber / grey urgency of a deadline |
| `reminders.js` | Which Telegram reminders (3 days, 1 day, 3 hours) are due |
| `bot.js` | Telegram message texts: reminders, digest, help |
| `telegram.js` | Thin Telegram Bot API client (only logs when there is no token) |
| `diagnostic.js` | Scores a diagnostic test per topic (strong from 70 %) |
| `plan.js` | Day-by-day study plan counted back from the exam date |
| `ai.js` | AI client for Claude, Gemini or DeepSeek: questions from slides, explanations, deadlines in messages |
| `slides.js` | Text out of PPTX and DOCX files (zip reading without a dependency) |

## test/

| File | Covers |
|---|---|
| `api.test.js` | The HTTP API end to end: accounts, board, groups, Moodle sync, Telegram, calendar feed, export, security headers |
| `logic.test.js` | Urgency, reminders, the study plan, diagnostic scoring, bot texts |
| `ics.test.js`, `ics-export.test.js` | Reading Moodle calendars and writing the feed |
| `safe-fetch.test.js` | The SSRF guard |
| `ai.test.js`, `exam-theme.test.js` | AI questions, slide reading, the exam theme |
| `payments.test.js` | Dueboard Prep and the demo checkout |
| `support.test.js` | `/support` in the Telegram bot |
