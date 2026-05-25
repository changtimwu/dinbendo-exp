# D1 consistency — what we get, why we don't tighten it

How D1 routes reads and writes, what guarantee we have today, and the
one-line escape hatches if we ever need stronger consistency.

## The model

D1 is SQLite running inside a Durable Object with a **single primary**
(this database's primary lives in APAC — `running_in_region: APAC`)
and asynchronous **read replicas** in each of Cloudflare's region
buckets (ENAM, WNAM, WEUR, EEUR, APAC, OC).

- **Writes always go to the primary.** Insert/update/delete from any
  Worker is forwarded to APAC.
- **Reads can go anywhere.** Without opting in, the binding routes
  non-deterministically — your `env.DB.prepare(...).all()` might be
  served by the primary or by any replica.
- **Replication lag is "arbitrary and unbounded"** per Cloudflare's
  own docs. In practice, sub-second; the docs avoid promising more.

So the default consistency level is **eventual**: a write from one
request is not guaranteed to be visible to the next request a few
hundred ms later, even from the same Worker, if the later request
happened to land on a replica that hadn't replicated yet.

## What this codebase does today

```bash
$ grep -rn "withSession\|bookmark" worker/src worker-scraper/src
# (no matches)
```

Neither worker uses the Sessions API. Every `env.DB.prepare(...).all()`
is best-effort routing. Concretely:

| Caller | Operation | Where it lands |
|---|---|---|
| `/`, `/ask`, `/shop/:id` | reads only | any replica or primary, whichever is closest/cheapest |
| `update_from_feed.py` → `wrangler d1 execute` | writes | primary (APAC) |
| `worker-scraper`'s queue consumer | writes | primary (APAC) |

This means right after a write, there's a brief window where:

- A `/ask` request lands on a replica that hasn't seen the write yet.
- The user sees the pre-write state.
- A few hundred ms later the replica catches up and subsequent reads
  see the new state.

We have not observed user-visible staleness in practice.

## Why it doesn't matter for this workload

This app is **read-heavy with rare writes**, the exact pattern
async-replica databases handle well.

| When | Writes | Who'd notice staleness? |
|---|---|---|
| Weekly cron (Sun 18:00 UTC) | A few hundred rows, mostly re-upserts of existing shops | Nobody — row content unchanged |
| Manual `POST /enqueue?mode=stale` | Stragglers + new tiles | Maybe a user querying `/ask` for a brand-new place within ~1 s of the upsert |
| `update_from_feed.py` (dinbendon incremental) | New shops, updated menus | Same narrow window |
| Initial bulk imports (one-off) | Millions of rows | Nobody — the worker is unused during import |

Reads are continuous and totally independent of recent writes. `/ask`
doesn't care whether the new shop scraped 600 ms ago is visible yet
— the search will still return useful results from the dozens of
already-replicated shops nearby.

**No action recommended.** Keep the default routing.

## When you'd want to tighten it — the two escape hatches

### 1. Read-your-write within one Worker request

```ts
const session = env.DB.withSession();          // first call routes anywhere
await session.prepare("INSERT INTO … VALUES (…)").run();
// Subsequent reads on `session` see the insert.
const row = await session.prepare("SELECT … WHERE id = ?").bind(id).first();
```

A successful write returns a bookmark; subsequent reads on the same
session wait until the chosen replica has caught up to that bookmark.
Cost: a few extra ms only when the replica is behind. Use when a
single Worker request writes then reads back its own data.

### 2. Always-fresh (admin / debug paths)

```ts
const session = env.DB.withSession("first-primary");
```

Pins the first read to the primary, so the page never lies about the
current state. Costs one primary-region round trip per request. Use
on admin tools where staleness would actively mislead the operator
(e.g. a "did the last cron run finish?" status board).

## TL;DR

| Situation | Code | Latency cost |
|---|---|---|
| Read-heavy public search (today) | nothing | 0 |
| Insert + immediately render the new row | `env.DB.withSession()` | ~ms only when replica is behind |
| Admin / verification page | `env.DB.withSession("first-primary")` | one primary round trip |

For this project, default routing is correct.

## Reference

- [D1 read replication & Sessions API](https://developers.cloudflare.com/d1/best-practices/read-replication/)
