# D1 write-cost: what "rows written" actually means here

Captures why the dinbendon initial bulk-import on 2026-05-16 cost
~$5 in D1 write overage despite the dataset being only ~13K shops.
The short answer: Cloudflare bills *physical* row-writes, and a
relational schema with secondary indexes amplifies each logical
shop into hundreds of billable writes.

## How D1 counts a write

Cloudflare bills D1 by **rows written**, defined as every modification
to a row in a database table *or one of its indexes*. So one
`INSERT INTO products …` against a table with three secondary indexes
counts as **four** row writes (the table row + one entry per index).

Workers Paid plan: **50,000 rows written / day included**, overage at
**$1.00 / 1M**. (Reads: 25M / day included, overage $0.001 / 1K.)

## Live table + index inventory

Counts queried against D1 on 2026-05-25.

| Table | Rows | Source split | Secondary indexes |
|---|---:|---|---:|
| `shops` | 28,668 | 13,051 dinbendon + 15,617 gmaps | 6 |
| `shop_sent_areas` | 68,907 | dinbendon only | 1 |
| `shop_service_types` | 23,583 | dinbendon only | 1 |
| `categories` | 57,054 | dinbendon only | 1 + UNIQUE(shop,pos) |
| `products` | 433,804 | dinbendon only | 3 |
| `variations` | 607,135 | dinbendon only | 2 |
| `gmaps_tile_state` | 1,710 | scraper only | 1 |
| `geocache` | 13 | worker only | (PK only) |

`shops` carries the most indexes because it's the search index for
both `/` and `/ask`. Indexes on the shops table:

| Index | On | Applies to |
|---|---|---|
| `idx_shops_name` | `(name)` | all rows |
| `idx_shops_owner` | `(owner_name)` | all (dinbendon-only data) |
| `idx_shops_modified` | `(last_modified_date)` | all (dinbendon-only data) |
| `idx_shops_source` | `(source)` | all rows |
| `idx_shops_source_external` | `(source, external_id)` WHERE `external_id IS NOT NULL` | **gmaps only** (partial) |
| `idx_shops_lat_lng` | `(lat, lng)` | all rows with lat populated |

Six secondary indexes means each shop INSERT writes the row itself
plus up to six index entries.

## Write amplification per shop

### dinbendon (relational fan-out)

A dinbendon shop expands across all six tables — this is what makes
it expensive.

| Table touched | Rows per shop | Indexes on table | Writes per row | Writes per shop |
|---|---:|---:|---:|---:|
| `shops` | 1 | 5 applicable | 6 | 6 |
| `shop_sent_areas` | ~5.28 | 1 | 2 | 10.6 |
| `shop_service_types` | ~1.81 | 1 | 2 | 3.6 |
| `categories` | ~4.37 | 2 (1 idx + UNIQUE) | 3 | 13.1 |
| `products` | ~33.2 | 3 | 4 | 132.8 |
| `variations` | ~46.5 | 2 | 3 | 139.5 |
| **Total** | **~92 table rows** | | | **~306** |

So one logical "shop" → about **300 billable row writes** on initial
import. The `idx_shops_source_external` partial index doesn't fire for
dinbendon rows (their `external_id` is NULL), which is why it's
counted as 5 applicable on `shops`.

### gmaps (flat row)

A gmaps shop only writes to `shops` itself — the menu / area / service
tables stay empty. Plus the partial index `idx_shops_source_external`
does fire here (every gmaps row has an `external_id`).

| Table touched | Rows per shop | Applicable indexes | Writes per row |
|---|---:|---:|---:|
| `shops` | 1 | 6 (all) | 7 |
| **Total** | **1 table row** | | **7** |

So one gmaps shop → about **7 billable row writes**, ≈ **44× cheaper**
than a dinbendon shop. The relational fan-out is doing all the damage.

## Estimated vs. measured row-writes

Estimates from the per-shop amplification above against actual D1
billing data:

| Event | Shops touched | Estimated writes | Measured writes (D1 billing) |
|---|---:|---:|---:|
| 2026-05-16: dinbendon bulk import | 13,051 | ~4.0M (× 306/shop) | **5.17M** |
| 2026-05-21: gmaps Taipei sweep + NT expansion + retries | ~15,617 new + ~5K re-touched | ~110K + ~30K = ~140K | **341K** |
| 2026-05-24: weekly cron recovering 1 stale tile | 1 tile re-scraped | < 100 | **26** |

