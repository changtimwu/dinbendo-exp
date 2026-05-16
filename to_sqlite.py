#!/usr/bin/env python3
"""Bulk-load shops.jsonl into a fresh normalized SQLite database.

Drops and recreates all tables on each run. For incremental merges from
the latest-shops feed, use update_from_feed.py with --db instead.

Schema and per-shop upsert logic live in shops_db.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from shops_db import open_db, reset_schema, upsert_shop


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=Path("shops.jsonl"))
    ap.add_argument("--db", type=Path, default=Path("shops.sqlite"))
    args = ap.parse_args()

    if not args.input.exists():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 1

    if args.db.exists():
        args.db.unlink()

    con = open_db(args.db)
    reset_schema(con)

    inserted = 0
    skipped = 0

    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            sid = rec.get("shopId")
            data = rec.get("data")
            if not isinstance(sid, int) or not isinstance(data, dict):
                skipped += 1
                continue
            if upsert_shop(con, sid, data):
                inserted += 1
            else:
                skipped += 1

    con.commit()
    con.execute("ANALYZE")
    con.execute("VACUUM")
    con.close()

    # report counts
    con = open_db(args.db)
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in
              ("shops", "shop_sent_areas", "shop_service_types", "categories", "products", "variations")}
    con.close()

    in_size = args.input.stat().st_size
    db_size = args.db.stat().st_size
    print(f"input : {args.input}  {in_size:>12,} bytes")
    print(f"db    : {args.db}  {db_size:>12,} bytes  ({100*(1 - db_size/in_size):+.2f}% vs jsonl)")
    print("rows  : " + " ".join(f"{k}={v:,}" for k, v in counts.items()))
    if skipped:
        print(f"warn: skipped {skipped} malformed/empty records", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
