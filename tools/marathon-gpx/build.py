#!/usr/bin/env python3
"""Build a GPX track for the 2026 陽明山 Marathon from its prose route description.

Pipeline:
  1. Geocode every named waypoint via Nominatim (free, polite, with a fallback
     dict for names Nominatim doesn't resolve cleanly).
  2. Chain OSRM `route/v1/foot` calls through the waypoints in order to get
     the "spine" (the named-waypoint path with no out-and-back legs).
  3. Place the two turnaround points by walking along the outbound roads
     (擎天崗 spur for T1, 陽金公路 spur for T2) until the cumulative km hits
     a target derived from the 42.195 km total minus the spine length.
  4. Re-route end-to-end including the turnaround visits and emit GPX.

Only dependency: `requests`. OSRM public router and Nominatim are free —
respect their rate limits (1 req/s, custom UA).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OSRM = "https://router.project-osrm.org/route/v1/foot"
UA = "yangmingshan-marathon-gpx/0.1 (https://github.com/changtimwu/dinbendo-exp)"

HERE = Path(__file__).parent
DATA = HERE / "data.json"

# Ordered prose waypoints. `kind` controls how each is interpreted by later
# phases. Names from the official 2026 race brief:
#   (起點)中山樓八卦升旗臺 → 左轉新園一號橋 → 直行菁山路101巷71弄
#   → 左轉菁山路101巷 → 右轉往擎天崗停車場道路 → 第一折返點 → 原線折返
#   → 右轉竹子湖路(中湖戰備道路) → 右轉台2甲線陽金公路 → 過林口公車亭
#   → 第二折返點 → 原線折返 → 左轉竹子湖路 → 右轉菁山路101巷
#   → 右轉菁山路101巷71弄 → 直行新園一號橋 → 右轉中山樓八卦升旗臺(終點)

@dataclass
class WP:
    name: str            # display label for GPX
    query: str           # Nominatim query (may differ from display name)
    kind: str = "spine"  # "spine" | "turnaround_anchor"
    lat: Optional[float] = None
    lng: Optional[float] = None

# Manual coordinates for names Nominatim can't resolve cleanly. Filled in
# after the first run; we keep them here so re-runs are deterministic.
MANUAL: dict[str, tuple[float, float]] = {
    # name -> (lat, lng)
}

WAYPOINTS: list[WP] = [
    WP("起點 中山樓",          "中山樓 陽明山"),
    WP("菁山路101巷71弄",     "菁山路101巷71弄 士林"),
    WP("菁山路101巷",          "菁山路101巷 士林"),
    # T1 spur anchor: the 擎天崗 parking lot itself. Phase 3 walks from
    # the junction along the spur to position T1 inside this segment.
    WP("擎天崗停車場",        "擎天崗停車場", kind="turnaround_anchor"),
    # T2 anchor: 金山(南勢) is a 陽金公路 milestone well past 八煙 and
    # past where the race turns around. Phase 3 places T2 along the
    # foot route at the right cumulative distance from C; the anchor
    # just has to be *further* than T2 so we don't clamp.
    WP("金山南勢 (T2 anchor)", "金山 南勢 陽金公路", kind="turnaround_anchor"),
]

# Targets that drive phase 3 / 4.
TOTAL_M = 42_195            # official marathon distance
# Map-based split of the out-and-back budget between the two spurs.
# Inspect course-map.jpg: T1 spur is short (small loop near middle of
# map), T2 spur is long (the long line going to the top-right). Rough
# visual ratio T2:T1 ≈ 4:1. Tunable below; phase 3 reports actuals.
T1_RATIO = 0.18   # share of (|B| + |D|) that goes to the T1 spur
T2_RATIO = 1 - T1_RATIO

# ─────────── HTTP helpers ───────────

_session = requests.Session()
_session.headers["User-Agent"] = UA
_last_nominatim_call = 0.0

def nominatim(query: str) -> Optional[tuple[float, float]]:
    """One-shot Nominatim geocode. Returns (lat, lng) or None.

    Restricts to Taiwan, polite 1 req/s rate limit.
    """
    global _last_nominatim_call
    wait = 1.05 - (time.time() - _last_nominatim_call)
    if wait > 0:
        time.sleep(wait)
    _last_nominatim_call = time.time()
    r = _session.get(
        NOMINATIM,
        params={"q": query, "countrycodes": "tw", "format": "json", "limit": 1},
        timeout=20,
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return None
    return float(rows[0]["lat"]), float(rows[0]["lon"])

def osrm_route(coords: list[tuple[float, float]]) -> dict:
    """OSRM foot router. coords are (lat, lng) tuples. Returns the API JSON.

    Polyline / GeoJSON LineString in result.routes[0].geometry (coordinates
    are [lng, lat]). Total meters in result.routes[0].distance.
    """
    if len(coords) < 2:
        raise ValueError("need at least 2 coords")
    locstr = ";".join(f"{lng},{lat}" for lat, lng in coords)
    r = _session.get(
        f"{OSRM}/{locstr}",
        params={"overview": "full", "geometries": "geojson", "steps": "false"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()

# ─────────── Phase 1: geocode ───────────

def geocode_all() -> None:
    for w in WAYPOINTS:
        if w.name in MANUAL:
            w.lat, w.lng = MANUAL[w.name]
            print(f"  [manual] {w.name:25s} -> {w.lat:.5f}, {w.lng:.5f}")
            continue
        try:
            hit = nominatim(w.query)
        except Exception as e:
            print(f"  [ERROR ] {w.name:25s}: {e}")
            continue
        if hit is None:
            print(f"  [MISS  ] {w.name:25s} (query: {w.query!r})")
            continue
        w.lat, w.lng = hit
        # Sanity bound: Yangmingshan is roughly lat 25.10-25.20, lng 121.50-121.60.
        # If we get something way outside, flag it.
        if not (24.95 <= w.lat <= 25.25 and 121.45 <= w.lng <= 121.65):
            print(f"  [SUSPECT] {w.name:25s} -> {w.lat:.5f}, {w.lng:.5f} (outside expected bbox)")
        else:
            print(f"  [ok    ] {w.name:25s} -> {w.lat:.5f}, {w.lng:.5f}")

def save() -> None:
    DATA.write_text(json.dumps(
        [{"name": w.name, "query": w.query, "kind": w.kind, "lat": w.lat, "lng": w.lng} for w in WAYPOINTS],
        ensure_ascii=False,
        indent=2,
    ))
    print(f"\nWrote {DATA}")

# ─────────── Phase 2: spine routing ───────────
#
# Spine = the marathon path WITHOUT the two out-and-back spur visits.
# Walking from the start anchor through the chain back to start. The
# difference between total and spine = 2 * (|spur1| + |spur2|).

def route_pair(a: WP, b: WP) -> dict:
    r = osrm_route([(a.lat, a.lng), (b.lat, b.lng)])
    if not r.get("routes"):
        raise RuntimeError(f"no route between {a.name} and {b.name}")
    return r["routes"][0]

def measure_spine() -> tuple[float, list[tuple[WP, WP, float]]]:
    """Measure the spine distance.

    Spine = Start → 71弄 → 菁山路101巷 → [turn around here, head back]
              → 菁山路101巷 → 71弄 → Start (i.e., the path the runner
    takes minus the two spurs). Returns (meters, per-leg list).
    """
    # The spine traces out-and-back via the non-spur waypoints. For now
    # we approximate as Start → 71弄 → 菁山路101巷 → 71弄 → Start. The
    # spurs (to 擎天崗 and along 陽金公路) live entirely outside this loop.
    spine_wps = [WAYPOINTS[0], WAYPOINTS[1], WAYPOINTS[2], WAYPOINTS[1], WAYPOINTS[0]]
    total = 0.0
    legs: list[tuple[WP, WP, float]] = []
    for a, b in zip(spine_wps, spine_wps[1:]):
        d = route_pair(a, b)["distance"]
        legs.append((a, b, d))
        total += d
    return total, legs

# ─────────── Phase 3: place turnarounds ───────────
#
# Each spur is `(target_distance / 2)` long one-way. We need a lat/lng
# `target_distance/2` meters from the junction along the actual road
# OSRM uses for the anchor. Strategy:
#   1. Route from junction → anchor (an OSRM polyline along the spur).
#   2. Walk along the returned polyline summing edge lengths until we
#      hit the target. That's T1/T2.
# If the spur is shorter than the target, we extend toward the anchor
# and beyond is impossible — clamp at the anchor and accept short.

def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in meters between (lat, lng) points."""
    from math import sin, cos, sqrt, atan2, radians
    R = 6371000.0
    dlat = radians(b[0] - a[0])
    dlng = radians(b[1] - a[1])
    s = sin(dlat/2)**2 + cos(radians(a[0]))*cos(radians(b[0]))*sin(dlng/2)**2
    return 2*R*atan2(sqrt(s), sqrt(1-s))

