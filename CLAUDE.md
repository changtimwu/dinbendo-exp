# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two halves, one shared dataset:

1. **A Python data pipeline** that brute-force scrapes `dinbendon.net`'s
   shop detail API into `shops.jsonl`, flattens it into a normalized
   SQLite DB (`shops.sqlite`), and incrementally tops up from the
   site's latest-shops feed.
2. **A Cloudflare Worker** at <https://dinbendon.itsi.xyz> (in
   `worker/`) that serves search + shop detail pages over a D1 copy
   of the same data, including a Workers AI–powered natural-language
   query endpoint (`/ask`) with proximity search around geocoded
   landmarks.

The detailed dataset stats, schema, model pricing, and latency notes
live in `stats.md`, `schema.md`, `model-pricing.md`, and `ai-perf.md` —
read those for the *findings*. This file is for the *operational*
shape.

## Pipeline data flow

```
dinbendon.net API
   │  scrape_shops.py (multi-thread brute force, range-based, resume-safe)
   ▼
shops.jsonl  +  scanned.jsonl
   │  to_sqlite.py        (bulk: drop + recreate every table)
   │  update_from_feed.py (incremental: pulls /feed/latestshops)
   ▼
shops.sqlite                ← local truth, 80 MB, ~13K shops
   │  sqlite3 .dump  →  d1_prepare.py  (strips unistr/PRAGMA/sqlite_stat,
   │                                   decodes \uXXXX into literals)
   ▼
shops_d1.sql                ← shape D1 will accept
   │  wrangler d1 execute --remote --file=
   ▼
Cloudflare D1 (dinbendon-shops)
   │  binding env.DB
   ▼
worker/src/index.ts  ←  served at dinbendon.itsi.xyz
```

Anything that writes to `shops.sqlite` must go through `shops_db.py`
(`open_db`, `ensure_schema`, `reset_schema`, `upsert_shop`). Both
`to_sqlite.py` (bulk reset + insert) and `update_from_feed.py`
(incremental upsert) share that module so the schema can't drift
between the two writers.

## Common commands

```bash
# Python scrapers (no virtualenv assumed; `requests` is the only dep)
pip install requests

# 1. Bulk sweep — resumes on rerun via scanned.jsonl
python scrape_shops.py --start 1 --end 650000 --workers 16 --delay 0.05

# 2. Bulk SQLite import — drops + recreates every table
python to_sqlite.py

# 3. Incremental top-up from latestshops Atom feed
#    (writes to both shops.jsonl AND shops.sqlite; --no-db to skip DB)
python update_from_feed.py

# 4. Compact scanned.jsonl (20 MB) into a range list (~100 bytes)
python to_ranges.py

# 5. Worker — invoke from `worker/`
cd worker && npm install
npx tsc --noEmit       # type-check; no test suite
npx wrangler dev       # local dev (note: D1 + AI bindings work against remote)
npx wrangler deploy    # custom domain dinbendon.itsi.xyz wired via routes
npx wrangler tail dinbendon-itsi --format pretty   # live logs incl. [ask] timings
```

There is no test suite or linter configured. Type-check via `tsc --noEmit`
in `worker/`; Python scripts have no checker — keep them small.

## Cloudflare auth quirks (important when running wrangler)

Authentication is via an API token in `cftoken.env` (gitignored). The
token is **zone-scoped + account-scoped + AI** but does not include
`User.Memberships:Read`, which wrangler tries to call for some commands.
Workaround that's load-bearing:

```bash
set -a; source cftoken.env; set +a
export CLOUDFLARE_ACCOUNT_ID=15bfe332876061d9a548a4f3d6835657
```

Without `CLOUDFLARE_ACCOUNT_ID`, `wrangler d1 list` and friends fail
with "Authentication error" on `/memberships`. The account id is also
in `worker/wrangler.jsonc`.

## D1 import gotchas (encoded in `d1_prepare.py`)

D1's SQLite is forked and rejects several things a standard
`sqlite3 .dump` emits. The preprocessor strips/transforms:

- `PRAGMA …;` lines — D1 disallows most pragmas.
- `BEGIN TRANSACTION;` / `COMMIT;` — D1 wraps the import itself.
- `INSERT INTO sqlite_sequence …` / `INSERT INTO sqlite_stat[14] …`
  — `ANALYZE` artifacts D1 won't accept.
- `unistr('…\uXXXX…')` — D1 doesn't expose the `unistr()` helper
  SQLite added for Unicode escapes. The preprocessor decodes
  `\uXXXX` in-place and rewrites to a plain literal.

If you ever regenerate the dump and the import fails, the fix
almost certainly lives in `d1_prepare.py`.

## Worker architecture (`worker/src/index.ts`)

Single-file TypeScript Worker, no framework. Server-rendered HTML,
zero client JS, dark-mode-aware CSS inline.

Routes:

- `GET /` — structured name/address + area search, plus the NL search
  box and example chips at the top.
