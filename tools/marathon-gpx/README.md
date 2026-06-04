# marathon-gpx

Turn a prose route description ("turn right at X, go to Y, turn around")
into a real GPX track. No physical run required.

The 2026 Taiwan National Park Marathon (Yangmingshan) publishes its
42 K course as a Chinese-language prose description plus a static
image. This tool consumes the prose, geocodes the named landmarks via
Nominatim, asks OSRM's free `foot` router for the road-network paths
between them, and snaps the two turnaround points to the right
distance along their spurs so the total comes out to exactly the
marathon's 42.195 km.

## Quick start

```bash
cd tools/marathon-gpx
python3 -m venv .venv && .venv/bin/pip install requests matplotlib
.venv/bin/python3 build.py
```

Output: `yangmingshan-marathon-2026.gpx` (open in Strava / Garmin
Connect / gpx.studio) + `preview.png` (top-down sanity render).

## How it works

Free building blocks, no API keys, no scraping:

| Stage | Tool | What it does |
|---|---|---|
| Geocode landmarks | [Nominatim](https://nominatim.openstreetmap.org/) | "中山樓" → (25.151, 121.550) |
| Path between landmarks | [OSRM public router](https://project-osrm.org/) | foot-routing on OSM road network |
| Pin turnaround locations | Walk the OSRM polyline | One-way distance to T1/T2 derived from the marathon total |
| Emit GPX | Stdlib XML | GPX 1.1 with one `<trkseg>` |

## Why this works (and where it can be wrong)

For a marathon on paved roads, the road network has a unique shortest
path between consecutive named landmarks, so we don't need the prose's
turn-by-turn detail (左轉/右轉/直行) — the foot router rediscovers it
from OSM. The only ambiguity is *where* on each spur road the
turnaround sits, and that's a single constraint: the two one-way
spur distances must sum to a specific number so the total hits
42.195 km. We split that constraint between the two spurs visually
from the official course image (~18% / 82% in 2026).

Off-by axes:

- **Turnaround precision:** the exact placement on each spur is a
  best guess from the visual ratio. Total distance is locked, but the
  T1/T2 lat/lng could be ±200 m from the true checkpoint.
- **Foot-router choices:** OSRM picks the shortest pedestrian path,
  which on Yangmingshan's road network matches the prose. Could
  differ in edge cases (a road tagged as foot=no in OSM but used by
  the race anyway).
- **Anchor coverage:** Junctions ("竹子湖路口") don't usually geocode
  cleanly. We use larger named landmarks as anchors and trust the
  network between them.
