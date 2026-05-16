// dinbendon.itsi.xyz — shop query frontend over D1.
//
// Routes:
//   GET /           — search form + result list (LIKE on shop name + optional area filter)
//   GET /shop/:id   — shop detail page with full menu
//   GET /healthz    — DB sanity check
//
// Server-rendered HTML, no client JS. Keep it small.

export interface Env {
  DB: D1Database;
}

const SITE_TITLE = "DinBenDon Browser";
const SOURCE_URL = "https://github.com/changtimwu/dinbendo-exp";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/") return await renderSearch(env, url);
      if (path === "/healthz") return await renderHealth(env);
      const shopMatch = path.match(/^\/shop\/(\d+)\/?$/);
      if (shopMatch) return await renderShop(env, Number(shopMatch[1]));
      return notFound();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Internal error: ${escapeHtml(msg)}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
} satisfies ExportedHandler<Env>;

// ─────────── pages ───────────

async function renderSearch(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const area = (url.searchParams.get("area") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("n")) || 50, 1), 200);

  type Row = {
    id: number;
    name: string;
    address: string | null;
    tel_no: string | null;
    owner_name: string | null;
    last_modified_date: string | null;
    img_count: number;
  };

  let rows: Row[] = [];
  let total: number | null = null;

  if (q || area) {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (q) {
      filters.push("(s.name LIKE ?1 OR s.address LIKE ?1)");
      params.push(`%${q}%`);
    }
    if (area) {
      filters.push("EXISTS (SELECT 1 FROM shop_sent_areas a WHERE a.shop_id = s.id AND a.area = ?2)");
      params.push(area);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const countRes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM shops s ${where}`
    ).bind(...params).first<{ n: number }>();
    total = countRes?.n ?? 0;

    const listRes = await env.DB.prepare(
      `SELECT s.id, s.name, s.address, s.tel_no, s.owner_name, s.last_modified_date,
              COALESCE((SELECT COUNT(*) FROM products p JOIN categories c ON c.id = p.category_id
                        WHERE c.shop_id = s.id AND p.image_url IS NOT NULL), 0) AS img_count
       FROM shops s ${where}
       ORDER BY s.last_modified_date DESC NULLS LAST, s.id DESC
       LIMIT ${limit}`
    ).bind(...params).all<Row>();
    rows = listRes.results ?? [];
  }

  const body = /* html */ `
    <form action="/" method="get" class="search">
      <input type="search" name="q" value="${escapeHtml(q)}" placeholder="店名 / 地址" autofocus />
      <input type="text" name="area" value="${escapeHtml(area)}" placeholder="送達地區 (例: 台北市)" />
      <button type="submit">搜尋</button>
    </form>
    ${
      (q || area)
        ? `<p class="meta">找到 <strong>${total}</strong> 家，顯示前 ${rows.length}。</p>`
        : `<p class="meta">輸入店名、地址，或送達地區開始搜尋。</p>`
    }
    ${
      rows.length
        ? `<ul class="results">${rows.map(rowHtml).join("")}</ul>`
        : (q || area)
        ? `<p class="empty">沒有符合的店家。</p>`
        : ""
    }
  `;

  return html(layout("搜尋店家", body));
}

function rowHtml(r: {
  id: number;
  name: string;
  address: string | null;
  tel_no: string | null;
  owner_name: string | null;
  last_modified_date: string | null;
  img_count: number;
}): string {
  const imgBadge = r.img_count > 0
    ? `<span class="badge" title="${r.img_count} 張產品圖">📷 ${r.img_count}</span>`
    : "";
  return /* html */ `
    <li>
      <a href="/shop/${r.id}" class="name">${escapeHtml(r.name)}</a> ${imgBadge}
      <div class="addr">${escapeHtml(r.address ?? "—")}</div>
      <div class="meta">
        ${r.tel_no ? `☎ ${escapeHtml(r.tel_no)}` : ""}
        ${r.owner_name ? ` · ${escapeHtml(r.owner_name)}` : ""}
        ${r.last_modified_date ? ` · 更新 ${escapeHtml(r.last_modified_date)}` : ""}
        · id ${r.id}
      </div>
    </li>
  `;
}

async function renderShop(env: Env, id: number): Promise<Response> {
  type ShopRow = {
    id: number; name: string; description: string | null; url: string | null;
    tel_no: string | null; fax_no: string | null; address: string | null;
    lat: number | null; lng: number | null;
    last_modified_date: string | null; owner_name: string | null;
    notice: string | null; public_notice: string | null;
  };
  const shop = await env.DB.prepare(
    `SELECT id, name, description, url, tel_no, fax_no, address, lat, lng,
            last_modified_date, owner_name, notice, public_notice
     FROM shops WHERE id = ?1`
  ).bind(id).first<ShopRow>();

  if (!shop) return notFound();

  type AreaRow = { area: string };
  type SvcRow = { service_type: string };
  type CatRow = { id: number; name: string | null; position: number };
  type ProdRow = {
    id: number; category_id: number; name: string | null; position: number;
    image_url: string | null; image_thumbnail_url: string | null;
  };
  type VarRow = { product_id: number; name: string | null; price: number | null; position: number };

  const [areas, svcs, cats, prods, vars_] = await Promise.all([
    env.DB.prepare(`SELECT area FROM shop_sent_areas WHERE shop_id = ?1 ORDER BY LENGTH(area) DESC, area`).bind(id).all<AreaRow>(),
    env.DB.prepare(`SELECT service_type FROM shop_service_types WHERE shop_id = ?1 ORDER BY service_type`).bind(id).all<SvcRow>(),
    env.DB.prepare(`SELECT id, name, position FROM categories WHERE shop_id = ?1 ORDER BY position`).bind(id).all<CatRow>(),
    env.DB.prepare(
      `SELECT p.id, p.category_id, p.name, p.position, p.image_url, p.image_thumbnail_url
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE c.shop_id = ?1 ORDER BY c.position, p.position`
    ).bind(id).all<ProdRow>(),
    env.DB.prepare(
      `SELECT v.product_id, v.name, v.price, v.position
       FROM variations v JOIN products p ON p.id = v.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE c.shop_id = ?1 ORDER BY v.product_id, v.position`
    ).bind(id).all<VarRow>(),
  ]);

  const varsByProd = new Map<number, VarRow[]>();
  for (const v of vars_.results ?? []) {
    const arr = varsByProd.get(v.product_id) ?? [];
    arr.push(v);
    varsByProd.set(v.product_id, arr);
  }
  const prodsByCat = new Map<number, ProdRow[]>();
  for (const p of prods.results ?? []) {
    const arr = prodsByCat.get(p.category_id) ?? [];
    arr.push(p);
    prodsByCat.set(p.category_id, arr);
  }

  const totalProducts = (prods.results ?? []).length;
  const imgUrls = (prods.results ?? []).filter(p => p.image_url).map(p => p.image_url!);
  const isMenuImagePattern =
    imgUrls.length > 0 && imgUrls.length <= 2 && imgUrls.length / Math.max(totalProducts, 1) <= 0.15;

  const menuImagesBlock = imgUrls.length
    ? /* html */ `
      <section class="images">
        <h2>${isMenuImagePattern ? "菜單照片" : "產品照片"}</h2>
        <div class="image-grid">
          ${imgUrls.map(u => `<a href="https://dinbendon.net${escapeAttr(u)}" target="_blank" rel="noopener"><img loading="lazy" src="https://dinbendon.net${escapeAttr(u)}" alt="" /></a>`).join("")}
        </div>
      </section>` : "";

  const tags = [
    ...(svcs.results ?? []).map(s => s.service_type),
  ];

  const visibleAreas = (areas.results ?? [])
    .map(a => a.area)
    .filter(a => a.length >= 2)
    .slice(0, 20);

  const menuBlock = (cats.results ?? []).map(cat => {
    const items = prodsByCat.get(cat.id) ?? [];
    if (!items.length) return "";
    return /* html */ `
      <section class="cat">
        <h3>${escapeHtml(cat.name ?? "—")}</h3>
        <ul class="items">
          ${items.map(p => {
            const vs = varsByProd.get(p.id) ?? [];
            const priceCell = vs.length === 1 && (!vs[0].name)
              ? formatPrice(vs[0].price)
              : vs.length
              ? vs.map(v => `<span class="var">${escapeHtml(v.name ?? "")} ${formatPrice(v.price)}</span>`).join("")
              : "";
            const img = p.image_thumbnail_url
              ? `<img class="thumb" loading="lazy" src="https://dinbendon.net${escapeAttr(p.image_thumbnail_url)}" alt="" />`
              : "";
            return `<li>${img}<span class="pname">${escapeHtml(p.name ?? "")}</span><span class="prices">${priceCell}</span></li>`;
          }).join("")}
        </ul>
      </section>
    `;
  }).join("");

  const body = /* html */ `
    <p><a href="/" class="back">← 搜尋</a></p>
    <header class="shop-head">
      <h1>${escapeHtml(shop.name)}</h1>
      ${shop.description ? `<p class="subtitle">${escapeHtml(shop.description)}</p>` : ""}
      <dl class="facts">
        ${shop.address ? `<dt>地址</dt><dd>${escapeHtml(shop.address)}${shop.lat && shop.lng ? ` <a href="https://www.google.com/maps/search/?api=1&query=${shop.lat},${shop.lng}" target="_blank" rel="noopener">地圖</a>` : ""}</dd>` : ""}
        ${shop.tel_no ? `<dt>電話</dt><dd>${escapeHtml(shop.tel_no)}</dd>` : ""}
        ${shop.fax_no ? `<dt>傳真</dt><dd>${escapeHtml(shop.fax_no)}</dd>` : ""}
        ${shop.url ? `<dt>網址</dt><dd><a href="${escapeAttr(shop.url)}" target="_blank" rel="noopener">${escapeHtml(shop.url)}</a></dd>` : ""}
        ${tags.length ? `<dt>類型</dt><dd>${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</dd>` : ""}
        ${visibleAreas.length ? `<dt>送達</dt><dd>${visibleAreas.map(a => `<a class="tag" href="/?area=${encodeURIComponent(a)}">${escapeHtml(a)}</a>`).join(" ")}</dd>` : ""}
        ${shop.notice ? `<dt>備註</dt><dd class="notice">${escapeMultiline(shop.notice)}</dd>` : ""}
        ${shop.public_notice ? `<dt>公告</dt><dd class="notice">${escapeMultiline(shop.public_notice)}</dd>` : ""}
        ${shop.last_modified_date ? `<dt>更新</dt><dd>${escapeHtml(shop.last_modified_date)}${shop.owner_name ? ` · by ${escapeHtml(shop.owner_name)}` : ""}</dd>` : ""}
        <dt>shopId</dt><dd>${shop.id} · <a href="https://dinbendon.net/do/idine?shop=${shop.id}" target="_blank" rel="noopener">官方頁面</a></dd>
      </dl>
    </header>
    ${menuImagesBlock}
    ${menuBlock || `<p class="empty">沒有菜單資料。</p>`}
  `;
  return html(layout(shop.name, body));
}

async function renderHealth(env: Env): Promise<Response> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM shops`).first<{ n: number }>();
  return new Response(JSON.stringify({ ok: true, shops: r?.n ?? 0 }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(): Response {
  return new Response(layout("404", `<p>Not found.</p><p><a href="/">← 回首頁</a></p>`), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ─────────── helpers ───────────

function html(s: string): Response {
  return new Response(s, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `<span class="price">$${p}</span>`;
}

function layout(title: string, body: string): string {
  return /* html */ `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — ${SITE_TITLE}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", system-ui, sans-serif; margin: 0; padding: 0; }
  main { max-width: 880px; margin: 0 auto; padding: 1rem 1.2rem 4rem; }
  h1, h2, h3 { line-height: 1.25; margin: .8em 0 .4em; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.2rem; }
  h3 { font-size: 1.05rem; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding-bottom: .25em; }
  a { color: #0a66c2; text-decoration: none; }
  a:hover { text-decoration: underline; }
  header.brand { padding: .9rem 1.2rem; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  header.brand a { color: inherit; font-weight: 600; }
  header.brand small { color: #666; margin-left: .6em; font-weight: normal; }
  form.search { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  form.search input { flex: 1 1 14rem; padding: .55rem .7rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
  form.search input[name="area"] { flex: 0 1 14rem; }
  form.search button { padding: .55rem 1rem; border: 0; border-radius: 6px; background: #0a66c2; color: white; font-size: 1rem; cursor: pointer; }
  .meta { color: #666; font-size: .92em; }
  .empty { color: #888; padding: 2em 0; text-align: center; }
  ul.results { list-style: none; padding: 0; margin: 0; }
  ul.results li { padding: .7rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
  ul.results li .name { font-size: 1.05rem; font-weight: 600; }
  ul.results li .addr { color: #555; font-size: .92em; }
  ul.results li .meta { font-size: .85em; }
  .badge { display: inline-block; background: #fff2cf; color: #a36b00; border-radius: 999px; padding: 0 .55em; font-size: .75em; margin-left: .3em; vertical-align: 1px; }
  @media (prefers-color-scheme: dark) {
    body { background: #15171c; color: #e7e9ee; }
    a { color: #7eb6ff; }
    form.search input { background: #0c0d11; color: inherit; border-color: #2a2c33; }
    .badge { background: #4a3b14; color: #f3c463; }
    header.brand { border-bottom-color: #2a2c33; }
    ul.results li { border-bottom-color: #2a2c33; }
  }
  .shop-head { margin-bottom: 1.2rem; }
  .subtitle { color: #555; margin-top: 0; }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: .6rem 0 0; }
  dl.facts dt { color: #666; font-size: .9em; padding-top: .15em; }
  dl.facts dd { margin: 0; }
  .tag { display: inline-block; background: #eef3fa; color: #244c7a; padding: .12em .55em; border-radius: 4px; font-size: .85em; margin: 0 .15em .15em 0; }
  @media (prefers-color-scheme: dark) {
    .tag { background: #1f2b3d; color: #9ec4ff; }
    .subtitle, dl.facts dt { color: #aab2c0; }
  }
  .notice { white-space: pre-wrap; font-size: .92em; color: #555; }
  @media (prefers-color-scheme: dark) { .notice { color: #b9bfca; } }
  .image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: .5rem; }
  .image-grid img { width: 100%; height: 140px; object-fit: cover; border-radius: 8px; background: #eee; }
  section.cat { margin-top: 1.2rem; }
  ul.items { list-style: none; padding: 0; margin: 0; }
  ul.items li { display: grid; grid-template-columns: 48px 1fr auto; gap: .6rem; align-items: center; padding: .4rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 7%, transparent); }
  ul.items li:has(:not(.thumb)) { grid-template-columns: 48px 1fr auto; }
  ul.items li:not(:has(.thumb)) { grid-template-columns: 1fr auto; }
  ul.items .thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; }
  ul.items .pname { font-size: .95em; }
  ul.items .prices { text-align: right; font-variant-numeric: tabular-nums; color: #444; }
  ul.items .var { display: inline-block; margin-left: .6em; font-size: .9em; }
  .price { font-weight: 600; color: #0a66c2; }
  @media (prefers-color-scheme: dark) {
    ul.items .prices { color: #c4c8d2; }
    .price { color: #7eb6ff; }
  }
  footer { padding: 1.5rem 1.2rem 2.5rem; text-align: center; color: #888; font-size: .85em; }
  .back { font-size: .9em; color: #666; }
</style>
</head>
<body>
<header class="brand"><a href="/">${escapeHtml(SITE_TITLE)}</a><small>dinbendon.net 公開資料瀏覽</small></header>
<main>${body}</main>
<footer>data 來源於 dinbendon.net · <a href="${SOURCE_URL}">source</a></footer>
</body>
</html>`;
}
