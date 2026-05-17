# `/ask` performance — findings, measurements, knobs

Captures what we measured and learned while making natural-language
search on `dinbendon.itsi.xyz` feel responsive. Pricing detail and the
broader catalog live in [`model-pricing.md`](model-pricing.md); this
doc is specifically about latency, throughput, and the streaming UX.

## TL;DR

- **The LLM parse is 95–99% of total latency.** Geocoding and D1
  queries are essentially noise.
- **The model family matters more than parameter count.** Reasoning
  models (chain-of-thought before output) burn 5–10× more time at the
  same parameter count.
- **Streaming the HTML response** gets the first usable pixel to the
  user in <300 ms regardless of what the LLM is doing.
- For our workload the current sweet spot is
  `@cf/openai/gpt-oss-20b`: ~1.5 s parse, ~$1.60 / 10 K queries.

## How we measure

The worker logs a structured timing line per `/ask` request. View live
via:

```bash
wrangler tail dinbendon-itsi --format pretty
# (log) [ask] q="古亭站附近的炒飯" parse=1349ms geo=11ms query=50ms total=1410ms grain=product rows=20
```

The same numbers are rendered at the bottom of every `/ask` response
as a `<div class="timings">` line, so any user (or you, looking at a
URL) can see where the time went without tail access.

Stages measured:

- `parse` — `env.AI.run(NL_MODEL, …)` round trip, returns when the
  model emits its final JSON.
- `geo` — `geocode()` helper: D1 cache lookup, plus optional Nominatim
  fetch on cold landmarks.
- `query` — the parameterized D1 query + JS distance ranking.
- `total` — `parse + geo + query`. Excludes TTFB on the streaming
  response, which is dominated by Cloudflare edge routing (~150–250 ms).

For TTFB vs end-to-end, use:

```bash
curl -sS -o /dev/null -w "ttfb=%{time_starttransfer}s total=%{time_total}s\n" \
  "https://dinbendon.itsi.xyz/ask?q=…"
```

## Model evolution (same prompt, same dataset, same network)

| Iteration | Model | parse | total | Notes |
|---|---|---:|---:|---|
| 1 | `@cf/meta/llama-3.1-8b-instruct` | 5–8 s | 5–8 s | Initial. Solid quality. |
| 2 | `@cf/google/gemma-4-26b-a4b-it` | **10–13 s** | **10–13 s** | Reasoning model. Burned 1000+ output tokens on chain-of-thought before the JSON. |
| 3 | `@cf/openai/gpt-oss-20b` *(current)* | **1.1–1.6 s** | **1.4–3.0 s** | Non-reasoning, similar capability, tool support. Required explicit place-name examples in the prompt. |

Bare numbers from `wrangler tail` for the post-swap deploy:

```
[ask] q="古亭站附近的炒飯"            parse=1349ms geo=11ms query=50ms total=1410ms
[ask] q="fried rice near Taipei 101" parse=1407ms geo=7ms  query=50ms total=1464ms
[ask] q="便當 in 內湖 under 100"     parse=1602ms geo=0ms  query=14ms total=1616ms
[ask] q="新開的飲料店"                parse=1130ms geo=0ms  query=10ms total=1140ms
```

### Why reasoning models killed latency

`@cf/google/gemma-4-26b-a4b-it` returns OpenAI-shaped chat completions
with a `reasoning` field populated alongside `content`:

```jsonc
{
  "choices": [{
    "finish_reason": "length",        // hit max_tokens
    "message": {
      "content": null,                // never got there
      "reasoning": "* Input query: \"古亭站附近的炒飯\" (Fried rice near…"
    }
  }]
}
```

Inference time scales linearly with output tokens. A 1000-token
reasoning trace at typical Workers AI latency works out to ~10 s.
There is no API flag we found to disable the trace; the only fix was
swapping to a non-reasoning model.

The parser in `parseIntent` now defensively handles both shapes:
`{response: "..."}` (Llama/Mistral) and
`choices[0].message.{content, reasoning}` (OpenAI-style), and pulls
JSON out of the `reasoning` field as a last resort.

## Geocoding cost

Once seeded, Nominatim lookups become D1 cache hits — sub-millisecond
on the same colo. Even cold misses are cheap:

