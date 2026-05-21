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

### State as of the Taipei + New Taipei urban sweep (2026-05-22)

```
status=ok    n=1629
status=empty n=80   (water / mountains / coverage-edge tiles)
status=error n=1    (one stubborn tile after a retry pass)
status=blocked n=0
DLQ depth=0
gmaps_shops=15617
```

The bbox covers Taipei City + the dense districts of New Taipei
(Banqiao, Sanchong, Xinzhuang, Linkou, Yonghe, Zhonghe, Tucheng,
Shulin, Xindian, Sanxia, Xizhi, southern Tamsui). 1,710 tiles total
at ~700 m spacing.

Sweep notes:
- 15 tiles initially got stuck `pending` (queue messages dropped or
  worker terminated mid-process) and ~35 errored transiently. A
  `mode=stale` re-enqueue cleaned all but 1 of them. Lesson: after
  any full sweep, do a follow-up `POST /enqueue?mode=stale` to
  sweep up stragglers before declaring done.
- The first Taipei-only sweep (2026-05-21, 384 tiles, 6,749 shops)
  is included in this run since the new bbox uses a different
  origin → all old `gmaps_tile_state` rows were truncated before
  re-seeding. Shop rows persisted (upsert by `(source, external_id)`).

## Cost — what the sweep actually used

Everything stayed inside the **Workers Paid plan** ($5/month, already
in place). Marginal cost of the full Taipei City sweep was **$0**.

| Resource | Cumulative usage | Plan included | Per-unit overage price |
|---|---|---|---|
| Browser Rendering hours | ~7 hr cumulative (Taipei sweep + NT expansion + retries) | 10 hr/month | $0.09 / hr |
| Browser concurrency | 5 (configured), 10 included | 10 (averaged monthly) | $2.00 / month per extra |
| Workers requests | a few thousand over ~24h, 0 errors | 10M / month | $0.30 / 1M |
| Queue operations | ~3,500 (~1,710 enqueue + ~1,710 ack + retries) | 1M / month free, then $0.40 / 1M | — |
| D1 rows written | ~50K (~30K upsert + ~20K refresh) | 50K / day on Paid | $1.00 / 1M |
| D1 rows read | ~80K | 25M / day on Paid | $0.001 / 1K |

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
