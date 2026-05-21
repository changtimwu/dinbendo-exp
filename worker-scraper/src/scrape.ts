// Drive one Browser Rendering session against Google Maps for a
// single tile. Returns the extracted places + a status code.
//
// Design notes:
// - Coordinate clicks aren't needed; the search URL params do the work.
// - One browser session per tile keeps blast radius small if a tile
//   trips a captcha — we close and move on, never click through.
// - All in-page DOM work is one page.evaluate call so we minimize
//   round-trips between the Worker and the browser.

import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import type { Tile } from './tiles';
import { DEBUG_FN_BODY, EXTRACT_FN_BODY, ScrapedPlace, isBlockedUrl } from './parse';

export type TileStatus = 'ok' | 'blocked' | 'error' | 'empty';

export interface TileResult {
  tileId: string;
  status: TileStatus;
  places: ScrapedPlace[];
  error?: string;
}

const MAPS_URL = (lat: number, lng: number) =>
  `https://www.google.com/maps/search/restaurants/@${lat},${lng},17z?hl=en`;

// Max scroll passes per tile. End-of-list sentinel usually appears
// within 4-6 scrolls at this zoom; cap to avoid runaway sessions.
const MAX_SCROLLS = 8;

const SCROLL_FN_BODY = `
(() => {
  const feed = document.querySelector('[role="feed"]');
  if (!feed) return { done: true };
  feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' });
  const endText = feed.textContent || '';
  return { done: /You've reached the end of the list|您已到達清單結尾/.test(endText) };
})();
`;

// One-shot debug: scrape a tile and return raw card-level info instead
// of upserting. Caller renders it as JSON. Don't use for production paths.
export async function debugTile(browserBinding: BrowserWorker, lat: number, lng: number): Promise<unknown> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(browserBinding);
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 1800 });
    const url = `https://www.google.com/maps/search/restaurants/@${lat},${lng},17z?hl=en`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.waitForSelector('[role="feed"]', { timeout: 15_000 }); } catch { /* fall through */ }
    return await page.evaluate(DEBUG_FN_BODY);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

export async function scrapeTile(
  browserBinding: BrowserWorker,
  tile: Tile,
): Promise<TileResult> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(browserBinding);
    const page = await browser.newPage();
    // English locale gives stable selectors and predictable hour strings.
    // The realistic UA matters: HeadlessChrome's default UA causes Maps
    // to serve a stripped card layout without review count / price.
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.7' });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 1800 });

    const url = MAPS_URL(tile.lat, tile.lng);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (resp && isBlockedUrl(resp.url())) {
      return { tileId: tile.tileId, status: 'blocked', places: [], error: `redirected to ${resp.url()}` };
    }

    // Feed appears only after Maps decides the URL was a list query.
    try {
      await page.waitForSelector('[role="feed"]', { timeout: 15_000 });
    } catch {
      // Could be zero results, or could be the single-place layout.
      if (isBlockedUrl(page.url())) {
        return { tileId: tile.tileId, status: 'blocked', places: [], error: 'no feed + blocked URL' };
      }
      return { tileId: tile.tileId, status: 'empty', places: [] };
    }

    // Scroll the feed until end-of-list sentinel appears or we hit MAX_SCROLLS.
    // String-form evaluate keeps the in-page code outside TS's type universe
    // (DOM globals aren't visible here otherwise — same trick as EXTRACT_FN_BODY).
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const more = (await page.evaluate(SCROLL_FN_BODY)) as { done: boolean };
      if (more.done) break;
      // Let lazy-load fire. Maps' result feed paginates on scroll.
      await new Promise((r) => setTimeout(r, 800));
    }

    const result = (await page.evaluate(EXTRACT_FN_BODY)) as
      | { ok: false; reason: string }
      | { ok: true; places: ScrapedPlace[] };

    if (!result.ok) {
      return { tileId: tile.tileId, status: 'empty', places: [], error: result.reason };
    }
    if (result.places.length === 0) {
      return { tileId: tile.tileId, status: 'empty', places: [] };
    }
    return { tileId: tile.tileId, status: 'ok', places: result.places };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tileId: tile.tileId, status: 'error', places: [], error: msg };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* session may already be gone */ }
    }
  }
}