| Path | Typical | Notes |
|---|---:|---|
| D1 cache hit | < 5 ms | most common |
| Nominatim cold call | 150–500 ms | first time we see a landmark |
| Cache stores both hits and **negative hits** — repeated misses don't hammer the API. | | |

The `geocache` table currently holds ~3 entries; even a populated cache
of 1000 popular Taipei landmarks would be < 100 KB.

## D1 query cost

Across the four representative queries above, D1 latency was 10–55 ms
including JS distance ranking. The bounding-box pre-filter on
`shops.lat` + the partial index `idx_shops_lat_lng` keep proximity
queries cheap; the worst case (`fetchLimit = 5 × intent.limit = 100`
rows over a product JOIN) returned in 50 ms.

If D1 ever becomes a bottleneck:

1. Move the haversine distance into SQL via `sin/cos/atan2` so we can
   pushdown the radius filter + `ORDER BY distance` instead of fetching
   5× the rows and re-ranking in JS.
2. Add a covering index on `(p.name, c.id, c.shop_id)` if name LIKE
   joins start showing up on slow query logs.

Neither is needed today.

## Streaming UX

Without streaming, an 8 s response felt indistinguishable from "the
site is broken." With streaming, the user sees the page header, the
echoed query, and a "搜尋中…" spinner in **TTFB ~200 ms**, even if the
LLM is still thinking.

Mechanics:

1. Worker writes `<html>…<main>` + the form + a `<div id="loading">`
   to a `TransformStream` and returns its `readable` as the Response
   body. Cloudflare flushes immediately because the response is chunked.
2. The background `(async () => {…})()` runs `parseIntent` → `geocode`
   → SQL, then writes:
   - `<style>#loading{display:none!important}</style>` (hides the
     spinner — CSS is order-independent for final state)
   - the intent block
   - the result list
   - the timing line
3. `writer.close()` ends the body.

No client JS is involved. The Worker runtime keeps the request alive
until the stream closes, so no `ctx.waitUntil` is needed.

Caveat: when `/ask` is hit by a non-streaming consumer (`curl` without
`-N`, some scrapers), they get the same bytes but only see them once
the stream closes — i.e. the same as the synchronous version. Browsers
behave correctly.

## Cost shape (current model)

`@cf/openai/gpt-oss-20b`: $0.20 / M input tokens, $0.30 / M output.
Our prompt averages ≈500 input + ≈200 output tokens per query:

```
cost / query ≈ 500/1M × 0.20 + 200/1M × 0.30
            ≈ $0.00010 + $0.00006
            ≈ $0.00016  (~$1.60 per 10,000 queries)
```

In neuron terms that's ~15 neurons / query, so the free 10,000 / day
tier covers about **650 NL queries / day** before any billing kicks in.

## What to try if things slow down again

In order of effort vs payoff:

1. **Trim the system prompt.** It's ~600 tokens with all the few-shot
   examples. Drop the least-useful examples or compress the
   instructions; every 100 input tokens saved is ~10 % off the round
   trip on this model.
2. **Cache repeated NL queries.** Identical `q` strings within a short
   window can be served from a tiny `intent_cache` table or KV. The
   model output is deterministic enough at temperature 0.
3. **Drop to a smaller model.** `@cf/meta/llama-3.2-3b-instruct` is
   ~500 ms typical and 1/5 the cost. Quality drops on landmark
   queries; would need more aggressive few-shot prompting.
4. **Tool-calling instead of JSON-schema.** `gpt-oss-20b` supports
   tool calls; could shrink output tokens (no schema preamble) and
   give us strict typing. Modest win.
5. **Streaming the model's own output.** Workers AI supports `stream:
   true`. We can't render partial JSON, but we could surface a
   "thinking…" status as tokens arrive. Likely overkill for a 1.5 s
   parse.

## What we explicitly chose not to do

- **Client-side JS spinner / fetch.** Streaming HTML achieves the same
  UX with no JS at all. Less code, no hydration, no CSP concerns.
- **An external geocoder (Google, Mapbox).** Nominatim + a D1 cache is
  free, fast enough, and good enough for Taipei landmarks. Swap point
  is the single `geocode()` function if that changes.
- **A reasoning-capable model.** They look cheap on the price sheet
  but the wall-clock cost is what users feel.