- `GET /ask?q=…` — natural-language search, **streamed** via
  `TransformStream`. Sends `<head>…<main>` + form + spinner inside
  ~200 ms; intent/results/timings stream in after `parseIntent` →
  `geocode` → SQL finishes. A late `<style>#loading{display:none}</style>`
  hides the spinner without any JS.
- `GET /shop/:id` — shop detail with menu. Auto-labels the image
  gallery as 菜單照片 vs 產品照片 using the heuristic from `stats.md`
  (≤2 images and ratio ≤ 0.15 → menu).
- `GET /healthz` — `{"ok": true, "shops": …}`.

### NL search pipeline (`/ask`)

```
query → parseIntent()  ──→ ParsedIntent { item_keywords, area,
   │                                    near_landmark, service_type,
   │                                    sort_by, max_price,
   │                                    result_grain, limit, rationale }
   │
   ├── if near_landmark → geocode() → Nominatim (TW, cached in D1.geocache,
   │                                  negative hits cached too)
   │
   └── runProductSearch() or runShopSearch()
       ├─ parameterized SQL only (no LLM-generated SQL anywhere)
       ├─ proximity = bounding-box WHERE on shops.lat/lng (uses partial
       │   index idx_shops_lat_lng) + JS haversine re-rank within 1.5 km
       └─ console.log [ask] q=… parse=…ms geo=…ms query=…ms total=…ms
```

Three things are load-bearing and easy to break:

1. **`reasoning_effort: "none"`** in the `env.AI.run()` options. The
   current model (`@cf/google/gemma-4-26b-a4b-it`) is a reasoning
   model; without this flag every parse burns 1000+ output tokens on
   chain-of-thought and `parseIntent` takes 10-13 s. With it, ~1.5 s.
2. **Defensive response-shape handling** in `parseIntent`. Workers AI
   returns `{response: "…"}` for Llama-family models and OpenAI-style
   `{choices: [{message: {content, reasoning}}]}` for Gemma 4 / GPT-OSS.
   The parser pulls JSON from whichever field is populated and falls
   back to extracting `{…}` from prose.
3. **Geocoder politeness** — the Nominatim fetch sets a UA identifying
   the project, restricts `countrycodes=tw`, and caches both positive
   and negative hits in `geocache`. Don't remove the negative-cache
   write, or every misspelling re-hits Nominatim.

### Streaming response pattern

`renderAsk` returns `new Response(readable, …)` where `readable` is the
`TransformStream.readable` side. A background `(async () => {…})()` does
the work and writes results to the writer. The Worker runtime keeps the
request alive until `writer.close()`, so no `ctx.waitUntil` is needed.
Don't replace this with a non-streaming pattern unless you also bring
TTFB back to ~200 ms some other way.

## Schema and shared upsert (`shops_db.py`)

The SQLite schema lives in one place (`shops_db.py`) as both
`SCHEMA_DDL` (CREATE TABLE IF NOT EXISTS — used by incremental writes)
and `DROP_DDL` (used by `to_sqlite.py` for a full rebuild). `upsert_shop`
deletes the shop by id first (FK cascade clears children) then inserts
the new row — safe to call on existing or new shop ids.

Same six tables live in D1 (no `geocache` in local SQLite — that table
is D1-only, created at deploy time). The full schema + ER diagram are
in `schema.md`.

## Conventions / gotchas

- **Output files at repo root are gitignored:** `shops.jsonl`,
  `scanned.jsonl`, `shops.sqlite`, `shops.sql`, `shops_d1.sql`,
  `cftoken.env`, `*.env`. The tiny `scanned_ranges.json` is checked in
  as a coverage snapshot.
- **Resume-safety lives in `scanned.jsonl`** — `scrape_shops.py` and
  `update_from_feed.py` both read it (and `shops.jsonl`) before
  deciding what to fetch. Don't delete it after a partial run.
- **The dinbendon API is rate-sensitive shared infrastructure.** Default
  `--workers 16 --delay 0.05` (≈220 req/s) was empirically fine.
  Anything more aggressive should be discussed before launching.
- **`product.image` is heterogeneous** in the upstream JSON — sometimes
  a string, sometimes `{url, thumbnailUrl, width, height, …}`,
  sometimes `null`. Both the SQLite upsert (`shops_db.py`) and the
  worker's render flatten this to `image_url` + `image_thumbnail_url`.
- **The D1 database ID is in `worker/wrangler.jsonc`** along with the
  account id and custom domain route. Changing the database name
  requires updating both `wrangler.jsonc` and any `wrangler d1 execute`
  commands.
- **TTFB is supposed to be ~200 ms on `/ask`.** If a change causes the
  first byte to wait for the LLM, the streaming pattern got broken.

## Reference docs

- `schema.md` — D1/SQLite schema + Mermaid ER diagram.
- `stats.md` — dataset-level findings from the first full sweep.
- `model-pricing.md` — Workers AI catalog + cost analysis.
- `ai-perf.md` — `/ask` latency breakdown, model comparison,
  `reasoning_effort` discovery, tuning playbook.
