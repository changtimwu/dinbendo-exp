-- D1 migration: add a `source` dimension to `shops` and a per-tile state table.
-- Safe to apply against the existing shops table (additive only).

-- Existing dinbendon rows become source='dinbendon' via the DEFAULT.
ALTER TABLE shops ADD COLUMN source TEXT NOT NULL DEFAULT 'dinbendon';
ALTER TABLE shops ADD COLUMN external_id TEXT;
ALTER TABLE shops ADD COLUMN rating REAL;
ALTER TABLE shops ADD COLUMN rating_count INTEGER;
ALTER TABLE shops ADD COLUMN price_level INTEGER;
ALTER TABLE shops ADD COLUMN opening_hours_json TEXT;
ALTER TABLE shops ADD COLUMN gmaps_types_json TEXT;

-- Idempotency for re-scrapes: (source, external_id) is the natural key
-- for non-dinbendon rows. dinbendon rows have external_id NULL so the
-- partial index excludes them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_source_external
  ON shops(source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shops_source ON shops(source);

-- Per-tile state for the gmaps scraper. Lets us see coverage at a
-- glance and only re-enqueue stale/failed tiles on refresh.
CREATE TABLE IF NOT EXISTS gmaps_tile_state (
  tile_id      TEXT PRIMARY KEY,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  radius_m     INTEGER NOT NULL,
  last_run     TEXT,
  status       TEXT,     -- 'ok' | 'blocked' | 'error' | 'empty'
  result_count INTEGER,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmaps_tile_state_status_last
  ON gmaps_tile_state(status, last_run);
