#!/usr/bin/env python3
"""Compress scanned.jsonl into a sorted run-length range list.

scanned.jsonl is ~20 MB of one-line-per-id JSON; the actual information
needed for resume is just "which shop ids have we tried?" Collapsing
to ranges turns 650k lines into a handful of bytes.

Output (default scanned_ranges.json):
    {
      "scanned": [[1, 650000]],        # inclusive ranges of tried ids
      "errors": [42, 1337],            # ids whose previous attempt errored (retry candidates)
      "total_scanned": 650000,
      "generated_at": "2026-05-17T..."
    }
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def to_ranges(ids: list[int]) -> list[list[int]]:
    if not ids:
        return []
    ids = sorted(set(ids))
    out: list[list[int]] = []
    start = prev = ids[0]
    for i in ids[1:]:
        if i == prev + 1:
            prev = i
            continue
        out.append([start, prev])
        start = prev = i
    out.append([start, prev])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=Path("scanned.jsonl"))
    ap.add_argument("--output", type=Path, default=Path("scanned_ranges.json"))
    args = ap.parse_args()

    if not args.input.exists():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 1

    scanned: list[int] = []
    errors: list[int] = []
    bad_lines = 0
    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                bad_lines += 1
                continue
            sid = rec.get("shopId")
            if not isinstance(sid, int):
                bad_lines += 1
                continue
            scanned.append(sid)
            if "err" in rec:
                errors.append(sid)

    ranges = to_ranges(scanned)
    payload = {
        "scanned": ranges,
        "errors": sorted(set(errors)),
        "total_scanned": len(set(scanned)),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                           encoding="utf-8")

    in_size = args.input.stat().st_size
    out_size = args.output.stat().st_size
    saving = 100 * (1 - out_size / in_size) if in_size else 0
    print(f"input : {args.input}  {in_size:>12,} bytes")
    print(f"output: {args.output}  {out_size:>12,} bytes  ({saving:.2f}% smaller)")
    print(f"ranges: {len(ranges)}  scanned ids: {payload['total_scanned']:,}  errors: {len(payload['errors'])}")
    if bad_lines:
        print(f"warn: skipped {bad_lines} malformed lines", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
