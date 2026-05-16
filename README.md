# dinbendon shop scraper

Brute-force scrape `https://dinbendon.net/mvc/api/shop/idine/detail?shopId=<id>`
for every shop id in a range. Multi-threaded, resume-safe.

## Run

```bash
pip install requests
python scrape_shops.py --start 1 --end 800000 --workers 16 --delay 0.05
```

- Hits are appended to `shops.jsonl` (one shop per line, `{"shopId": ..., "data": {...}}`).
- Every scanned id (hit/miss/error) is logged in `scanned.jsonl` so a rerun skips them.
- Ctrl-C is safe — rerun the same command to resume.

## Tuning

- `--workers 16` is a polite default. Raise carefully; their server is shared infra.
- `--delay 0.05` adds a small per-call sleep inside each worker — keep this above 0
  unless you've confirmed the site tolerates faster traffic.
- The session retries 5xx/429 with backoff (handled by urllib3 `Retry`).

## Probing the id range

From quick checks:
- `637341` → exists
- `500000` → exists
- `100`, `1000`, `10000`, `100000`, `99999999` → `{"data": null}`

So valid ids appear scattered up to at least the mid-600k range. Start with a small
window (`--start 600000 --end 640000`) to estimate density before launching a full
sweep.

## Incremental updates from the latest-shops feed

Once you've done a full sweep, use `update_from_feed.py` to pick up newly added
shops without re-scanning everything:

```bash
python update_from_feed.py
```

It fetches `https://dinbendon.net/feed/latestshops` (Atom XML, ~20 recent
entries), filters to ids not already present in `shops.jsonl` or
`scanned.jsonl`, and merges new hits in. Safe to run on a cron.

## Output shape

`shops.jsonl`:
```json
{"shopId": 637341, "data": {"id": 637341, "detail": {"name": "...", "address": "...", "categories": [...]}}}
```

`scanned.jsonl`:
```json
{"shopId": 637341, "hit": true}
{"shopId": 637342, "hit": false}
{"shopId": 637343, "err": "http_500"}
```
