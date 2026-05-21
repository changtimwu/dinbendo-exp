# Dataset statistics

The `shops` table now holds two sources tagged via `shops.source`.
Numbers below are split per source so cross-source comparisons stay
honest.

| Source | Shops | Origin |
|---|---:|---|
| **dinbendon** | 13,051 | full sweep of `dinbendon.net/mvc/api/shop/idine/detail` shop ids 1..650K |
| **gmaps** | 15,617 | tile-grid scrape of Google Maps via Cloudflare Browser Rendering, Taipei + New Taipei urban core |
| **combined** | **28,668** | |

Within the Taipei + New Taipei bbox where both sources overlap
(lat 24.92–25.20, lng 121.40–121.66): dinbendon 4,743, gmaps 14,389.
**Inside the urban area gmaps adds 3× more coverage than dinbendon.**

## dinbendon source

Snapshot taken 2026-05-16/17 from a full brute-force sweep of shop ids
1..650,000 against `https://dinbendon.net/mvc/api/shop/idine/detail`.

Reproduce from [`shops.sqlite`](schema.md):

```bash
python scrape_shops.py --start 1 --end 650000
python to_sqlite.py
sqlite3 shops.sqlite
```

### Coverage

| | |
|---|---:|
| Shop ids scanned | 650,000 |
| Valid shops found | 13,051 |
| Overall hit density | 2.0% |
| Errors during scan | 0 |
| Wall time | ~50 min |

The populated id space is effectively `1..637,475`. No ids past that
return data — the allocator pointer was near 637,500 as of 2026-05-15
(seen in the latest-shops feed).

### ID density rises monotonically with id

Newer shops are denser; old low-id slots are sparse from years of
churn / deletion.

