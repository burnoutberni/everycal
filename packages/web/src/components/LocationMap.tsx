import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LocationPinIcon } from "./icons";

/** CartoDB Positron - light OSM-based tiles */
const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";
const TILE_OPTIONS = {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
};

export interface EventLocation {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  url?: string;
}

export function LocationMap({
  location,
  latitude,
  longitude,
  className,
  style,
  compact,
  onMarkerDrag,
}: {
  location: EventLocation;
  latitude?: number | null;
  longitude?: number | null;
  className?: string;
  style?: React.CSSProperties;
  /** When true, only show the map (no location text or routing links). */
  compact?: boolean;
  /** Called when the user drags the pin to a new position. Only coordinates change. */
  onMarkerDrag?: (lat: number, lng: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onMarkerDragRef = useRef(onMarkerDrag);
  onMarkerDragRef.current = onMarkerDrag;

  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(() => {
    if (latitude != null && longitude != null) return { lat: latitude, lon: longitude };
    return null;
  });

  // Sync coords from props. Never geocode — if we don't have coords, don't show the map.
  useEffect(() => {
    if (latitude != null && longitude != null) {
      setCoords({ lat: latitude, lon: longitude });
    } else {
      setCoords(null);
    }
  }, [latitude, longitude]);

  const hasCoords = !!coords;

  // Create map when we get coords; destroy when coords cleared. Does not re-run when coords change.
  useEffect(() => {
    if (!hasCoords) {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
      return;
    }
    if (!containerRef.current || !coords) return;

    const map = L.map(containerRef.current, {
      center: [coords.lat, coords.lon],
      zoom: 15,
      zoomControl: false,
      scrollWheelZoom: false,
      dragging: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });

    L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(map);

    const icon = L.divIcon({
      className: "leaflet-div-icon location-marker",
      html: `<div style="width:16px;height:16px;background:var(--accent);border:2px solid var(--bg);border-radius:50%;"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });

    const marker = L.marker([coords.lat, coords.lon], {
      icon,
      draggable: !!onMarkerDragRef.current,
    }).addTo(map);

    if (onMarkerDragRef.current) {
      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        onMarkerDragRef.current?.(pos.lat, pos.lng);
      });
    }

    mapRef.current = map;
    markerRef.current = marker;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [hasCoords]); // eslint-disable-line react-hooks/exhaustive-deps -- coords read on mount only

  // Update marker position when coords change (e.g. from drag). Does not recreate map.
  useEffect(() => {
    if (markerRef.current && coords) {
      markerRef.current.setLatLng([coords.lat, coords.lon]);
    }
  }, [coords?.lat, coords?.lon]);

  const hasLocation = location.name || location.address;
  const hasNameAndAddress = location.name && location.address;
  const locationLabel = [location.name, location.address].filter(Boolean).join(", ");

  // Only show map buttons when we have coords (i.e. when the map is shown)
  const routingLinks = coords
    ? {
        google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          location.address || `${coords.lat},${coords.lon}`
        )}`,
        apple: `https://maps.apple.com/?ll=${coords.lat},${coords.lon}${hasNameAndAddress ? `&q=${encodeURIComponent(locationLabel)}` : ""}`,
        osm: `https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lon}&marker=${coords.lat},${coords.lon}#map=17/${coords.lat}/${coords.lon}`,
      }
    : null;

  return (
    <div className={className} style={style}>
      {coords && (
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: "160px",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            background: "var(--bg-hover)",
          }}
        />
      )}
      {!compact && hasLocation && (
        <div className="mt-1" style={{ marginBottom: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
            }}
          >
            <span className="text-muted" style={{ flexShrink: 0, lineHeight: 1.3, display: "flex", fontSize: "1.125rem" }}>
              <LocationPinIcon />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              {location.name && (
                <div
                  style={{
                    fontWeight: 600,
                    color: "var(--text)",
                    lineHeight: 1.3,
                  }}
                >
                  {location.name}
                </div>
              )}
              {location.address && (
                <div
                  className="text-sm text-muted"
                  style={{
                    marginTop: location.name ? "0.25rem" : 0,
                    lineHeight: 1.4,
                  }}
                >
                  {location.address}
                </div>
              )}
            </div>
          </div>
          {routingLinks && (
            <div
              className="flex items-center"
              style={{
                marginTop: "0.5rem",
                flexWrap: "nowrap",
                gap: "0.5rem",
              }}
            >
              <span className="text-sm text-muted" style={{ flexShrink: 0 }}>
                Maps:
              </span>
              <div className="flex" style={{ flex: 1, gap: "0.25rem", minWidth: 0 }}>
                <a
                  href={routingLinks.google}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost"
                  style={{
                    padding: "0.25rem 0.4rem",
                    fontSize: "0.7rem",
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    whiteSpace: "nowrap",
                  }}
                >
                  Google
                </a>
                <a
                  href={routingLinks.apple}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost"
                  style={{
                    padding: "0.25rem 0.4rem",
                    fontSize: "0.7rem",
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    whiteSpace: "nowrap",
                  }}
                >
                  Apple
                </a>
                <a
                  href={routingLinks.osm}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost"
                  style={{
                    padding: "0.25rem 0.4rem",
                    fontSize: "0.7rem",
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    whiteSpace: "nowrap",
                  }}
                >
                  OSM
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