The 5.17M vs 4.0M dinbendon delta is the DROP+CREATE TABLE statements,
FK cascade fan-out from the `DELETE FROM shops WHERE id = ?` step in
`upsert_shop`, and a few SQLite internal page writes. Same shape, ~30%
overhead.

The 341K vs 140K gmaps delta on 2026-05-21 reflects:

- The bbox swap on 2026-05-21 re-ran every Taipei tile, so the 6,749
  shops from the original Taipei sweep got *re-upserted* — even when
  the data was identical, `ON CONFLICT … DO UPDATE` still writes (it
  touches every row + every index).
- ~50 retry-batch tiles re-uploaded their place lists.
- `gmaps_tile_state` had 1,710 inserts × 2 (PK + status index) plus
  another 1,710 UPDATEs (status flip on completion).

## Cumulative cost so far

Workers Paid daily included: 50K rows-written, then $1.00 / 1M.

| Date | Rows written | Over 50K | Overage |
|---|---:|---:|---:|
| 2026-05-16 | 5,168,224 | 5,118,224 | $5.12 |
| 2026-05-21 | 340,649 | 290,649 | $0.29 |
| Other days | < 50K each | 0 | $0.00 |
| **May 2026 total** | **5.51M** | **5.41M** | **$5.41** |

Storage: 84.2 MiB / 5 GB included → 1.7% used, $0.

## Levers to cut a future re-import

If we ever need to bulk-import dinbendon again (schema change, full
re-scrape), these are the realistic ways to keep it inside daily
quotas.

### 1. Drop secondary indexes during the import, recreate at the end

Per-row writes drop from `1 + N_indexes` to just `1`. For `products`
that's 4× → 1×, for `variations` that's 3× → 1×. The whole bulk
import would land somewhere around **1.2M writes instead of 5.2M**
(~75% reduction), well inside one day's free quota.

The trade-off: `CREATE INDEX` at the end re-scans the table and writes
the index in one shot — also billable. But a single sorted bulk
index-build is cheaper than maintaining the index incrementally on
every insert.

### 2. Split the import across days

Just chunk `shops_d1.sql` and run `wrangler d1 execute` on N
consecutive days. Each day's 50K free quota covers ~160 shops worth
of fan-out, so a full 13K-shop import would take ~80 days that way —
too slow. Combine with (1) to drop it to ~3 days.

### 3. Trim per-table indexes that we don't actually use

Audit candidates (none of these are load-bearing on `/ask` today):

- `idx_shops_owner` — used by nothing on the worker; only useful for
  ad-hoc SQL exploration.
- `idx_products_api_id`, `idx_variations_api_id` — kept "just in
  case"; the worker never queries by API id.

Dropping those three saves ~3 writes on every shops row, ~1 on every
product, ~1 on every variation = ~13K + 433K + 607K = **1.05M writes
per bulk import**, ~20% savings.

### 4. Make wide indexes partial where they're source-specific

- `idx_shops_owner` and `idx_shops_modified` only carry data for
  dinbendon rows. Adding `WHERE source = 'dinbendon'` makes them
  partial, so gmaps inserts skip them entirely.
- `idx_shops_lat_lng` is already effectively partial via the worker
  query (`WHERE lat IS NOT NULL`), but the schema doesn't enforce it.
  Adding `WHERE lat IS NOT NULL` saves index writes for the rare
  geo-null rows.

Net: each gmaps insert drops from 7 writes to **5**, saving ~30K
writes on a full gmaps sweep.

## Recommendation

**For steady-state operations** (weekly cron, manual `/enqueue?mode=stale`),
no action needed — daily writes stay well under 50K and cost is $0.

**Before the next dinbendon full re-import**, apply (1) and (3): drop
secondary indexes, drop unused indexes, run the import, recreate the
needed indexes. Expected: ~1M total writes vs the original ~5M,
keeping the operation inside one day's free quota and cost at $0.

**Long-term, if the dinbendon dataset doubles**, the import will
overflow even with (1) — at that point, (2) (split across days) is
the only remaining lever short of denormalizing or moving the ingest
path off D1's billable write meter.
