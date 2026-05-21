// Extraction logic for Google Maps search-results cards.
//
// Runs *inside* the browser (serialized via puppeteer's page.evaluate).
// Keep it dependency-free and tolerant: Maps' DOM mutates often, so
// we lean on role/href patterns rather than CSS-module class names.
//
// Card container: div[role="article"] inside the [role="feed"] scroller.
// Don't use a.closest('[jsaction]') — the anchor itself has jsaction.

export interface ScrapedPlace {
  external_id: string;          // ChIJ… place id, or hex feature id as fallback
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  rating_count: number | null;
  price_level: number | null;   // 1..4 — from $-glyph count, or NT$ band bucket
  primary_type: string | null;
  hours_summary: string | null; // e.g. "Open · Closes 10 PM"
}

// In-page extractor. Passed as a string to page.evaluate() so DOM
// globals don't have to leak into TS's type universe.
export const EXTRACT_FN_BODY = `
(() => {
  const feed = document.querySelector('[role="feed"]');
  if (!feed) return { ok: false, reason: 'no-feed' };

  const cards = Array.from(feed.querySelectorAll('div[role="article"]'));
  const seen = new Set();
  const out = [];

  for (const card of cards) {
    const anchor = card.querySelector('a[href*="/maps/place/"]');
    if (!anchor) continue;
    const href = anchor.getAttribute('href') || '';

    // Modern Place ID lives in !19s; the !1s hex form is a feature id
    // (still globally unique, used as fallback when !19s is absent).
    const m19 = href.match(/!19s([^!?]+)/);
    const m1s = href.match(/!1s([^!?]+)/);
    const external_id = (m19 && decodeURIComponent(m19[1])) || (m1s && decodeURIComponent(m1s[1])) || null;
    if (!external_id || seen.has(external_id)) continue;
    seen.add(external_id);

    const name = card.getAttribute('aria-label') || (anchor.getAttribute('aria-label') || '');
    if (!name) continue;

    // Lat/lng live in the place URL as !3d<lat>!4d<lng>.
    let lat = null, lng = null;
    const ll = href.match(/!3d(-?[0-9.]+)!4d(-?[0-9.]+)/);
    if (ll) { lat = parseFloat(ll[1]); lng = parseFloat(ll[2]); }

    // Maps nests .W4Efsd inside .W4Efsd — the outer wrapper's
    // textContent is the concatenation of all child rows. Iterate
    // leaves only so each \`line\` is one logical row.
    const lines = [];
    card.querySelectorAll('.W4Efsd').forEach((row) => {
      if (row.querySelector('.W4Efsd')) return;
      const t = (row.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t) lines.push(t);
    });

    // Rating: aria-label of the rating span is reliable across locales
    // for the score itself ("4.6 stars" / "4.6 顆星"). Review count and
    // price level only appear in the richer card layout (gated by a
    // realistic user-agent) so we parse them from visible lines when
    // present and leave them null otherwise.
    let rating = null, rating_count = null, price_level = null;
    const ratingEl = card.querySelector('span[role="img"][aria-label]');
    if (ratingEl) {
      const al = ratingEl.getAttribute('aria-label') || '';
      const mr = al.match(/([0-9]+\\.[0-9])/);
      if (mr) rating = parseFloat(mr[1]);
    }
    // Rich layout: a line like "4.9(4,921) · $400–600". Use it to
    // backfill rating + count + price; harmless if absent.
    const ratingLine = lines.find((l) => /^[0-9]+\\.[0-9]\\s*\\(/.test(l));
    if (ratingLine) {
      if (rating === null) {
        const mr = ratingLine.match(/^([0-9]+\\.[0-9])/);
        if (mr) rating = parseFloat(mr[1]);
      }
      const mc = ratingLine.match(/\\(([0-9,]+)\\)/);
      if (mc) rating_count = parseInt(mc[1].replace(/,/g, ''), 10);
      const band = ratingLine.match(/\\$([0-9]+)/);
      const glyph = ratingLine.match(/(\\$+)(?!\\w)/);
      if (band) {
        const v = parseInt(band[1], 10);
        price_level = v <= 200 ? 1 : v <= 500 ? 2 : v <= 1000 ? 3 : 4;
      } else if (glyph && glyph[1].length <= 4) {
        price_level = glyph[1].length;
      }
    }

    // Hours: line containing Open/Closed/Opens/Closes/24 hours.
    let hours_summary = null;
    for (const l of lines) {
      if (/\\b(Open|Closed|Opens|Closes|24 hours)\\b/i.test(l)) { hours_summary = l; break; }
    }

    // Type · Address row: split on '·'. Skip rating-row (starts "4.9…")
    // and hours rows. First text part is the cuisine type; last is address.
    let primary_type = null, address = null;
    for (const l of lines) {
      if (!l.includes('·')) continue;
      if (/^[0-9]+\\.[0-9]/.test(l)) continue;
      if (/\\b(Open|Closed|Opens|Closes)\\b/i.test(l)) continue;
      const parts = l.split('·').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        primary_type = parts[0];
        address = parts[parts.length - 1];
        break;
      }
    }

    out.push({
      external_id,
      name: name.trim(),
      address,
      lat,
      lng,
      rating,
      rating_count,
      price_level,
      primary_type,
      hours_summary,
    });
  }

  return { ok: true, places: out };
})();
`;

// Debug variant: returns the raw .W4Efsd lines + rating element
// aria-label for the first few cards. Used by /debug to diagnose
// locale / DOM differences in the Browser Rendering environment.
export const DEBUG_FN_BODY = `
(() => {
  const feed = document.querySelector('[role="feed"]');
  if (!feed) return { ok: false, reason: 'no-feed' };
  const cards = Array.from(feed.querySelectorAll('div[role="article"]')).slice(0, 3);
  return {
    ok: true,
    pageUrl: location.href,
    lang: document.documentElement.lang || null,
    cards: cards.map((card) => {
      const lines = [];
      card.querySelectorAll('.W4Efsd').forEach((row) => {
        if (row.querySelector('.W4Efsd')) return;
        const t = (row.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) lines.push(t);
      });
      const ratingEl = card.querySelector('span[role="img"][aria-label*="stars"], span[role="img"][aria-label*="星"]');
      return {
        name: card.getAttribute('aria-label'),
        ratingAria: ratingEl ? ratingEl.getAttribute('aria-label') : null,
        ratingClassEl: !!card.querySelector('.ZkP5Je, .MW4etd'),
        firstSpanWithStars: (() => {
          for (const s of card.querySelectorAll('span[aria-label]')) {
            const al = s.getAttribute('aria-label') || '';
            if (/\\d.*?(star|stars|星|顆星|則評論|Reviews|reviews)/i.test(al)) return al;
          }
          return null;
        })(),
        lines,
        textSample: (card.textContent || '').slice(0, 240),
      };
    }),
  };
})();
`;

// Captcha / consent / login interstitials — treat as hard stop for the tile.
export function isBlockedUrl(url: string): boolean {
  return (
    url.includes('/sorry/') ||
    url.includes('consent.google.com') ||
    url.includes('accounts.google.com/ServiceLogin') ||
    url.includes('captcha')
  );
}