def walk_along_polyline(coords_lnglat: list[list[float]], target_m: float) -> tuple[float, float]:
    """coords are [lng, lat] (GeoJSON order). Returns (lat, lng) at target_m
    cumulative distance from the start of the polyline."""
    if target_m <= 0:
        lng, lat = coords_lnglat[0]
        return lat, lng
    acc = 0.0
    for i in range(1, len(coords_lnglat)):
        a = (coords_lnglat[i-1][1], coords_lnglat[i-1][0])
        b = (coords_lnglat[i][1], coords_lnglat[i][0])
        seg = haversine_m(a, b)
        if acc + seg >= target_m:
            t = (target_m - acc) / seg
            lat = a[0] + t * (b[0] - a[0])
            lng = a[1] + t * (b[1] - a[1])
            return lat, lng
        acc += seg
    # ran off the end — return last point
    lng, lat = coords_lnglat[-1]
    return lat, lng

def place_turnaround(start: WP, anchor: WP, target_one_way_m: float, label: str) -> tuple[WP, float]:
    """Place a turnaround target_one_way_m along the foot route from start
    toward anchor. Returns (new WP, achieved_one_way_distance_m)."""
    r = route_pair(start, anchor)
    coords = r["geometry"]["coordinates"]  # [[lng,lat], …]
    spur_full = r["distance"]
    achieved = min(target_one_way_m, spur_full)
    lat, lng = walk_along_polyline(coords, achieved)
    return WP(label, label, kind="turnaround_anchor", lat=lat, lng=lng), achieved