| Range | Hits | Density |
|---|---:|---:|
| 0 – 99,999 | 705 | 0.7% |
| 100k – 199,999 | 861 | 0.9% |
| 200k – 299,999 | 1,168 | 1.2% |
| 300k – 399,999 | 1,797 | 1.8% |
| 400k – 499,999 | 2,688 | 2.7% |
| 500k – 599,999 | 4,195 | 4.2% |
| 600k – 637,475 | 1,637 | 4.4% |
| 640k – 650,000 | 0 | 0% (allocator hasn't reached) |

### What's in a shop

| Object | Total | Avg per shop |
|---|---:|---:|
| categories | 57,054 | 4.4 |
| products | 433,804 | 33.2 |
| variations | 607,135 | 46.5 |

### Top service types

By number of shops carrying the tag:

| Type | Shops |
|---|---:|
| 便當 (lunchbox) | 5,939 |
| 中式 (Chinese) | 3,830 |
| 麵食 (noodles) | 3,626 |
| 飲料 (drinks) | 3,192 |
| 小吃 (snacks) | 2,012 |
| 日式 (Japanese) | 948 |
| 其他 (other) | 854 |
| 甜點 (dessert) | 690 |
| 南洋 (SE Asian) | 616 |
| 西式 (Western) | 420 |

23,583 (shop, type) pairs total — about 1.8 service tags per shop on average.

### Delivery areas

The `sentAreas` field is a list of free-form Chinese substrings that
the platform pre-decomposes for search (e.g. `台北市` is also listed as
`台`, `北`, `市`, `台北`, `北市`). That's why the top entries are
single characters:

| Area | Shops |
|---|---:|
| 市 | 5,341 |
| 區 | 3,860 |
| 台 | 2,847 |
| 台北市 | 2,211 |
| 北 | 2,181 |
| 台中市 | 2,168 |
| 北市 | 2,007 |
| 中 | 1,765 |
| 台中 | 1,625 |
| 台北 | 1,373 |

For meaningful geographic analysis, filter to multi-character entries
or de-dupe via `lat`/`lng` instead.

### Images

The API exposes images at exactly one level: **`product.image`**, which
flattens into `products.image_url` and `products.image_thumbnail_url`.

> The API has **no menu-banner field** at the shop or category level.
> The site may render a "menu image" view by composing the per-product
> photos, but no separate menu image is delivered by
> `/mvc/api/shop/idine/detail`. If you spot one served from a different
> endpoint, it'd need its own scraper.

#### Shops with at least one product image

| | Shops | % of all shops |
|---|---:|---:|
| Any product has an image | **1,510** | **11.6%** |
| Every product is text-only | 11,541 | 88.4% |

#### Distribution by image count

| Images on shop | Shops |
|---|---:|
| 0 | 11,541 |
| 1 – 2 | 1,104 |
| 3 – 5 | 139 |
| 6 – 10 | 144 |
| 11 – 30 | 95 |
| 31+ | 28 |

Long tail: a small minority of shops carry the bulk of the photos.

#### Menu images vs per-dish galleries

Field observation: shop owners on dinbendon.net don't have a dedicated
"upload a menu picture" feature, so they hijack the per-product `image`
slot — picking one arbitrary product on their menu and attaching a
photo of the printed/handwritten menu to it. Shop **637143 (參時參)** is
a typical example: 28 products, only the dish "酸甜梅子雞(炸)" carries
an image, and the image is actually a photo of the shop's full menu.

The signal is strong: when **`image_count` is tiny and the image:product
ratio is low**, that image is almost certainly a menu photo, not a dish
photo. Average ratio by image-count bucket:

| Images on shop | Shops | Avg images/products |
|---|---:|---:|
| 1 | 957 | 0.058 |
| 2 | 147 | 0.132 |
| 3 – 5 | 139 | 0.338 |
| 6 – 10 | 144 | 0.580 |
| 11+ | 123 | 0.734 |

The discontinuity between "1–2 images, ratio < 0.15" and "3+ images,
ratio > 0.3" is the dividing line. Applying that as a classifier:

| Pattern | Shops | % of all |
|---|---:|---:|
| No images at all | 11,541 | 88.4% |
| **Menu image** (≤2 images, ratio ≤0.15) | **1,054** | **8.1%** |
| Mixed / ambiguous | 243 | 1.9% |
| Per-dish gallery (≥3 images, ratio ≥0.5) | 213 | 1.6% |

So roughly **1 in 12 shops carries a menu image** in this style, and
they outnumber proper per-dish photo galleries 5:1. To pull the menu
image URL for each such shop:

```sql
WITH per_shop AS (
  SELECT s.id, s.name,
         COUNT(p.id) AS n_prod,
         SUM(CASE WHEN p.image_url IS NOT NULL THEN 1 ELSE 0 END) AS n_img
  FROM shops s
  LEFT JOIN categories c ON c.shop_id = s.id
  LEFT JOIN products   p ON p.category_id = c.id
  GROUP BY s.id
)
SELECT ps.id, ps.name,
       'https://dinbendon.net' || p.image_url AS menu_image_url
FROM per_shop ps
JOIN categories c ON c.shop_id = ps.id
JOIN products   p ON p.category_id = c.id
WHERE p.image_url IS NOT NULL
  AND ps.n_img <= 2
  AND 1.0 * ps.n_img / ps.n_prod <= 0.15;
```

#### Top 10 shops by product image count (per-dish galleries)

| shopId | Name | Images | Total products |
|---:|---|---:|---:|
| 189455 | 垂坤食品 | 221 | 254 |
| 627134 | 得倫食品<<一片珍情海苔>> | 217 | 219 |
| 374135 | 垂坤肉鬆店(新版) | 166 | 169 |
| 119082 | 得倫食品~一片珍情海苔 | 129 | 196 |
| 380172 | 得倫食品（一片珍情海苔） | 98 | 164 |
| 384054 | 散裝零食餅乾 | 63 | 65 |
| 76291 | 苗栗苑里 - 垂坤肉鬆 | 60 | 152 |
| 128551 | 宏裕行_高雄店 | 60 | 68 |
| 154249 | 麵包部落 | 58 | 67 |
| 256956 | 魷品味 | 58 | 59 |

The image-rich cluster is overwhelmingly **packaged-food / dried-goods
chains** (垂坤, 得倫, 宏裕行) where every SKU gets a photo.

#### Fetching an image

The URLs are relative; prefix with the site origin to fetch:

```
https://dinbendon.net + products.image_url
https://dinbendon.net + products.image_thumbnail_url
```

### Ownership

| | |
|---|---:|
| Distinct owner_name values | 4,189 |
| Avg shops per owner | 3.1 |

Top 5 owners by shop count:

| owner_name | shops |
|---|---:|
| d3001309(esunhsinchu) | 148 |
| gtt | 139 |
| ifood | 121 |
| MOMODA | 101 |
| Phison5F | 93 |

These look like enterprise / cafeteria accounts that maintain catalogues
for many vendors (the names hint at corporate / building managers).

### Duplicate shop names

Chain restaurants are not deduplicated — every site listing is a
separate `shopId`:

| Name | Distinct ids |
|---|---:|
| 八方雲集 | 17 |
| 正忠排骨飯 | 6 |
| 一沐日 | 5 |
| 吉野烤肉飯 | 5 |
| 梁社漢排骨 | 5 |
| 傑克廚房 | 4 |
| 吾家味涼麵 | 4 |
| 天仁茗茶 | 4 |
| 嶼魚廚房 | 4 |
| 御香亭 | 4 |

This matters when summarising "how many shops on the platform" — the
real count of *distinct businesses* is somewhat lower, since 4 separate
"得倫食品" entries and 17 "八方雲集" entries are the same chains
re-registered by different orderers.

## gmaps source

Snapshot taken 2026-05-22 from a Cloudflare Browser Rendering sweep of
Google Maps over Taipei City + the urban districts of New Taipei.
1,710 tile centers at ~700 m spacing, ~12 s per tile, ~5.7 cumulative
browser-hours. Operational detail in [`scraper-ops.md`](scraper-ops.md);
ID strategy + schema additions in [`schema.md`](schema.md).

### Coverage

| | |
|---|---:|
| Tiles scraped | 1,710 |
| ok / empty / error / blocked | 1,629 / 80 / 1 / 0 |
| Unique places landed | **15,617** |
| Places per tile (raw, before dedup) | ~60 |
| Places per tile (after place-id dedup) | ~9 unique adds late in the sweep |
| Wall-clock | ~2.5 hr |

The bbox covers `lat 24.92–25.20, lng 121.40–121.66` — Taipei City,
Banqiao, Sanchong, Xinzhuang, Linkou, Yonghe, Zhonghe, Tucheng, Shulin,
Xindian, Sanxia, Xizhi, southern Tamsui. Pingxi / Shuangxi / Wulai
mountains and the north/west coast strip are intentionally out (too
sparse for the browser-hours cost).

### Field fill

| Field | Populated | Why nulls happen |
|---|---:|---|
| `name` | 100% | Always present (drops row otherwise) |
| `external_id` (Place ID) | 100% | Required for dedup |
| `lat` / `lng` | 100% | Drives proximity search |
| `address` | 99.2% | Place card with no address line |
| `gmaps_types_json` (cuisine) | 99.2% | Same |
| `rating` | 97.0% | New / unrated places |
| `opening_hours_json` | 93.0% | Place without published hours |
| `rating_count` | 58.0% | Stripped card layout omits it |
| `price_level` | 51.2% | Stripped card layout omits it |

Browser Rendering serves Google Maps a stripped-down card layout
keyed off bot fingerprint (`lang="en-SG"`). Roughly half the cards
render the richer layout with `(N) · $$$` lines, the rest only show
name + rating + type + hours. Rating value reads from the
`aria-label` on the star span (locale-independent); count and price
are best-effort.

### Rating distribution

| Bucket | Places |
|---|---:|
| 5.0 | 909 |
| 4.x | 11,549 |
| 3.x | 2,366 |
| 2.x | 258 |
| 1.x | 57 |

A clean Pareto: ~76% of rated places sit in the 4.0–4.9 band. The
floor of 1-star ratings is small enough that any sort by rating is
dominated by 4+.

### Price level (when populated)

`price_level` is parsed two ways: the `$$` glyph count (1–4 dollar
signs) when present, else the low end of an NT$ price band mapped
into a 1–4 bucket (≤200 → 1, ≤500 → 2, ≤1000 → 3, > 1000 → 4).

| Level | Places | Approx NT$ |
|---|---:|---|
| 1 | 7,136 | ≤ NT$200 / `$` |
| 2 | 626 | ≤ NT$500 / `$$` |
| 3 | 236 | ≤ NT$1000 / `$$$` |
| 4 | 0 | > NT$1000 / `$$$$` |

Why level 1 dominates: a `$400–600` band's low end is 400, which
buckets to 2 — but most cards that *do* show a band start at $100 or
$200, so they bucket to 1. The very high end ($1000+) is rare.

### Top cuisine types

The first element of `gmaps_types_json`. Maps' types are English even
in the zh-TW UI.

| Type | Places |
|---|---:|
| Restaurant | 3,835 |
| Breakfast | 863 |
| Chinese | 658 |
| Brunch | 484 |
| Breakfast restaurant | 462 |
| Snack bar | 372 |
| Chinese restaurant | 366 |
| Brunch restaurant | 352 |
| Hawker stall | 288 |
| Hot Pot | 279 |
| Taiwanese | 252 |
| Chinese Noodles | 212 |
| Chop bar | 201 |
| Vegetarian | 196 |
| Japanese restaurant | 182 |

"Restaurant" as a generic type covers a quarter of the gmaps rows —
Google's classifier defaults to it whenever a more specific cuisine
isn't confident. Breakfast + Brunch + Breakfast restaurant + Brunch
restaurant combined (~2,150 places, ~14%) is the second cluster, which
matches what Taiwanese urban breakfast culture looks like in person.

### Comparison with dinbendon inside the same bbox

Within `lat 24.92–25.20, lng 121.40–121.66`:

| Source | Places |
|---|---:|
| dinbendon (lat/lng populated) | 4,743 |
| gmaps | 14,389 |
| **Union (no dedup attempted)** | **19,132** |

gmaps is ~3× the dinbendon coverage in this geography. The two
overlap heavily — same chains, same streets — but no cross-source
dedup has been applied (a follow-up issue). For `/ask`, both surface
in the result list with the source chip indicating which is which.
