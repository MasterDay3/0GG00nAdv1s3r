# Frontend

Everything that runs on the student's side. No build step and no dependencies: the files are served as they are.

## web/

The site, served by the backend at `/`. A single-page app in plain JavaScript with hash routes (`#/board`,
`#/prep`, `#/settings`, `#/privacy`); the interface is in Ukrainian.

| File | What it is |
|---|---|
| `index.html` | The page shell: top bar, navigation, offline notice |
| `app.js` | The whole app: API calls, every screen (board, exam prep, test, settings, checkout, privacy) |
| `tokens.css` | Design tokens: colours, fonts, spacing |
| `base.css` | Reset and base element styles |
| `style.css` | Component and screen styles, light and dark |
| `sw.js` | Service worker: the board opens without a connection |
| `manifest.webmanifest`, `favicon.svg`, `icon-*.png`, `apple-touch-icon.png` | Install as a phone app |

A new file in `web/` must also be added to `STATIC` in `backend/src/app.js` to be served.

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
