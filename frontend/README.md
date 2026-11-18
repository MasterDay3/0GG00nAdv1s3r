# Frontend

Everything that runs on the student's side. No build step and no dependencies: the files are served as they are.

## web/

The site, served by the backend at `/`. A single-page app in plain JavaScript, split into ES modules, with hash routes
(`#/board`, `#/prep`, `#/settings`, `#/privacy`); the interface is in Ukrainian.

| File | What it is |
|---|---|
| `index.html` | The page shell: top bar, navigation, offline notice; loads `js/main.js` and preloads every module |
| `tokens.css` | Design tokens: colours, fonts, spacing |
| `base.css` | Reset and base element styles |
| `style.css` | Component and screen styles, light and dark |
| `sw.js` | Service worker: the board opens without a connection |
| `manifest.webmanifest`, `favicon.svg`, `icon-*.png`, `apple-touch-icon.png` | Install as a phone app |

### web/js/

| Module | What it does |
|---|---|
| `main.js` | Start: load the account, draw the first screen, register the service worker |
| `router.js` | Which screen to show for the address, guarding a running test, logging out |
| `core.js` | What every screen uses: the `h()` DOM helper, API calls, form locking, toasts, dates and plurals, `appState` |
| `auth.js` | The guest page: login, registration, password reset |
| `board.js` | The deadline board: list by day, search and course filter, add, edit, notes, done |
| `settings.js` | Settings: Moodle, group, Telegram, calendar feed, file import, account |
| `extension.js` | Talking to the Dueboard Sync extension |
| `prep.js` | Exam prep: the exam list and one exam with topics, questions, materials, results, progress and plan |
| `courses.js` | The course field (full names suggested and guessed from the exam name) and the exam theme field |
| `quiz.js` | The diagnostic test and practice on mistakes, with AI explanations |
| `payments.js` | Dueboard Prep: the paywall, the demo checkout, the package in Settings |
| `privacy.js` | The privacy page |

Modules import what they use from each other. State that several modules change (the signed-in account, the screen
load counter, a running test's guard) lives in `appState` in `core.js`. A new module must be added to the
`modulepreload` list in `index.html` and to `SHELL` in `sw.js` (to work offline); the server serves any
`/js/<name>.js` from this folder.

## extension/

Chrome extension "Dueboard Sync" (Manifest V3). UCU Moodle blocks servers with a bot check, so the extension downloads
the student's Moodle calendar in their browser and uploads it to Dueboard. Install and setup: see the root README.

| File | What it does |
|---|---|
| `manifest.json` | Permissions and the sites it runs on |
| `background.js` | Hourly sync: fetches the calendar from Moodle, uploads it to Dueboard |
| `moodle-page.js` | Runs on Moodle pages: syncs when a Moodle page is opened |
| `dueboard-page.js` | Runs on Dueboard: tells the page the extension is installed and passes on "Connect extension" and sync requests |
| `popup.html`, `popup.js` | The toolbar popup: connection status, last sync and a sync button |
