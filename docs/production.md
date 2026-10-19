# Running dictation in production

This is the operator's runbook for a Laravel app that embeds the dictation
packages (the reference deployment is Medi, `app.medi.ba`). It assumes the host
deploys with a script that runs `composer install`, `migrate --force`,
`npm install && npm run build` and `queue:restart`.

## 1. Sizing

| Resource | Guidance |
|---|---|
| CPU | Engine uses `ASR_CPU_THREADS` cores while transcribing. On a shared 8 vCPU host: `ASR_CPU_THREADS=6`, `ASR_MAX_CONCURRENCY=1`. |
| RAM | 4 GB limit for the engine container, ~2 GB steady state (large-v3-turbo int8). |
| Disk | 2 GB model volume + ~250 KB per minute of stored dictation. Back up the audio folder; it is health data. |
| Throughput | 20–30 s of CPU per minute of audio. One worker + one engine slot ≈ 2–3 dictation minutes per wall-clock minute. |

## 2. Package sources

Until the packages are on Packagist/npm, the monorepo must sit next to the app
checkout (`../dictation`):

```bash
cd /var/www
git clone https://github.com/dseremet/dictation.git dictation
cd dictation && npm ci && npm run build -w packages/protocol -w packages/vue
```

Repeat `git pull && npm run build …` whenever the packages change. After
publishing (see `README.md` of each package) switch the host to normal versions
and keep the clone only for the engine image.

## 3. Host `.env`

```
FEATURE_DICTATION=true             # host-specific flag name
DICTATION_ENGINE_URL=http://127.0.0.1:8321
DICTATION_ENGINE_TOKEN=<openssl rand -hex 32>
DICTATION_QUEUE=dictation
# DICTATION_POSTPROCESS=false      # LLM clean-up stays off unless agreements exist
```

Set `retry_after` of the queue connection above the job timeout (e.g. 720).

## 4. Engine

```bash
docker compose -f docker-compose.dictation.yml up -d --build
watch -n 5 curl -s http://127.0.0.1:8321/health      # 503 "loading" until the model is in
php artisan dictation:health
```

Loopback bind only, read-only container, tmpfs for audio, `restart: unless-stopped`.
Never expose port 8321.

## 5. Dedicated worker (supervisor)

```ini
[program:dictation-worker]
command=php /var/www/app/artisan queue:work --queue=dictation --timeout=700 --tries=2 --sleep=3
directory=/var/www/app
user=www-data
autostart=true
autorestart=true
stopwaitsecs=720
numprocs=1
redirect_stderr=true
stdout_logfile=/var/log/dictation-worker.log
```

`numprocs` = `ASR_MAX_CONCURRENCY`. `queue:restart` in the deploy script restarts it.

## 6. Deploy, then smoke test

1. Run the normal deploy (installs the package, additive migration, front-end build).
2. Log in as a test doctor, dictate 10 s into a textarea, expect text within 20 s.
3. Play back, correct, delete. Confirm the audio URL redirects to login when logged out.
4. Check `storage/app/karton/<partner>/audio` (or the configured disk) is written.

## 7. Requirements on the client side

- HTTPS only (microphone needs a secure context). Chrome, Edge, Firefox, Safari 14.1+.
- Electron desktop app: new build needed for the automatic microphone permission.
- Mobile app: new native build with `@ditactic/dictation-react-native` for the bridge.

## 8. Operations

| Command | Purpose |
|---|---|
| `php artisan dictation:health` | Engine reachable, models listed |
| `php artisan dictation:transcribe <uuid>` | Run one recording synchronously, see the error |
| `php artisan dictation:requeue --stuck=30` | Cron every 15 min: re-queue rows stuck in pending/processing |
| `php artisan dictation:requeue --failed --limit=50` | Retry after an outage |
| `docker compose -f docker-compose.dictation.yml logs --tail=100` | Engine log (no transcript text ever) |

| Symptom | Cause / fix |
|---|---|
| No mic button | Flag off, cartons off for the partner, front end not rebuilt |
| Stays "waiting" | No worker on the `dictation` queue |
| `failed`, connection error | Engine down or wrong URL/token; `dictation:requeue --failed` after fixing |
| `failed`, 413 | Over 50 MB / 10 min; limits in `config/dictation.php` |
| Empty text, `no_speech` | Muted input device |
| Very slow | CPU starvation; lower contention or move the engine to its own host |
| Health 503 for long | First model download, or no access to huggingface.co |

Update: `git pull` in `dictation`, `docker compose … up -d --build` (10 s model reload).
Fine-tuned weights later: `ASR_MODEL=ditactic/faster-whisper-large-v3-turbo-bhs-medical`.

## 9. Rollback

Set the feature flag off and clear config cache: routes 404, buttons gone,
data kept. `docker compose -f docker-compose.dictation.yml down` keeps the model volume.
