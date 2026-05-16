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
`scanned.jsonl`, and merges new hits into both `shops.jsonl` and
`shops.sqlite`. Pass `--no-db` to skip the SQLite write, or
`--db path/to/other.sqlite` to point at a different file. Safe to run on
a cron.

## Loading into SQLite

`to_sqlite.py` flattens `shops.jsonl` into a normalized database
(`shops.sqlite` by default):

```bash
python to_sqlite.py
```

It drops and recreates every table, so it's the right tool after a
fresh full sweep. For incremental keep-it-current updates, use
`update_from_feed.py` (which writes to the same DB).

The schema (six tables, FK cascades, indexes) and an ER diagram live in
[`schema.md`](schema.md). The shared schema + per-shop upsert helper is
in [`shops_db.py`](shops_db.py).

For dataset-level findings from the first full sweep — id density,
service type / delivery area breakdowns, image coverage, ownership
concentration — see [`stats.md`](stats.md).

## Live site

The dataset is browsable at **<https://dinbendon.itsi.xyz>** — a small
Cloudflare Worker (in [`worker/`](worker/)) backed by a D1 database.

- `/` — structured search by name/address and delivery area, plus a
  natural-language search box at the top.
- `/ask?q=…` — natural-language search. Cloudflare Workers AI
  (`@cf/google/gemma-4-26b-a4b-it`, see [`model-pricing.md`](model-pricing.md))
  parses the query into a structured intent (item keywords, area,
  landmark, service type, price ceiling, sort) and the worker runs a
  parameterized D1 query. Translates English place / dish names
  (Da'an → 大安, soup dumplings → 小籠包). Specific landmarks (MRT
  stations, buildings, universities) trigger geocoding via OSM
  Nominatim (cached in D1's `geocache` table); shops are then ranked
  by haversine distance within a 1.5 km radius. The parsed intent
  plus the resolved landmark address are shown above the results.
- `/shop/:id` — shop detail with menu, auto-labeling its image gallery
  as 菜單照片 or 產品照片 using the heuristic from [`stats.md`](stats.md).
- `/healthz` — JSON sanity check.

Sample NL queries:

```
/ask?q=古亭站附近的炒飯              ← landmark → geocode → 1.5 km radius
/ask?q=台北車站附近的便當            ← English-friendly: works in either language
/ask?q=fried rice near Taipei 101    ← English place + dish, auto-translated
/ask?q=cheapest soup dumplings in Da'an district
/ask?q=便當 in 內湖 under 100
/ask?q=新開的飲料店
```

Deploy:

```bash
cd worker
npm install
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy
```

`wrangler.jsonc` declares both bindings (`DB` → D1, `AI` → Workers AI),
plus the custom domain.

## Compacting `scanned.jsonl`

`scanned.jsonl` grows linearly (~30 bytes per id). For analysis or
sharing, collapse it to a sorted range list:

```bash
python to_ranges.py
```

That produces `scanned_ranges.json`, which is typically 5-6 orders of
magnitude smaller (`{"scanned": [[1, 650000]], "errors": [...], ...}`).
The scrapers still read/write `scanned.jsonl` for resume.

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
