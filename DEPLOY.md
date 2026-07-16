# Deploying TeamUp on the college server

Everything below assumes a Linux server (Ubuntu/Debian-style). Two ways to run the
app — Docker (easiest to ask IT for) or bare Node with systemd. The AI assistant
is optional and separate: the site works fully without it.

---

## 1 · What to request from college IT (checklist)

Copy-paste this into your mail:

- [ ] A Linux server / VM (Ubuntu 22.04+ preferred) with:
      **4+ CPU cores, 8 GB RAM (16 GB if hosting the AI assistant), 25 GB disk**
- [ ] SSH access for me (`ssh <user>@<server-ip>`)
- [ ] Either **Docker installed**, or permission to install **Node.js 20+** (and Ollama, for the assistant)
- [ ] One open **HTTP(S) port** reachable by students on the campus network
      (443 with a subdomain like `teamup.<college-domain>` is ideal; a fixed `<ip>:3000` works too)
- [ ] A **persistent directory** for the database, e.g. `/opt/teamup/data`
      — and confirmation it's included in the server's backup routine
- [ ] (For real OTP emails) outbound SMTP allowed, or approval to use Postmark/AWS SES

> The app is one Node.js process. The database is a single SQLite file — there is
> **no database server to install or maintain.**

---

## 2 · Option A — Docker (recommended)

```bash
docker run -d --name teamup --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/teamup/data:/data \
  avaneesharoor/teamup:latest
```

- Database lands at `/opt/teamup/data/teamup.db` on the college disk.
- `--restart unless-stopped` = auto-restart on crash and on server reboot.
- Update later: `docker pull avaneesharoor/teamup:latest && docker rm -f teamup` then re-run the command above (data survives — it's on the volume).

## 3 · Option B — bare Node + systemd

```bash
sudo apt install -y nodejs npm   # needs Node 20+; use nodesource if apt's is older
sudo git clone https://github.com/avaneesh1830/TeamUp /opt/teamup/app
cd /opt/teamup/app && sudo npm ci --omit=dev
sudo mkdir -p /opt/teamup/data
```

`/etc/systemd/system/teamup.service`:

```ini
[Unit]
Description=TeamUp
After=network.target

[Service]
WorkingDirectory=/opt/teamup/app
Environment=PORT=3000
Environment=DATA_DIR=/opt/teamup/data
# Environment=SMTP_USER=... SMTP_PASS=...          (for OTP emails)
# Environment=OLLAMA_URL=http://localhost:11434    (for the AI assistant)
# Environment=OLLAMA_MODEL=qwen3:4b
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now teamup
```

---

## 4 · The AI assistant (optional — site works without it)

The chatbot needs [Ollama](https://ollama.com) running on the same server:

```bash
curl -fsSL https://ollama.com/install.sh | sh   # installs + creates a systemd service
ollama pull qwen3:4b                            # ~2.6 GB download, one time
```

Then make sure the app has `OLLAMA_URL=http://localhost:11434` (that's the default)
and `OLLAMA_MODEL=qwen3:4b`. With Docker, add to the `docker run`:
`--add-host=host.docker.internal:host-gateway -e OLLAMA_URL=http://host.docker.internal:11434`

- CPU-only is fine: ~15–25 tokens/sec on 8 cores → replies in a few seconds.
- If Ollama is down, the Assistant tab shows a friendly "offline" message; nothing else breaks.
- 16 GB RAM server? Use `ollama pull qwen2.5:7b` and set `OLLAMA_MODEL=qwen2.5:7b` — noticeably smarter.

## 5 · HTTPS (strongly recommended — students send passwords)

Simplest: [Caddy](https://caddyserver.com). `/etc/caddy/Caddyfile`:

```
teamup.yourcollege.edu {
    reverse_proxy localhost:3000
}
```

Caddy fetches and renews the TLS certificate automatically. (Needs the subdomain's
DNS pointed at the server — that's part of the IT request.)

## 6 · Backups (do not skip)

Nightly snapshot of the SQLite file, keeping 14 days — add to root's crontab:

```cron
0 2 * * * mkdir -p /opt/teamup/backups && sqlite3 /opt/teamup/data/teamup.db ".backup /opt/teamup/backups/teamup-$(date +\%F).db" && find /opt/teamup/backups -name 'teamup-*.db' -mtime +14 -delete
```

(`sqlite3` CLI: `sudo apt install sqlite3`. The `.backup` command is safe on a live database.)

## 7 · Smoke test after deploying

```bash
curl -s http://localhost:3000/ | head -c 100          # serves the site
curl -s http://localhost:3000/api/mentors             # 401 = API alive & auth working
ls -la /opt/teamup/data                               # teamup.db exists after first signup
```

## 8 · Environment variable reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DATA_DIR` | app folder | where `teamup.db` lives — point at the persistent dir |
| `SMTP_USER` / `SMTP_PASS` | unset | real OTP emails (unset = dev mode, OTP printed to logs) |
| `SMTP_HOST` / `SMTP_FROM` | gmail / SMTP_USER | mail server override (works with Postmark/SES SMTP too) |
| `OLLAMA_URL` | http://localhost:11434 | where the assistant's model server runs |
| `OLLAMA_MODEL` | qwen3:4b | which pulled model to use |
