// D1 writes: shop rows by (source, external_id) and per-tile state.
//
// `shops.id` is INTEGER PRIMARY KEY shared with dinbendon rows.
// For gmaps we hash the Place ID into a stable 32-bit int and offset
// it into the 20_000_000+ namespace so collisions with dinbendon's
// 1..650k brute-force range are impossible.

import type { ScrapedPlace } from './parse';
import type { Tile } from './tiles';
import type { TileResult } from './scrape';

const GMAPS_ID_OFFSET = 20_000_000;
const GMAPS_ID_SPAN = 1_000_000_000; // 30-bit hash + offset stays well within int32

// FNV-1a 32-bit. Cheap, deterministic, no crypto needed.
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function gmapsIdFor(externalId: string): number {
  return GMAPS_ID_OFFSET + (fnv1a(externalId) % GMAPS_ID_SPAN);
}

export async function upsertPlaces(db: D1Database, places: ScrapedPlace[]): Promise<void> {
  if (places.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO shops (
       id, source, external_id, name, address, lat, lng,
       rating, rating_count, price_level, opening_hours_json, gmaps_types_json
     ) VALUES (?, 'gmaps', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       name               = excluded.name,
       address            = excluded.address,
       lat                = excluded.lat,
       lng                = excluded.lng,
       rating             = excluded.rating,
       rating_count       = excluded.rating_count,
       price_level        = excluded.price_level,
       opening_hours_json = excluded.opening_hours_json,
       gmaps_types_json   = excluded.gmaps_types_json`
  );
  const batch = places.map((p) =>
    stmt.bind(
      gmapsIdFor(p.external_id),
      p.external_id,
      p.name,
      p.address,
      p.lat,
      p.lng,
      p.rating,
      p.rating_count,
      p.price_level,
      p.hours_summary ? JSON.stringify({ summary: p.hours_summary }) : null,
      p.primary_type ? JSON.stringify([p.primary_type]) : null,
    )
  );
  await db.batch(batch);
}

export async function ensureTileRow(db: D1Database, tile: Tile): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gmaps_tile_state (tile_id, lat, lng, radius_m)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tile_id) DO NOTHING`
    )
    .bind(tile.tileId, tile.lat, tile.lng, tile.radiusM)
    .run();
}

export async function recordTileResult(db: D1Database, result: TileResult): Promise<void> {
  await db
    .prepare(
      `UPDATE gmaps_tile_state
         SET last_run     = datetime('now'),
             status       = ?,
             result_count = ?,
             last_error   = ?
       WHERE tile_id = ?`
    )
    .bind(result.status, result.places.length, result.error ?? null, result.tileId)
    .run();
}
