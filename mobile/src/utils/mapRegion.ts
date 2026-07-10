export interface MapRegionLike {
  latitude: number;
  longitude: number;
  /** Full north/south visible span, matching react-native-maps Region. */
  latitudeDelta: number;
  /** Full east/west visible span, matching react-native-maps Region. */
  longitudeDelta: number;
}

export interface ViewportBbox {
  min_lng: number;
  min_lat: number;
  max_lng: number;
  max_lat: number;
}

/** Convert a centre + full-span Region into its exact viewport bounds. */
export function regionToBbox(region: MapRegionLike): ViewportBbox {
  const halfLat = Math.abs(region.latitudeDelta) / 2;
  const halfLng = Math.abs(region.longitudeDelta) / 2;
  return {
    min_lng: region.longitude - halfLng,
    min_lat: region.latitude - halfLat,
    max_lng: region.longitude + halfLng,
    max_lat: region.latitude + halfLat,
  };
}
