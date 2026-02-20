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

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_HEADERS = {
  "User-Agent": "EveryCal/1.0 (calendar app)",
};

export interface EventLocation {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  url?: string;
}

async function geocodeWithNominatim(location: EventLocation): Promise<{ lat: number; lon: number } | null> {
  const query = [location.name, location.address].filter(Boolean).join(", ");
  if (!query.trim()) return null;

  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "1",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: NOMINATIM_HEADERS,
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  const lat = parseFloat(first.lat);
  const lon = parseFloat(first.lon);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

export function LocationMap({
  location,
  latitude,
  longitude,
  className,
  style,
}: {
  location: EventLocation;
  latitude?: number | null;
  longitude?: number | null;
  className?: string;
  style?: React.CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(() => {
    if (latitude != null && longitude != null) return { lat: latitude, lon: longitude };
    return null;
  });
  const [geocoding, setGeocoding] = useState(!coords && !!location.name);

  useEffect(() => {
    if (latitude != null && longitude != null) {
      setCoords({ lat: latitude, lon: longitude });
      setGeocoding(false);
      return;
    }
    if (!location.name && !location.address) {
      setCoords(null);
      setGeocoding(false);
      return;
    }
    setGeocoding(true);
    geocodeWithNominatim(location)
      .then((result) => {
        setCoords(result);
      })
      .catch(() => setCoords(null))
      .finally(() => setGeocoding(false));
  }, [latitude, longitude, location.name, location.address]);

  useEffect(() => {
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

    L.marker([coords.lat, coords.lon], { icon }).addTo(map);

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [coords]);

  const hasLocation = location.name || location.address;
  const routingQuery =
    coords ? `${coords.lat},${coords.lon}` : [location.name, location.address].filter(Boolean).join(", ");
  const canRoute = !!routingQuery;

  const routingLinks = canRoute
    ? {
        google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(routingQuery)}`,
        apple: `https://maps.apple.com/?daddr=${encodeURIComponent(routingQuery)}`,
        osm: `https://www.openstreetmap.org/directions?to=${encodeURIComponent(routingQuery)}`,
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
      {geocoding && (
        <div
          style={{
            width: "100%",
            height: "160px",
            borderRadius: "var(--radius)",
            background: "var(--bg-hover)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            fontSize: "0.9rem",
          }}
        >
          Looking up location…
        </div>
      )}
      {hasLocation && (
        <div className="mt-1" style={{ marginBottom: 0 }}>
          <div
            className="flex items-start gap-1.5"
            style={{
              flexWrap: "wrap",
              gap: "0.375rem 0.5rem",
            }}
          >
            <span className="text-muted" style={{ flexShrink: 0, marginTop: "0.15rem", fontSize: "1rem" }}>
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
