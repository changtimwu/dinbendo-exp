#!/usr/bin/env python3
"""Brute-force scrape dinbendon.net shop detail API.

Endpoint: https://dinbendon.net/mvc/api/shop/idine/detail?shopId=<id>
- Valid id  -> {"data": {...}}    (HTTP 200)
- Missing   -> {"data": null}     (HTTP 200)

Output: JSONL file. One line per *found* shop, e.g.
    {"shopId": 637341, "data": {...}}

Resume-safe: re-running skips ids already written to the output file
(both hits and recorded misses in the progress file).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API_URL = "https://dinbendon.net/mvc/api/shop/idine/detail"

_thread_local = threading.local()


def get_session() -> requests.Session:
    s = getattr(_thread_local, "session", None)
    if s is None:
        s = requests.Session()
        retry = Retry(
            total=5,
            backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
            respect_retry_after_header=True,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=4)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        s.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        })
        _thread_local.session = s
    return s


def fetch_one(shop_id: int, timeout: float, delay: float) -> tuple[int, dict | None, str | None]:
    """Return (shop_id, data_or_None, error_or_None)."""
    if delay > 0:
        time.sleep(delay)
    try:
        r = get_session().get(API_URL, params={"shopId": shop_id}, timeout=timeout)
        if r.status_code != 200:
            return shop_id, None, f"http_{r.status_code}"
        body = r.json()
    except requests.RequestException as e:
        return shop_id, None, f"req_err:{type(e).__name__}"
    except ValueError as e:
        return shop_id, None, f"json_err:{e}"
    return shop_id, body.get("data"), None


def load_done(out_path: Path, progress_path: Path) -> set[int]:
    """Read already-seen ids from the hit file and the progress (miss) file."""
    done: set[int] = set()
    for p in (out_path, progress_path):
        if not p.exists():
            continue
        with p.open("r", encoding="utf-8") as f:
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
                    done.add(sid)
    return done


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", type=int, default=1, help="first shop id (inclusive)")
    ap.add_argument("--end", type=int, default=800000, help="last shop id (inclusive)")
    ap.add_argument("--workers", type=int, default=16, help="thread count (be polite)")
    ap.add_argument("--timeout", type=float, default=15.0, help="per-request timeout, seconds")
    ap.add_argument("--delay", type=float, default=0.05,
                    help="per-request sleep before each call, seconds (per worker)")
    ap.add_argument("--out", type=Path, default=Path("shops.jsonl"),
                    help="JSONL file of found shops")
    ap.add_argument("--progress", type=Path, default=Path("scanned.jsonl"),
                    help="JSONL log of scanned ids (hits + misses) for resume")
    ap.add_argument("--record-misses", action="store_true", default=True,
                    help="record misses in progress file (default on, enables resume)")
    ap.add_argument("--no-record-misses", dest="record_misses", action="store_false")
    ap.add_argument("--flush-every", type=int, default=200,
                    help="flush files every N completions")
    args = ap.parse_args()

    if args.end < args.start:
        print("end must be >= start", file=sys.stderr)
        return 2

    done = load_done(args.out, args.progress)
    todo = [i for i in range(args.start, args.end + 1) if i not in done]
    total = len(todo)
    print(f"[info] range={args.start}..{args.end}  already_done={len(done)}  "
          f"to_scan={total}  workers={args.workers}", flush=True)

    if total == 0:
        return 0

    out_f = args.out.open("a", encoding="utf-8")
    prog_f = args.progress.open("a", encoding="utf-8")
    write_lock = threading.Lock()

    hits = 0
    errs = 0
    misses = 0
    started = time.time()

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futures = {ex.submit(fetch_one, sid, args.timeout, args.delay): sid for sid in todo}
            for n, fut in enumerate(as_completed(futures), 1):
                sid, data, err = fut.result()
                with write_lock:
                    if err is not None:
                        errs += 1
                        prog_f.write(json.dumps({"shopId": sid, "err": err}, ensure_ascii=False) + "\n")
                    elif data is None:
                        misses += 1
                        if args.record_misses:
                            prog_f.write(json.dumps({"shopId": sid, "hit": False}, ensure_ascii=False) + "\n")
                    else:
                        hits += 1
                        out_f.write(json.dumps({"shopId": sid, "data": data}, ensure_ascii=False) + "\n")
                        prog_f.write(json.dumps({"shopId": sid, "hit": True}, ensure_ascii=False) + "\n")

                    if n % args.flush_every == 0:
                        out_f.flush(); prog_f.flush()
                        os.fsync(out_f.fileno()); os.fsync(prog_f.fileno())
                        elapsed = time.time() - started
                        rate = n / elapsed if elapsed else 0
                        eta = (total - n) / rate if rate else float("inf")
                        print(f"[{n}/{total}] hits={hits} miss={misses} err={errs} "
                              f"rate={rate:.1f}/s eta={eta/60:.1f}min", flush=True)
    except KeyboardInterrupt:
        print("\n[warn] interrupted — partial progress is saved; rerun to resume.", file=sys.stderr)
    finally:
        out_f.flush(); prog_f.flush()
        out_f.close(); prog_f.close()

    elapsed = time.time() - started
    print(f"[done] scanned={hits+misses+errs} hits={hits} miss={misses} err={errs} "
          f"elapsed={elapsed:.1f}s out={args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
