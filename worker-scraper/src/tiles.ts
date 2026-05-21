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

// Taipei City + New Taipei urban core. The bbox wraps the dense
// districts of New Taipei (Banqiao, Sanchong, Xinzhuang, Linkou,
// Yonghe, Zhonghe, Tucheng, Shulin, Xindian, Sanxia, Xizhi, southern
// Tamsui) while leaving out far-rural Pingxi / Shuangxi / Wulai
// mountains and the north/west coast strip. Cost: ~6 browser-hours
// for a full re-sweep at ~700 m spacing, ≈ 1,800 tiles.
const BBOX = {
  south: 24.92,
  north: 25.20,
  west:  121.40,
  east:  121.66,
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
