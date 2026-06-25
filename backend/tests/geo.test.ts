import { describe, expect, it } from 'vitest';
import {
  bearing,
  centroid,
  clusterByRadius,
  compassName,
  convexHull,
  districtName,
  haversineKm,
  polygonAreaSqKm,
} from '../src/utils/geo.js';

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm({ lat: 40, lng: -73 }, { lat: 40, lng: -73 })).toBe(0);
  });
  it('is ~111km for one degree of longitude at the equator', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.19, 0);
  });
});

describe('clusterByRadius', () => {
  it('groups nearby points and separates distant ones', () => {
    const pts = [
      { lat: 40.789, lng: -73.961 }, // central park
      { lat: 40.803, lng: -73.972 }, // riverside (~1.7km)
      { lat: 34.05, lng: -118.24 }, // los angeles (far)
    ];
    const clusters = clusterByRadius(pts, 10);
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('links a transitive chain into one cluster', () => {
    // A-B 8km, B-C 8km, A-C 16km — still one cluster under single linkage
    const pts = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.072 }, // ~8km east
      { lat: 0, lng: 0.144 }, // ~16km east of A, ~8km from B
    ];
    expect(clusterByRadius(pts, 10)).toHaveLength(1);
  });
});

describe('convexHull', () => {
  it('drops interior points', () => {
    const hull = convexHull([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 2, lng: 2 },
      { lat: 2, lng: 0 },
      { lat: 1, lng: 1 }, // interior
    ]);
    expect(hull).toHaveLength(4);
  });
});

describe('bearing / compassName / districtName', () => {
  it('maps cardinal bearings to names', () => {
    expect(compassName(0)).toBe('North');
    expect(compassName(90)).toBe('East');
    expect(compassName(180)).toBe('South');
    expect(compassName(270)).toBe('West');
  });
  it('computes a northerly bearing', () => {
    expect(bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 0);
  });
  it('names a district by direction from the reference', () => {
    const ref = { lat: 40.0, lng: -73.0 };
    const north = { lat: 41.0, lng: -73.0 };
    expect(districtName(north, ref)).toBe('North District');
    expect(districtName(ref, ref)).toBe('Central District');
    expect(districtName(north, null)).toBe('Central District');
  });
});

describe('centroid & polygonAreaSqKm', () => {
  it('averages coordinates', () => {
    const c = centroid([{ lat: 0, lng: 0 }, { lat: 2, lng: 4 }]);
    expect(c).toEqual({ lat: 1, lng: 2 });
  });
  it('approximates the area of a one-degree square near the equator', () => {
    const ring = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
      { lat: 1, lng: 0 },
    ];
    // ~111km x ~111km ≈ 12,300 km²
    expect(polygonAreaSqKm(ring)).toBeGreaterThan(11_000);
    expect(polygonAreaSqKm(ring)).toBeLessThan(13_500);
  });
});
