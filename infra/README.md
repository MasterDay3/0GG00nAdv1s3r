# Infra

How Dueboard runs in production: one Ubuntu 24.04 server (AWS Lightsail), the Node.js app as a systemd service behind
Caddy (HTTPS), and auto-deploy from GitHub `main`. How to install and what auto-deploy does: see the root README.

| File | Installed as | What it does |
|---|---|---|
| `setup.sh` | run by hand or by auto-deploy | Installs or updates a server: Node.js, Caddy, the app in `/opt/dueboard`, `/etc/dueboard.env`, the Caddy config, the units below. Safe to re-run |
| `dueboard.service` | `/etc/systemd/system/` | Runs `node backend/src/main.js` as the `dueboard` user, sandboxed, data in `/var/lib/dueboard` |
| `autodeploy.sh` | `/usr/local/bin/dueboard-autodeploy` | Tests a new commit, backs up the database, deploys, checks health, rolls back on failure |
| `dueboard-autodeploy.service`, `dueboard-autodeploy.timer` | `/etc/systemd/system/` | Run auto-deploy every minute |

Server paths: app `/opt/dueboard`, settings `/etc/dueboard.env`, database `/var/lib/dueboard/dueboard.db`, pre-deploy
database copies `/var/lib/dueboard-autodeploy/before-<commit>.db`. Logs: `journalctl -u dueboard -f` and
`journalctl -u dueboard-autodeploy`.
