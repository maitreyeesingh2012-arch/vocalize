# Deploying the Vocalize server

The phone apps and the website both talk to one hosted Vocalize server. It must be on
**HTTPS**: browsers only allow the microphone on secure pages, and the App Store and Play
Store apps need a secure API.

## What the server needs

- **1 process, 2+ CPU cores, ~2 GB RAM.** Analysis is CPU-heavy (10–60 s per take, more
  with a reference song). Analysis jobs are held in memory, so run **one** server process
  (it is multi-threaded). To scale beyond one machine, move jobs to a queue (RQ or Celery)
  in `server/analysis.py`.
- **A persistent disk** for `/data` (database, recordings, song cache).
- **ffmpeg** to decode M4A/AAC uploads (included in the Docker image).

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `VOCALIZE_SECRET_KEY` | Signs login cookies. **Set a long random value in production.** | random, saved to `.secret_key` |
| `VOCALIZE_DB` | SQLite database path | `./vocalize_vault.db` |
| `VOCALIZE_DATA_DIR` | Recordings + song cache | `./data` |
| `VOCALIZE_HOST` / `VOCALIZE_PORT` | Bind address | `127.0.0.1` / `5000` |
| `VOCALIZE_PUBLIC_URL` | Public https URL, used in teacher share links | the request's host |
| `VOCALIZE_CORS_ORIGINS` | Origins allowed to call the API (the native apps) | `capacitor://localhost,http://localhost,https://localhost,ionic://localhost` |
| `VOCALIZE_SECURE_COOKIES` | `1` to mark cookies HTTPS-only | off (on in Docker) |
| `VOCALIZE_WORKERS` | Parallel analyses | `2` |
| `VOCALIZE_GOOGLE_CLIENT_ID` | Turns on "Sign in with Google" (an OAuth *Web* client ID from Google Cloud Console; add your site's https address under *Authorized JavaScript origins*) | off |

## With Docker (any host: Fly.io, Render, Railway, a VPS…)

```bash
docker build -t vocalize .
docker run -d -p 8000:8000 -v vocalize-data:/data \
  -e VOCALIZE_SECRET_KEY="$(openssl rand -hex 32)" \
  -e VOCALIZE_PUBLIC_URL="https://vocalize.example.com" \
  --name vocalize vocalize
```

Put it behind an HTTPS proxy or your host's managed TLS, and point your domain at it.
Health check: `GET /api/health`.

**Moving your existing data:** copy `vocalize_vault.db` and the `data/` folder into the
volume (as `/data/vocalize.db` and `/data/…`). The schema upgrades itself on start.

## Before going public

- [ ] `VOCALIZE_SECRET_KEY` set and kept secret
- [ ] HTTPS working; `VOCALIZE_PUBLIC_URL` set
- [ ] Regular backups of `/data` (the database *and* recordings)
- [ ] Privacy policy (`web/privacy.html`) filled in and hosted at a public URL
- [ ] Consider rate limiting `/api/analyze` and `/api/guest` at your proxy
- [ ] Consider moving from SQLite to Postgres if you expect many concurrent users
- [ ] Guest accounts that never come back accumulate; add a periodic cleanup if needed
