#!/usr/bin/env python3
"""Merge new shops from dinbendon.net's latest-shops Atom feed into shops.jsonl.

Workflow:
  1. GET https://dinbendon.net/feed/latestshops
  2. Extract every shop id from the entry links
  3. For each id not already present in shops.jsonl, fetch its detail via the
     shop detail API and append to shops.jsonl (also record in scanned.jsonl).

Run periodically to keep shops.jsonl current without re-scanning the whole id range.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests

from shops_db import ensure_schema, open_db, upsert_shop

FEED_URL = "https://dinbendon.net/feed/latestshops"
DETAIL_URL = "https://dinbendon.net/mvc/api/shop/idine/detail"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def load_known_ids(path: Path) -> set[int]:
    known: set[int] = set()
    if not path.exists():
        return known
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = rec.get("shopId")
            if isinstance(sid, int):
                known.add(sid)
    return known


def fetch_feed_ids(session: requests.Session, timeout: float) -> list[int]:
    r = session.get(FEED_URL, timeout=timeout)
    r.raise_for_status()
    # The feed is small Atom XML; just regex the shop= param from entry links.
    ids = sorted({int(m) for m in re.findall(r"shop=(\d+)", r.text)})
    return ids


def fetch_shop(session: requests.Session, shop_id: int, timeout: float) -> tuple[dict | None, str | None]:
    try:
        r = session.get(DETAIL_URL, params={"shopId": shop_id}, timeout=timeout)
    except requests.RequestException as e:
        return None, f"req_err:{type(e).__name__}"
    if r.status_code != 200:
        return None, f"http_{r.status_code}"
    try:
        body = r.json()
    except ValueError as e:
        return None, f"json_err:{e}"
    return body.get("data"), None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("shops.jsonl"),
                    help="JSONL file of shops to merge into")
    ap.add_argument("--progress", type=Path, default=Path("scanned.jsonl"),
                    help="JSONL log of scanned ids (mirrors scrape_shops.py)")
    ap.add_argument("--timeout", type=float, default=15.0, help="per-request timeout, seconds")
    ap.add_argument("--delay", type=float, default=0.2,
                    help="sleep between detail fetches, seconds")
    ap.add_argument("--db", type=Path, default=Path("shops.sqlite"),
                    help="SQLite database to upsert new shops into (created if missing). "
                         "Pass --no-db to disable.")
    ap.add_argument("--no-db", dest="db", action="store_const", const=None,
                    help="don't write to a SQLite database")
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update({
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    })

    feed_ids = fetch_feed_ids(session, args.timeout)
    print(f"[feed] {len(feed_ids)} ids: min={feed_ids[0]} max={feed_ids[-1]}", flush=True)

    known = load_known_ids(args.out)
    # Also treat ids already in the progress log as known to avoid re-fetching
    # things we deliberately scanned and confirmed as missing.
    scanned = load_known_ids(args.progress)
    new_ids = [i for i in feed_ids if i not in known and i not in scanned]
    print(f"[local] known={len(known)} scanned={len(scanned)} new={len(new_ids)}", flush=True)

    if not new_ids:
        print("[done] nothing to merge", flush=True)
        return 0

    db_con = None
    if args.db is not None:
        db_con = open_db(args.db)
        ensure_schema(db_con)
        print(f"[db] {args.db} ready", flush=True)

    added = 0
    misses = 0
    errs = 0
    try:
        with args.out.open("a", encoding="utf-8") as out_f, \
             args.progress.open("a", encoding="utf-8") as prog_f:
            for i, sid in enumerate(new_ids):
                if i and args.delay > 0:
                    time.sleep(args.delay)
                data, err = fetch_shop(session, sid, args.timeout)
                if err is not None:
                    errs += 1
                    prog_f.write(json.dumps({"shopId": sid, "err": err}, ensure_ascii=False) + "\n")
                    print(f"  [{sid}] err: {err}", flush=True)
                    continue
                if data is None:
                    misses += 1
                    prog_f.write(json.dumps({"shopId": sid, "hit": False}, ensure_ascii=False) + "\n")
                    print(f"  [{sid}] miss (data:null)", flush=True)
                    continue
                added += 1
                out_f.write(json.dumps({"shopId": sid, "data": data}, ensure_ascii=False) + "\n")
                prog_f.write(json.dumps({"shopId": sid, "hit": True}, ensure_ascii=False) + "\n")
                if db_con is not None:
                    upsert_shop(db_con, sid, data)
                    db_con.commit()
                name = (data.get("detail") or {}).get("name", "?")
                print(f"  [{sid}] + {name}", flush=True)
            out_f.flush()
            prog_f.flush()
    finally:
        if db_con is not None:
            db_con.close()

    print(f"[done] added={added} miss={misses} err={errs}"
          + (f"  db={args.db}" if args.db is not None else ""), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
