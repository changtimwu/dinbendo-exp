// dinbendon-gmaps-scraper — fans Google Maps tile scrapes across
// Browser Rendering sessions, writes results into the same D1 the
// user-facing worker reads from.
//
// Triggers:
//   - cron (weekly): enqueue stale tiles (status != 'ok' OR last_run older than STALE_DAYS).
//   - POST /enqueue?mode=all|stale (header X-Scrape-Key) — manual kick.
//   - GET  /status — counts per status in gmaps_tile_state.
// Queue consumer: drains gmaps-tiles, one tile per message, up to 5
// concurrent Browser Rendering sessions.

import { type BrowserWorker } from '@cloudflare/puppeteer';
import { generateTiles, type Tile } from './tiles';
import { debugTile, scrapeTile } from './scrape';
import { recordTileResult, upsertPlaces } from './upsert';

export interface Env {
  DB: D1Database;
  BROWSER: BrowserWorker;
  TILE_QUEUE: Queue<Tile>;
  STALE_DAYS: string;
  TILE_RADIUS_M: string;
  SCRAPE_KEY?: string; // set via `wrangler secret put SCRAPE_KEY`
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/status') return await renderStatus(env);
    if (url.pathname === '/debug') {
      if (!env.SCRAPE_KEY || req.headers.get('x-scrape-key') !== env.SCRAPE_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const lat = Number(url.searchParams.get('lat') ?? 25.04);
      const lng = Number(url.searchParams.get('lng') ?? 121.55);
      const data = await debugTile(env.BROWSER, lat, lng);
      return Response.json(data);
    }
    if (url.pathname === '/enqueue' && req.method === 'POST') {
      if (!env.SCRAPE_KEY || req.headers.get('x-scrape-key') !== env.SCRAPE_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const mode = url.searchParams.get('mode') === 'all' ? 'all' : 'stale';
      const limit = Number(url.searchParams.get('limit')) || 0;
      const n = await enqueue(env, mode, limit);
      return Response.json({ enqueued: n, mode, limit: limit || null });
    }
    return new Response('dinbendon-gmaps-scraper\n', {
      headers: { 'content-type': 'text/plain' },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enqueue(env, 'stale').then((n) => console.log(`[cron] enqueued ${n} stale tiles`)));
  },

  async queue(batch: MessageBatch<Tile>, env: Env): Promise<void> {
    // max_batch_size is 1 in wrangler.jsonc, so this loop runs once
    // per invocation in steady state. The loop is for safety only.
    for (const msg of batch.messages) {
      const tile = msg.body;
      const t0 = Date.now();
      try {
        const result = await scrapeTile(env.BROWSER, tile);
        if (result.places.length > 0) {
          await upsertPlaces(env.DB, result.places);
        }
        await recordTileResult(env.DB, result);
        console.log(
          `[tile] ${tile.tileId} status=${result.status} places=${result.places.length} ms=${Date.now() - t0}`
        );
        msg.ack();
      } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        console.log(`[tile] ${tile.tileId} FAIL ${e}`);
        // Record failure but don't retry forever — wrangler.jsonc caps
        // max_retries at 1; after that it lands in the DLQ.
        await recordTileResult(env.DB, {
          tileId: tile.tileId,
          status: 'error',
          places: [],
          error: e,
        }).catch(() => {});
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, Tile>;

// ─────────── enqueue logic ───────────

async function enqueue(env: Env, mode: 'all' | 'stale', limit = 0): Promise<number> {
  const tiles = generateTiles(Number(env.TILE_RADIUS_M) || 500);
  // Make sure every grid cell has a row in gmaps_tile_state so we can
  // filter on last_run / status below.
  await seedTileRows(env.DB, tiles);

  let targets = mode === 'all' ? tiles : await pickStaleTiles(env.DB, tiles, Number(env.STALE_DAYS) || 30);
  if (limit > 0) targets = targets.slice(0, limit);
  // Queue.sendBatch caps at 100 messages per call.
  for (let i = 0; i < targets.length; i += 100) {
    await env.TILE_QUEUE.sendBatch(targets.slice(i, i + 100).map((body) => ({ body })));
  }
  return targets.length;
}

async function seedTileRows(db: D1Database, tiles: Tile[]): Promise<void> {
  // Batch the INSERT-OR-IGNORE so we don't pay one RTT per tile.
  const stmt = db.prepare(
    `INSERT INTO gmaps_tile_state (tile_id, lat, lng, radius_m)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tile_id) DO NOTHING`
  );
  for (let i = 0; i < tiles.length; i += 100) {
    await db.batch(
      tiles.slice(i, i + 100).map((t) => stmt.bind(t.tileId, t.lat, t.lng, t.radiusM))
    );
  }
}

async function pickStaleTiles(db: D1Database, tiles: Tile[], staleDays: number): Promise<Tile[]> {
  // Pull tile_ids that are unrun, errored, blocked, or older than the
  // staleness window. We then intersect with the in-memory grid so an
  // expanded bbox doesn't quietly leave old tiles behind.
  const rows = await db
    .prepare(
      `SELECT tile_id FROM gmaps_tile_state
        WHERE last_run IS NULL
           OR status IN ('error','blocked')
           OR last_run < datetime('now', ?1)`
    )
    .bind(`-${staleDays} days`)
    .all<{ tile_id: string }>();
  const staleIds = new Set((rows.results ?? []).map((r) => r.tile_id));
  return tiles.filter((t) => staleIds.has(t.tileId));
}

async function renderStatus(env: Env): Promise<Response> {
  const counts = await env.DB.prepare(
    `SELECT COALESCE(status,'pending') AS status, COUNT(*) AS n
       FROM gmaps_tile_state
      GROUP BY status`
  ).all<{ status: string; n: number }>();
  const shops = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM shops WHERE source = 'gmaps'`
  ).first<{ n: number }>();
  return Response.json({
    tiles: counts.results ?? [],
    gmaps_shops: shops?.n ?? 0,
  });
}
