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
  AI: Ai;
}

const SITE_TITLE = "DinBenDon Browser";
const SOURCE_URL = "https://github.com/changtimwu/dinbendo-exp";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/") return await renderSearch(env, url);
      if (path === "/ask") return await renderAsk(env, url);
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
    <form action="/ask" method="get" class="ask-on-home">
      <label>✨ 自然語言搜尋</label>
      <div class="ask-row">
        <input type="search" name="q" placeholder="例：cheapest 便當 in 內湖" />
        <button type="submit">問</button>
      </div>
      <p class="hint">用一句話描述你想找的東西 — 模型會幫你翻譯地名 (Da'an → 大安) 與菜色。</p>
    </form>
    <form action="/" method="get" class="search">
      <input type="search" name="q" value="${escapeHtml(q)}" placeholder="店名 / 地址" />
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
  dist_km?: number;
}): string {
  const imgBadge = r.img_count > 0
    ? `<span class="badge" title="${r.img_count} 張產品圖">📷 ${r.img_count}</span>`
    : "";
  const distBadge = r.dist_km != null
    ? `<span class="badge dist">${r.dist_km.toFixed(2)} km</span>`
    : "";
  return /* html */ `
    <li>
      <a href="/shop/${r.id}" class="name">${escapeHtml(r.name)}</a> ${imgBadge}${distBadge}
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

// ─────────── /ask — natural-language search ───────────

type ParsedIntent = {
  item_keywords: string[];
  area: string | null;
  near_landmark: string | null;  // raw landmark text (MRT station, building, etc.) for geocoding
  service_type: string | null;
  sort_by: "price_asc" | "price_desc" | "newest" | "relevance";
  max_price: number | null;
  result_grain: "product" | "shop";
  limit: number;
  rationale: string;
};

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    item_keywords: { type: "array", items: { type: "string" } },
    area: { type: ["string", "null"] },
    near_landmark: { type: ["string", "null"] },
    service_type: { type: ["string", "null"] },
    sort_by: { type: "string", enum: ["price_asc", "price_desc", "newest", "relevance"] },
    max_price: { type: ["number", "null"] },
    result_grain: { type: "string", enum: ["product", "shop"] },
    limit: { type: "number" },
    rationale: { type: "string" },
  },
  required: [
    "item_keywords", "area", "near_landmark", "service_type", "sort_by",
    "max_price", "result_grain", "limit", "rationale",
  ],
  additionalProperties: false,
};

const PROXIMITY_RADIUS_KM = 1.5;
const NL_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const NOMINATIM_UA = "dinbendon.itsi.xyz (https://dinbendon.itsi.xyz; https://github.com/changtimwu/dinbendo-exp)";

const SERVICE_TYPES = ["便當", "中式", "麵食", "飲料", "小吃", "日式", "其他", "甜點", "南洋", "西式"] as const;
const SORTS = ["price_asc", "price_desc", "newest", "relevance"] as const;

async function parseIntent(env: Env, query: string): Promise<ParsedIntent> {
  const system = [
    "You parse food-delivery search queries for a Taiwanese platform into JSON.",
    "The platform's data is in Traditional Chinese. When the user uses English names for places or dishes, translate to the Taiwanese term. Examples: Da'an → 大安, Xinyi → 信義, Songshan → 松山, Neihu → 內湖, soup dumplings → 小籠包, lunchbox → 便當, bubble tea → 珍珠奶茶, fried rice → 炒飯.",
    `Service types available: ${SERVICE_TYPES.join(", ")}.`,
    "Fields:",
    "  area:           a Taipei-area district / city name from the delivery list (e.g. 大安, 內湖, 台北市). Use ONLY for broad districts. Leave null if the user named something more specific (an MRT station, building, road, university, etc.).",
    "  near_landmark:  a specific landmark string suitable for geocoding (e.g. \"古亭站\", \"台北車站\", \"台灣大學\", \"信義誠品\", \"101\"). Use whenever the user mentions a station, building, university, road, or other point of interest — even if you also recognize a containing district.",
    "  item_keywords:  dish names (e.g. \"炒飯\", \"小籠包\"). Empty for restaurant-level queries.",
    "  result_grain:   \"product\" if a specific dish is named, otherwise \"shop\".",
    "  rationale:      one-line Chinese summary of what you understood (e.g. \"大安最便宜的小籠包\").",
    "  limit:          default 20.",
    "Output only valid JSON.",
    "Examples:",
    'Q: cheapest soup dumplings in Da\'an district',
    'A: {"item_keywords":["小籠包"],"area":"大安","near_landmark":null,"service_type":null,"sort_by":"price_asc","max_price":null,"result_grain":"product","limit":20,"rationale":"大安最便宜的小籠包"}',
    "Q: 古亭站附近的炒飯",
    'A: {"item_keywords":["炒飯"],"area":null,"near_landmark":"古亭站","service_type":null,"sort_by":"relevance","max_price":null,"result_grain":"product","limit":20,"rationale":"古亭站附近的炒飯"}',
    "Q: fried rice near Taipei Main Station",
    'A: {"item_keywords":["炒飯"],"area":null,"near_landmark":"台北車站","service_type":null,"sort_by":"relevance","max_price":null,"result_grain":"product","limit":20,"rationale":"台北車站附近的炒飯"}',
    "Q: 便當 in 內湖 under 100",
    'A: {"item_keywords":[],"area":"內湖","near_landmark":null,"service_type":"便當","sort_by":"price_asc","max_price":100,"result_grain":"shop","limit":20,"rationale":"內湖區、100元以下的便當店"}',
    "Q: 新開的飲料店",
    'A: {"item_keywords":[],"area":null,"near_landmark":null,"service_type":"飲料","sort_by":"newest","max_price":null,"result_grain":"shop","limit":20,"rationale":"最新加入的飲料店"}',
    "Q: 台大附近的咖啡店",
    'A: {"item_keywords":[],"area":null,"near_landmark":"台灣大學","service_type":null,"sort_by":"relevance","max_price":null,"result_grain":"shop","limit":20,"rationale":"台大附近的咖啡店"}',
  ].join("\n");

  const res = await env.AI.run(
    NL_MODEL as keyof AiModels,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: query },
      ],
      response_format: { type: "json_schema", json_schema: INTENT_SCHEMA },
      // Gemma 4 26b is a reasoning model; the response burns tokens on `reasoning`
      // before emitting `content`. Give it room for both.
      max_tokens: 2000,
    } as never,
  ) as unknown as Record<string, unknown>;

  // Extract the text the model produced. Workers AI normalizes responses
  // differently per model family:
  //   - Llama / Mistral instruct → { response: "..." }
  //   - Gemma 4 / OpenAI-style    → { choices: [{ message: { content: "...", reasoning: "..." } }] }
  let text: string | unknown = res?.response;
  if (typeof text !== "string" && Array.isArray(res?.choices)) {
    const choice = (res.choices as Array<{ message?: { content?: unknown; reasoning?: unknown } }>)[0];
    text = choice?.message?.content;
    if (typeof text !== "string" || !text) text = choice?.message?.reasoning;
  }

  let obj: Record<string, unknown> | undefined;
  if (typeof text === "string") {
    try {
      obj = JSON.parse(text);
    } catch {
      // Recover a JSON object embedded in prose (```json … ``` or reasoning trace).
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { obj = JSON.parse(m[0]); } catch { /* fall through */ }
      }
    }
  } else if (text && typeof text === "object") {
    obj = text as Record<string, unknown>;
  }
  if (!obj || typeof obj !== "object") {
    const sample = typeof text === "string" ? text.slice(0, 200) : JSON.stringify(res).slice(0, 200);
    throw new Error(`model returned no JSON: ${sample}`);
  }

  const sort = (SORTS as readonly string[]).includes(obj.sort_by as string)
    ? (obj.sort_by as ParsedIntent["sort_by"])
    : "relevance";
  const grain = obj.result_grain === "product" ? "product" : "shop";
  const items = Array.isArray(obj.item_keywords)
    ? obj.item_keywords.filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
    : [];
  return {
    item_keywords: items,
    area: typeof obj.area === "string" && obj.area.length > 0 ? obj.area : null,
    near_landmark: typeof obj.near_landmark === "string" && obj.near_landmark.length > 0 ? obj.near_landmark : null,
    service_type: typeof obj.service_type === "string" && obj.service_type.length > 0 ? obj.service_type : null,
    sort_by: sort,
    max_price: typeof obj.max_price === "number" && isFinite(obj.max_price) ? obj.max_price : null,
    result_grain: grain,
    limit: Math.min(Math.max(typeof obj.limit === "number" ? obj.limit : 20, 1), 50),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

type Geocode = { lat: number; lng: number; display_name: string };

async function geocode(env: Env, query: string): Promise<Geocode | null> {
  const key = query.trim();
  if (!key) return null;

  // 1. Cache lookup
  const cached = await env.DB.prepare(
    "SELECT lat, lng, display_name FROM geocache WHERE query = ?1"
  ).bind(key).first<{ lat: number | null; lng: number | null; display_name: string | null }>();
  if (cached) {
    if (cached.lat == null || cached.lng == null) return null;
    return { lat: cached.lat, lng: cached.lng, display_name: cached.display_name ?? key };
  }

  // 2. Cache miss → call Nominatim. Country-restricted to Taiwan; one result.
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", key);
  url.searchParams.set("countrycodes", "tw");
  url.searchParams.set("limit", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "0");

  let hit: Geocode | null = null;
  try {
    const r = await fetch(url.toString(), {
      headers: { "user-agent": NOMINATIM_UA, "accept": "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true } as RequestInitCfProperties,
    });
    if (r.ok) {
      const arr = (await r.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      if (Array.isArray(arr) && arr.length > 0) {
        const lat = parseFloat(arr[0].lat);
        const lng = parseFloat(arr[0].lon);
        if (isFinite(lat) && isFinite(lng)) {
          hit = { lat, lng, display_name: arr[0].display_name };
        }
      }
    }
  } catch {
    // network or JSON failure — treat as miss; we'll still cache the null
    // so we don't hammer Nominatim with retries for the same bad term.
  }

  // 3. Save (negative cache included so repeat-misses stay cheap)
  await env.DB.prepare(
    "INSERT OR REPLACE INTO geocache(query, lat, lng, display_name, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)"
  ).bind(
    key,
    hit?.lat ?? null,
    hit?.lng ?? null,
    hit?.display_name ?? null,
    Math.floor(Date.now() / 1000),
  ).run();

  return hit;
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function boundingBox(lat: number, lng: number, radiusKm: number): { latMin: number; latMax: number; lngMin: number; lngMax: number } {
  const dLat = radiusKm / 111;                                  // 1° lat ≈ 111 km
  const dLng = radiusKm / (111 * Math.cos(lat * Math.PI / 180)); // narrows toward the poles
  return { latMin: lat - dLat, latMax: lat + dLat, lngMin: lng - dLng, lngMax: lng + dLng };
}

type Near = { lat: number; lng: number; radiusKm: number };

type ProductRow = {
  shop_id: number;
  shop_name: string;
  address: string | null;
  tel_no: string | null;
  category: string | null;
  product: string | null;
  image_thumbnail_url: string | null;
  price: number | null;
  lat?: number | null;
  lng?: number | null;
  dist_km?: number;
};

async function runProductSearch(db: D1Database, intent: ParsedIntent, near: Near | null): Promise<ProductRow[]> {
  const kws = intent.item_keywords.slice(0, 5);
  if (!kws.length) return [];

  const bindings: unknown[] = [];
  const likeClauses: string[] = [];
  for (const k of kws) {
    bindings.push(`%${k}%`);
    likeClauses.push(`p.name LIKE ?${bindings.length}`);
  }
  const filters: string[] = [`(${likeClauses.join(" OR ")})`];

  if (intent.area) {
    bindings.push(intent.area);
    filters.push(`EXISTS (SELECT 1 FROM shop_sent_areas a WHERE a.shop_id = s.id AND a.area = ?${bindings.length})`);
  }
  if (intent.service_type) {
    bindings.push(intent.service_type);
    filters.push(`EXISTS (SELECT 1 FROM shop_service_types t WHERE t.shop_id = s.id AND t.service_type = ?${bindings.length})`);
  }
  if (intent.max_price !== null) {
    bindings.push(intent.max_price);
    filters.push(`v.price <= ?${bindings.length}`);
  }
  if (near) {
    const bb = boundingBox(near.lat, near.lng, near.radiusKm);
    bindings.push(bb.latMin, bb.latMax, bb.lngMin, bb.lngMax);
    filters.push(`s.lat IS NOT NULL AND s.lat BETWEEN ?${bindings.length - 3} AND ?${bindings.length - 2}`);
    filters.push(`s.lng BETWEEN ?${bindings.length - 1} AND ?${bindings.length}`);
  }

  let orderBy = "s.last_modified_date DESC";
  if (intent.sort_by === "price_asc") orderBy = "(v.price IS NULL), v.price ASC";
  else if (intent.sort_by === "price_desc") orderBy = "(v.price IS NULL), v.price DESC";
  // newest / relevance → date desc (current default)

  // When proximity is active, fetch a wider candidate pool and re-rank by distance in JS.
  const fetchLimit = near ? Math.max(intent.limit * 5, 50) : intent.limit;

  const sql = `
    SELECT s.id AS shop_id, s.name AS shop_name, s.address, s.tel_no,
           c.name AS category, p.name AS product, p.image_thumbnail_url, v.price,
           s.lat, s.lng
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN shops      s ON s.id = c.shop_id
    LEFT JOIN variations v ON v.product_id = p.id
    WHERE ${filters.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT ${fetchLimit}
  `;
  const r = await db.prepare(sql).bind(...bindings).all<ProductRow>();
  const rows = r.results ?? [];
  if (!near) return rows;

  const withDist = rows
    .filter(x => x.lat != null && x.lng != null)
    .map(x => ({ ...x, dist_km: distanceKm(near.lat, near.lng, x.lat!, x.lng!) }))
    .filter(x => x.dist_km! <= near.radiusKm);

  // For "cheapest near X" we want price first, but only among nearby; rows are
  // already in price-asc order from SQL, so a stable filter preserves it. For
  // relevance/newest, sort by distance.
  if (intent.sort_by !== "price_asc" && intent.sort_by !== "price_desc") {
    withDist.sort((a, b) => a.dist_km! - b.dist_km!);
  }
  return withDist.slice(0, intent.limit);
}

type ShopRow = {
  id: number;
  name: string;
  address: string | null;
  tel_no: string | null;
  owner_name: string | null;
  last_modified_date: string | null;
  img_count: number;
  lat?: number | null;
  lng?: number | null;
  dist_km?: number;
};

async function runShopSearch(db: D1Database, intent: ParsedIntent, near: Near | null): Promise<ShopRow[]> {
  const bindings: unknown[] = [];
  const filters: string[] = [];

  if (intent.area) {
    bindings.push(intent.area);
    filters.push(`EXISTS (SELECT 1 FROM shop_sent_areas a WHERE a.shop_id = s.id AND a.area = ?${bindings.length})`);
  }
  if (intent.service_type) {
    bindings.push(intent.service_type);
    filters.push(`EXISTS (SELECT 1 FROM shop_service_types t WHERE t.shop_id = s.id AND t.service_type = ?${bindings.length})`);
  }
  // Keywords on shop grain: match name or address (OR-of-keywords, each keyword OR-of-fields).
  if (intent.item_keywords.length) {
    const parts: string[] = [];
    for (const k of intent.item_keywords.slice(0, 5)) {
      bindings.push(`%${k}%`);
      parts.push(`s.name LIKE ?${bindings.length}`);
      bindings.push(`%${k}%`);
      parts.push(`s.address LIKE ?${bindings.length}`);
    }
    filters.push(`(${parts.join(" OR ")})`);
  }
  if (near) {
    const bb = boundingBox(near.lat, near.lng, near.radiusKm);
    bindings.push(bb.latMin, bb.latMax, bb.lngMin, bb.lngMax);
    filters.push(`s.lat IS NOT NULL AND s.lat BETWEEN ?${bindings.length - 3} AND ?${bindings.length - 2}`);
    filters.push(`s.lng BETWEEN ?${bindings.length - 1} AND ?${bindings.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orderBy = "s.last_modified_date DESC";
  const fetchLimit = near ? Math.max(intent.limit * 5, 50) : intent.limit;

  const sql = `
    SELECT s.id, s.name, s.address, s.tel_no, s.owner_name, s.last_modified_date,
           s.lat, s.lng,
           COALESCE((SELECT COUNT(*) FROM products p JOIN categories c ON c.id = p.category_id
                     WHERE c.shop_id = s.id AND p.image_url IS NOT NULL), 0) AS img_count
    FROM shops s
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${fetchLimit}
  `;
  const r = await db.prepare(sql).bind(...bindings).all<ShopRow>();
  const rows = r.results ?? [];
  if (!near) return rows;

  return rows
    .filter(x => x.lat != null && x.lng != null)
    .map(x => ({ ...x, dist_km: distanceKm(near.lat, near.lng, x.lat!, x.lng!) }))
    .filter(x => x.dist_km! <= near.radiusKm)
    .sort((a, b) => a.dist_km! - b.dist_km!)
    .slice(0, intent.limit);
}

function askFormHtml(q: string): string {
  return /* html */ `
    <p><a href="/" class="back">← 結構化搜尋</a></p>
    <form action="/ask" method="get" class="ask-page">
      <input type="search" name="q" value="${escapeHtml(q)}" placeholder="例：cheapest 便當 in 內湖" autofocus />
      <button type="submit">問</button>
    </form>
  `;
}

function intentBlockHtml(intent: ParsedIntent, geo: Geocode | null): string {
  const chips: string[] = [];
  if (intent.item_keywords.length) chips.push("關鍵字: " + intent.item_keywords.join(", "));
  if (intent.area) chips.push("地區: " + intent.area);
  if (intent.near_landmark) {
    chips.push(geo
      ? `📍 ${intent.near_landmark} (${PROXIMITY_RADIUS_KM}km)`
      : `📍 ${intent.near_landmark} (找不到位置)`);
  }
  if (intent.service_type) chips.push("類型: " + intent.service_type);
  if (intent.max_price !== null) chips.push("≤ $" + intent.max_price);
  if (intent.sort_by === "price_asc") chips.push("最便宜");
  else if (intent.sort_by === "price_desc") chips.push("最貴");
  else if (intent.sort_by === "newest") chips.push("最新");
  const geoLine = geo
    ? `<div class="geo">📍 <small>${escapeHtml(geo.display_name)}</small></div>`
    : intent.near_landmark
      ? `<div class="geo geo-miss">⚠️ <small>「${escapeHtml(intent.near_landmark)}」找不到座標，已忽略附近條件</small></div>`
      : "";
  return /* html */ `
    <div class="intent">
      <div><span class="label">✨ 理解為：</span><strong>${escapeHtml(intent.rationale || "(沒有 rationale)")}</strong></div>
      ${chips.length ? `<div class="chips">${chips.map(c => `<span class="chip">${escapeHtml(c)}</span>`).join("")}</div>` : ""}
      ${geoLine}
    </div>
  `;
}

function productRowHtml(r: ProductRow): string {
  const thumb = r.image_thumbnail_url
    ? `<img class="thumb" loading="lazy" src="https://dinbendon.net${escapeAttr(r.image_thumbnail_url)}" alt="" />`
    : `<span class="thumb thumb-empty"></span>`;
  const dist = r.dist_km != null
    ? `<span class="dist-inline">${r.dist_km.toFixed(2)} km</span>`
    : "";
  return /* html */ `
    <li class="product">
      ${thumb}
      <div class="pinfo">
        <div class="pname">${escapeHtml(r.product ?? "—")}</div>
        <div class="pmeta">
          <a href="/shop/${r.shop_id}">${escapeHtml(r.shop_name)}</a>
          ${r.category ? ` · ${escapeHtml(r.category)}` : ""}
          ${dist ? ` · ${dist}` : ""}
        </div>
        ${r.address ? `<div class="paddr">${escapeHtml(r.address)}</div>` : ""}
      </div>
      <div class="pprice">${r.price != null ? `$${r.price}` : ""}</div>
    </li>
  `;
}

async function renderAsk(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();

  if (!q) {
    return html(layout("AI 搜尋", askFormHtml("") + `<p class="meta">輸入一句話開始 — 例如「古亭站附近的炒飯」「cheapest 便當 in 內湖」「最新的飲料店」。</p>`));
  }

  let intent: ParsedIntent;
  try {
    intent = await parseIntent(env, q);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return html(layout("AI 搜尋", askFormHtml(q) + `
      <p class="empty">⚠️ AI 解析失敗：${escapeHtml(msg)}</p>
      <p><a href="/">改用手動搜尋 →</a></p>
    `));
  }

  // Geocode the landmark if present.
  let geo: Geocode | null = null;
  let near: Near | null = null;
  if (intent.near_landmark) {
    geo = await geocode(env, intent.near_landmark);
    if (geo) near = { lat: geo.lat, lng: geo.lng, radiusKm: PROXIMITY_RADIUS_KM };
  }

  let resultsHtml: string;
  if (intent.result_grain === "product") {
    const rows = await runProductSearch(env.DB, intent, near);
    resultsHtml = rows.length
      ? `<ul class="results products">${rows.map(productRowHtml).join("")}</ul>`
      : `<p class="empty">沒有符合的菜單項目。${near ? `(在 ${escapeHtml(intent.near_landmark!)} ${PROXIMITY_RADIUS_KM}km 範圍內) ` : ""}試試放寬條件，或<a href="/">改用結構化搜尋</a>。</p>`;
  } else {
    const rows = await runShopSearch(env.DB, intent, near);
    resultsHtml = rows.length
      ? `<ul class="results">${rows.map(rowHtml).join("")}</ul>`
      : `<p class="empty">沒有符合的店家。${near ? `(在 ${escapeHtml(intent.near_landmark!)} ${PROXIMITY_RADIUS_KM}km 範圍內) ` : ""}試試放寬條件，或<a href="/">改用結構化搜尋</a>。</p>`;
  }

  return html(layout("AI 搜尋: " + q, askFormHtml(q) + intentBlockHtml(intent, geo) + resultsHtml));
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
  form.ask-on-home { background: linear-gradient(135deg, #eef5ff, #f3eeff); border: 1px solid #d6e2f5; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
  form.ask-on-home label { font-weight: 600; display: block; margin-bottom: .5rem; }
  form.ask-on-home .ask-row { display: flex; gap: .5rem; }
  form.ask-on-home input { flex: 1; padding: .55rem .7rem; border: 1px solid #c8d6ed; border-radius: 6px; font-size: 1rem; background: white; }
  form.ask-on-home button { padding: .55rem 1.1rem; border: 0; border-radius: 6px; background: #6a3aff; color: white; font-size: 1rem; cursor: pointer; }
  form.ask-on-home .hint { color: #666; font-size: .85em; margin: .5rem 0 0; }
  form.ask-page { display: flex; gap: .5rem; margin-bottom: 1rem; }
  form.ask-page input { flex: 1; padding: .55rem .7rem; border: 1px solid #c8d6ed; border-radius: 6px; font-size: 1rem; }
  form.ask-page button { padding: .55rem 1.1rem; border: 0; border-radius: 6px; background: #6a3aff; color: white; font-size: 1rem; cursor: pointer; }
  .intent { background: #fafbfd; border: 1px solid #e6e9ef; border-radius: 8px; padding: .65rem .85rem; margin: .6rem 0 1rem; }
  .intent .label { color: #6a3aff; font-weight: 600; margin-right: .3em; }
  .intent .chips { margin-top: .35rem; display: flex; flex-wrap: wrap; gap: .35rem; }
  .intent .chip { background: #ece5ff; color: #4a2ab8; padding: .12em .55em; border-radius: 4px; font-size: .82em; }
  .intent .geo { color: #666; font-size: .82em; margin-top: .35rem; }
  .intent .geo-miss { color: #b56500; }
  .badge.dist { background: #e6f4ec; color: #1f7a3a; }
  .dist-inline { color: #1f7a3a; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    .intent .geo { color: #aab2c0; }
    .intent .geo-miss { color: #f3c463; }
    .badge.dist { background: #1f3a2a; color: #7ad58e; }
    .dist-inline { color: #7ad58e; }
  }
  ul.results.products li.product { display: grid; grid-template-columns: 56px 1fr auto; gap: .7rem; align-items: center; padding: .6rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
  ul.results.products .thumb { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; background: #eee; }
  ul.results.products .thumb-empty { display: inline-block; background: #f0f0f4; }
  ul.results.products .pname { font-weight: 600; }
  ul.results.products .pmeta { color: #555; font-size: .9em; margin-top: .15em; }
  ul.results.products .paddr { color: #888; font-size: .82em; }
  ul.results.products .pprice { font-weight: 700; color: #0a66c2; font-variant-numeric: tabular-nums; white-space: nowrap; }
  @media (prefers-color-scheme: dark) {
    form.ask-on-home { background: linear-gradient(135deg, #1a2235, #251c3a); border-color: #2e3346; }
    form.ask-on-home input { background: #0c0d11; color: inherit; border-color: #2e3346; }
    form.ask-on-home .hint { color: #aab2c0; }
    .intent { background: #181c25; border-color: #2a2c33; }
    .intent .chip { background: #2d2552; color: #c6b6ff; }
    .intent .label { color: #c6b6ff; }
    ul.results.products .thumb-empty { background: #20242d; }
    ul.results.products .pmeta { color: #b0b7c5; }
    ul.results.products .paddr { color: #8a93a6; }
    ul.results.products .pprice { color: #7eb6ff; }
  }
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