# ─────────── Phase 4: emit GPX ───────────

def build_full_polyline(seq: list[WP]) -> list[tuple[float, float]]:
    """Route through `seq` in order, concatenate all leg polylines into
    one (lat, lng) point list with duplicates at the seams removed."""
    out: list[tuple[float, float]] = []
    for a, b in zip(seq, seq[1:]):
        r = route_pair(a, b)["geometry"]["coordinates"]
        pts = [(lat, lng) for lng, lat in r]
        if out and out[-1] == pts[0]:
            pts = pts[1:]
        out.extend(pts)
    return out

def emit_gpx(points: list[tuple[float, float]], out_path: Path, name: str) -> None:
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="yangmingshan-marathon-gpx" xmlns="http://www.topografix.com/GPX/1/1">',
        f'  <metadata><name>{name}</name></metadata>',
        '  <trk>',
        f'    <name>{name}</name>',
        '    <trkseg>',
    ]
    for lat, lng in points:
        parts.append(f'      <trkpt lat="{lat:.6f}" lon="{lng:.6f}" />')
    parts += ['    </trkseg>', '  </trk>', '</gpx>']
    out_path.write_text("\n".join(parts))

def total_length_m(points: list[tuple[float, float]]) -> float:
    return sum(haversine_m(points[i-1], points[i]) for i in range(1, len(points)))

