# `dinbendon-gmaps-scraper` ops

How to check the gmaps scraper's state and what it actually costs.

## Is it done? Did it crash?

The scraper is a Worker that responds to HTTP, queue messages, and a
weekly cron. There is no long-running "background job" — there's a
queue (`gmaps-tiles`) and a consumer that drains it.

### Signal-by-signal

| Signal | How to read it |
|---|---|
| Tile coverage | `curl https://dinbendon-gmaps-scraper.changtimwu.workers.dev/status` — returns counts per status. `pending` = unprocessed, `ok` / `empty` = done, `error` / `blocked` = needs attention. |
| Permanent failures | Cloudflare dashboard → Queues → `gmaps-tiles-dlq`. Anything here is a tile that failed twice (`max_retries: 1`). Empty = clean. |
| Live execution | `cd worker-scraper && npx wrangler tail dinbendon-gmaps-scraper --format pretty` — shows each `[tile]` line as it completes, plus any errors. |
| Aggregate request volume | Cloudflare dashboard → Workers & Pages → `dinbendon-gmaps-scraper` → Metrics. |
| Browser-Rendering hours | Dashboard → Workers & Pages → Browser Rendering → Usage. |
| Queue backlog | Dashboard → Queues → `gmaps-tiles`. Drops to 0 when the sweep is done. |

### "Definitely crashed" looks like

- `/status` shows a non-trivial number of `error` or `blocked` tiles
  (>5% of total).
- `gmaps-tiles-dlq` has messages.
- Workers analytics shows non-zero errors.

### "Definitely done" looks like

- `/status` shows zero `pending` tiles.
- Queue backlog on the dashboard is 0.
- No new `[tile]` log lines for >2 minutes.

### State as of the first Taipei City sweep (2026-05-21)

```
status=ok    n=380
status=empty n=4    (water / coverage-edge tiles, no restaurants returned)
status=error n=0
status=blocked n=0
DLQ depth=0
gmaps_shops=6749
```

The 4 `empty` tiles are expected for any tile centered over water,
parks, or low-density edges of the bbox. They are not failures —
they had no restaurant results to return.

## Cost — what the sweep actually used

Everything stayed inside the **Workers Paid plan** ($5/month, already
in place). Marginal cost of the full Taipei City sweep was **$0**.

| Resource | First-sweep usage | Plan included | Per-unit overage price |
|---|---|---|---|
| Browser Rendering hours | ~1.3 hr (~384 sessions × ~12 s) | 10 hr/month | $0.09 / hr |
| Browser concurrency | 5 (configured), 10 included | 10 (averaged monthly) | $2.00 / month per extra |
| Workers requests (24h window) | 461 requests, 796 subrequests, 0 errors | 10M / month | $0.30 / 1M |
| Queue operations | ~770 (384 enqueue + 384 ack + ~2 misc) | 1M / month free, then $0.40 / 1M | — |
| D1 rows written | ~30K (initial upsert) | 50K / day on Paid | $1.00 / 1M |
| D1 rows read | ~40K | 25M / day on Paid | $0.001 / 1K |

Refreshes will be much cheaper than the initial sweep: each weekly
re-run scrapes only stale tiles (status != ok OR last_run > 30 days),
so the steady-state cost is well under 1 browser-hour per month.

**Hard ceiling to watch.** If `/status` ever shows >50 browser-hours
trending across a month, something is looping. Throttle by lowering
`max_concurrency` in `worker-scraper/wrangler.jsonc` (`gmaps-tiles`
consumer block), or stop the consumer entirely until the cause is
diagnosed.

## Manual operations

All `/enqueue` calls require the `X-Scrape-Key` header secret (set
via `wrangler secret put SCRAPE_KEY` at deploy time; current value
lives in `worker-scraper/.scrape-key.local`, gitignored).

```bash
KEY=$(grep SCRAPE_KEY worker-scraper/.scrape-key.local | cut -d= -f2)

# Resume any stale tiles (default)
curl -X POST "https://dinbendon-gmaps-scraper.changtimwu.workers.dev/enqueue?mode=stale" \
     -H "X-Scrape-Key: $KEY"

# Smoke test with N tiles
curl -X POST "https://dinbendon-gmaps-scraper.changtimwu.workers.dev/enqueue?mode=stale&limit=4" \
     -H "X-Scrape-Key: $KEY"

# Full re-sweep, regardless of state
curl -X POST "https://dinbendon-gmaps-scraper.changtimwu.workers.dev/enqueue?mode=all" \
     -H "X-Scrape-Key: $KEY"

# Diagnose one tile (returns raw card-level info, no DB writes)
curl "https://dinbendon-gmaps-scraper.changtimwu.workers.dev/debug?lat=25.04&lng=121.55" \
     -H "X-Scrape-Key: $KEY"
```

## Cron schedule

Weekly refresh runs at **Sunday 18:00 UTC = Monday 02:00 Taipei** via
the `triggers.crons` entry in `worker-scraper/wrangler.jsonc`.

Cloudflare uses Quartz-style cron where the weekday field is **1-7
with Sunday=1** (not standard POSIX 0-6). `0 18 * * 0` is invalid and
returns error code 10100 on deploy. Use `0 18 * * SUN` (or `1`).
