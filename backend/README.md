# Backend

The Dueboard server: HTTP API, SQLite storage, Moodle sync, the Telegram bot and the AI features. It also serves the
site from `../frontend/web/`. Node.js 22.13+ built-ins only, no npm dependencies.

```sh
npm start   # http://127.0.0.1:3000 (settings: see the table in the root README)
npm test    # all suites in test/
```

## How it fits together

`main.js` reads the environment and calls `createApp()` in `app.js`. `createApp()` builds one shared context: the
database helpers, the settings, the route table and the rate limits. Each service and route module receives that
context, adds its own functions to it and registers its routes. Modules call each other through the context
(`ctx.boardItems(user)`), so none of them imports another's internals and the order they are loaded in does not matter.
`app.js` then answers every request: security headers, static files, finding the route, the session, the body.

## src/

| Folder / file | What it holds |
|---|---|
| `main.js` | Entry point: environment, HTTP server, Telegram polling, timers (reminders, digests, Moodle sync, cleanup) |
| `app.js` | `createApp()`: the shared context, loading every part below, and the request handler |
| `constants.js` | Limits and fixed values (body sizes, AI quotas, reset code rules, the Dueboard Prep price) |
| `db.js` | Opens SQLite, creates the schema and runs the column migrations |
| `jobs.js` | Background jobs: Telegram reminders, the morning digest, hourly cleanup, the 6-hourly Moodle sync |
| **`routes/`** | **The HTTP API, one file per area** |
| `routes/accounts.js` | Register, log in and out, `/api/me`, password change and reset, data export, log out everywhere, delete account, settings |
| `routes/deadlines.js` | The board, own and group deadlines, done, notes, manual Moodle sync, `.ics` import |
| `routes/groups.js` | Create, join and leave a study group |
| `routes/exams.js` | Exams, topics, questions, problems, uploaded materials, the diagnostic test |
| `routes/ai.js` | AI questions from slides and AI explanations of a question |
| `routes/calendar.js` | The secret calendar feed link and the `/cal/<token>.ics` feed |
| `routes/telegram.js` | Linking the Telegram bot and choosing reminder times |
| `routes/extension.js` | The browser extension's key, its config and its calendar upload |
| `routes/payments.js` | Dueboard Prep: orders and the demo checkout |
| **`services/`** | **Logic several routes and the bot share** |
| `services/sessions.js` | The user behind a request (cookie or extension key), new sessions, what `/api/me` returns |
| `services/board.js` | What a user's board holds, done marks, adding deadlines, importing and syncing Moodle calendars |
| `services/prep.js` | Ownership checks for exams and their parts, the full exam with results, history and the study plan |
| **`bot/`** | **The Telegram bot** |
| `bot/handlers.js` | Commands, buttons, deadlines from forwarded messages, `/support`, group notifications |
| `bot/texts.js` | Every message text, in Kyiv time |
| `bot/reminders.js` | Which reminders (3 days, 1 day, 3 hours) are due |
| `bot/simple-parse.js` | Reads a deadline from a message without AI, when the AI is down or over its limit |
| **`clients/`** | **External services** |
| `clients/ai.js` | Claude, Gemini or DeepSeek over plain `fetch`: questions, explanations, deadlines in messages |
| `clients/telegram.js` | Thin Telegram Bot API client (only logs when there is no token) |
| **`lib/`** | **Small pure helpers** |
| `lib/validate.js` | `HttpError` and input checks for request bodies (text, links, timestamps, the Moodle link) |
| `lib/http.js` | Cookies, JSON bodies with a size limit, JSON responses |
| `lib/passwords.js` | scrypt password hashes and SHA-256 for stored keys |
| `lib/limiter.js` | In-memory rate limiter and the client address behind Caddy |
| `lib/safe-fetch.js` | Fetch for user-given links that refuses internal addresses (SSRF guard) |
| `lib/ics.js` | Reads Moodle iCalendar exports (Kyiv time for dates without a zone) |
| `lib/ics-export.js` | Writes the calendar feed |
| `lib/urgency.js` | Time constants and the red / amber / grey urgency of a deadline |
| `lib/plan.js` | Day-by-day study plan counted back from the exam date |
| `lib/diagnostic.js` | Scores a diagnostic test per topic (strong from 70 %) |
| `lib/slides.js` | Text out of PPTX and DOCX files (zip reading without a dependency) |

A new API area is a new file in `routes/` that exports `function xRoutes(ctx)`, registers its routes with
`ctx.route(...)`, returns any function other parts need, and is added to the list in `app.js`.

## test/

| File | Covers |
|---|---|
| `api.test.js` | The HTTP API end to end: accounts, board, groups, Moodle sync, Telegram, calendar feed, export, static files, security headers |
| `logic.test.js` | Urgency, reminders, the study plan, diagnostic scoring, bot texts |
| `ics.test.js`, `ics-export.test.js` | Reading Moodle calendars and writing the feed |
| `safe-fetch.test.js` | The SSRF guard |
| `ai.test.js`, `exam-theme.test.js` | AI questions, slide reading, the exam theme |
| `payments.test.js` | Dueboard Prep and the demo checkout |
| `support.test.js` | `/support` in the Telegram bot |