# ─────────── main ───────────

if __name__ == "__main__":
    import sys
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"

    print("Phase 1: geocoding waypoints")
    geocode_all()
    save()
    if phase == "1": sys.exit(0)

    # Reload geocoded WAYPOINTS state (geocode_all populated them).
    print("\nPhase 2: spine distance via OSRM")
    spine_m, legs = measure_spine()
    for a, b, d in legs:
        print(f"  {a.name:25s} → {b.name:25s}: {d/1000:6.2f} km")
    print(f"  spine total: {spine_m/1000:.2f} km")
    print(f"  marathon target: {TOTAL_M/1000:.3f} km")
    spur_budget = TOTAL_M - spine_m
    print(f"  combined spur budget (2 × |B| + 2 × |D|): {spur_budget/1000:.2f} km")

    if phase == "2": sys.exit(0)

    print("\nPhase 3: placing turnarounds")
    # Half-spur target lengths: each spur is bidirectional, so one-way
    # = (its share of spur_budget) / 2.
    t1_target_one_way = spur_budget * T1_RATIO / 2
    t2_target_one_way = spur_budget * T2_RATIO / 2
    print(f"  T1 target one-way: {t1_target_one_way/1000:.2f} km")
    print(f"  T2 target one-way: {t2_target_one_way/1000:.2f} km")

    # T1: from 菁山路101巷 (junction proxy) toward 擎天崗 parking.
    t1_wp, t1_achieved = place_turnaround(
        WAYPOINTS[2], WAYPOINTS[3], t1_target_one_way, "第一折返點 T1",
    )
    print(f"  T1 placed at ({t1_wp.lat:.5f}, {t1_wp.lng:.5f}); spur achieved {t1_achieved/1000:.2f} km")

    # T2: from 菁山路101巷 toward 陽金公路 anchor. Since the route to T2
    # passes via 竹子湖路 then turns onto 陽金公路, we use the anchor
    # waypoint as a "direction" and walk along the natural foot path.
    t2_wp, t2_achieved = place_turnaround(
        WAYPOINTS[2], WAYPOINTS[4], t2_target_one_way, "第二折返點 T2",
    )
    print(f"  T2 placed at ({t2_wp.lat:.5f}, {t2_wp.lng:.5f}); spur achieved {t2_achieved/1000:.2f} km")

    if phase == "3": sys.exit(0)

    print("\nPhase 4: building GPX")
    # Final waypoint sequence for routing. The two spurs are encoded as
    # "go to T, come back" by listing T between two visits to the spur
    # junction (here approximated as 菁山路101巷).
    seq = [
        WAYPOINTS[0],   # Start: 中山樓
        WAYPOINTS[1],   # 菁山路101巷71弄
        WAYPOINTS[2],   # 菁山路101巷
        t1_wp,          # T1 (north on 擎天崗 spur)
        WAYPOINTS[2],   # back at 菁山路101巷
        t2_wp,          # T2 (north via 竹子湖路 then 陽金公路)
        WAYPOINTS[2],   # back at 菁山路101巷
        WAYPOINTS[1],   # 菁山路101巷71弄
        WAYPOINTS[0],   # End: 中山樓
    ]
    points = build_full_polyline(seq)
    out_path = HERE / "yangmingshan-marathon-2026.gpx"
    emit_gpx(points, out_path, "2026 Taiwan National Park Marathon — Yangmingshan 42K")
    actual = total_length_m(points)
    print(f"  GPX points: {len(points)}")
    print(f"  Total length: {actual/1000:.3f} km  (target {TOTAL_M/1000:.3f}, delta {(actual-TOTAL_M)/1000:+.3f} km)")
    print(f"  Wrote {out_path}")
