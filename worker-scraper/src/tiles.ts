// Grid of search centers covering Taipei City.
//
// Each tile is the center of a Maps "search restaurants near here"
// query at zoom 17. With a 500 m radius and ~700 m spacing the disks
// overlap enough that we don't miss restaurants on tile edges.

export interface Tile {
  tileId: string;
  lat: number;
  lng: number;
  radiusM: number;
}

// Taipei City bounding box. Tight on purpose for v1 — expand to New
// Taipei after the first sweep validates coverage and captcha rates.
const BBOX = {
  south: 25.00,
  north: 25.15,
  west:  121.50,
  east:  121.61,
};

// ~700 m spacing. 1 deg lat ≈ 111 km; 1 deg lng at 25°N ≈ 100.7 km.
const SPACING_M = 700;
const DEG_LAT_PER_M = 1 / 111_000;
const DEG_LNG_PER_M = 1 / 100_700;

export function generateTiles(radiusM = 500): Tile[] {
  const dLat = SPACING_M * DEG_LAT_PER_M;
  const dLng = SPACING_M * DEG_LNG_PER_M;
  const tiles: Tile[] = [];
  let row = 0;
  for (let lat = BBOX.south; lat <= BBOX.north; lat += dLat, row++) {
    let col = 0;
    for (let lng = BBOX.west; lng <= BBOX.east; lng += dLng, col++) {
      tiles.push({
        tileId: `tpe-r${row}-c${col}`,
        lat: round6(lat),
        lng: round6(lng),
        radiusM,
      });
    }
  }
  return tiles;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
