#!/usr/bin/env python3
"""Convert a sqlite3 .dump SQL file into something D1 will accept.

Changes:
  - Strip `PRAGMA ...;` lines (D1 disallows most pragmas).
  - Strip `BEGIN TRANSACTION;` / `COMMIT;` (D1 wraps imports itself).
  - Replace `unistr('...\\uXXXX...')` with `'...<actual char>...'`.
    D1's SQLite doesn't expose unistr(); .dump uses it for any text
    containing control chars (CR/LF inside notice fields, etc.).
  - Drop CREATE/INSERT for sqlite_sequence (managed automatically).

Input is read whole; the file is ~86 MB so this is fine on any laptop.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

UNISTR_RE = re.compile(r"unistr\('((?:[^']|'')*)'\)")
ESC_RE = re.compile(r"\\u([0-9a-fA-F]{4})")

SKIP_PREFIXES = (
    "PRAGMA ",
    "BEGIN TRANSACTION",
    "COMMIT",
    # sqlite_sequence is the AUTOINCREMENT bookkeeping table — D1 manages it itself.
    "DELETE FROM sqlite_sequence",
    "INSERT INTO sqlite_sequence",
    "CREATE TABLE sqlite_sequence",
    "CREATE TABLE IF NOT EXISTS \"sqlite_sequence\"",
    # sqlite_stat1 / sqlite_stat4 are ANALYZE output — D1's SQLite doesn't expose them.
    "ANALYZE ",
    "DELETE FROM sqlite_stat",
    "INSERT INTO sqlite_stat",
    "CREATE TABLE sqlite_stat",
    "CREATE TABLE IF NOT EXISTS \"sqlite_stat",
)


def _decode_unistr(match: re.Match) -> str:
    inner = match.group(1)
    decoded = ESC_RE.sub(lambda m: chr(int(m.group(1), 16)), inner)
    return "'" + decoded + "'"


def transform(text: str) -> str:
    out_lines: list[str] = []
    # Split on lines but keep multi-line statements intact (we only skip on prefix).
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if any(stripped.startswith(p) for p in SKIP_PREFIXES):
            continue
        out_lines.append(line)
    text = "".join(out_lines)
    text = UNISTR_RE.sub(_decode_unistr, text)
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=Path("shops.sql"))
    ap.add_argument("--output", type=Path, default=Path("shops_d1.sql"))
    args = ap.parse_args()

    src = args.input.read_text(encoding="utf-8")
    dst = transform(src)
    args.output.write_text(dst, encoding="utf-8")

    print(f"input : {args.input}  {len(src):>12,} bytes")
    print(f"output: {args.output}  {len(dst):>12,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
