import { useState, useRef, useEffect, useCallback } from "react";

const PHOTON_URL = "https://photon.komoot.io/api/";

interface PhotonFeature {
  properties: {
    osm_id: number;
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    type?: string;
  };
  geometry: { type: string; coordinates: [number, number] };
}

function formatCityResult(f: PhotonFeature): { label: string; sub: string } {
  const p = f.properties;
  const label = p.name || p.city || "Unknown";
  const parts = [p.state, p.country].filter((s) => s && s !== label);
  return { label, sub: parts.join(", ") };
}

export interface CitySelection {
  city: string;
  lat: number;
  lng: number;
}

export function CitySearch({
  value,
  onChange,
  placeholder = "Search city…",
  required,
  id,
}: {
  value: CitySelection | null;
  onChange: (sel: CitySelection | null) => void;
  placeholder?: string;
  required?: boolean;
  id?: string;
}) {
  const [query, setQuery] = useState(value?.city || "");
  const [results, setResults] = useState<PhotonFeature[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value?.city && !query) {
      setQuery(value.city);
    }
  }, [value?.city]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q, limit: "8" });
      params.append("osm_tag", "place:city");
      params.append("osm_tag", "place:town");
      params.append("osm_tag", "place:village");
      const res = await fetch(`${PHOTON_URL}?${params}`);
      if (!res.ok) return;
      const data = await res.json() as { features: PhotonFeature[] };
      setResults(data.features || []);
      setShowResults(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleInput = (val: string) => {
    setQuery(val);
    if (value && val !== value.city) {
      onChange(null);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(val), 350);
  };

  const select = (f: PhotonFeature) => {
    const [lon, lat] = f.geometry.coordinates;
    const city = f.properties.name || f.properties.city || "Unknown";
    setQuery(city);
    setShowResults(false);
    setResults([]);
    onChange({ city, lat, lng: lon });
  };

  const clear = () => {
    setQuery("");
    onChange(null);
    setResults([]);
  };

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          id={id}
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { if (results.length > 0) setShowResults(true); }}
          placeholder={placeholder}
          autoComplete="off"
          required={required && !value}
        />
        {value && (
          <button
            type="button"
            onClick={clear}
            style={{
              position: "absolute",
              right: "0.5rem",
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              padding: "0.2rem",
              fontSize: "1rem",
              lineHeight: 1,
            }}
            title="Clear"
          >
            ×
          </button>
        )}
      </div>
      {searching && (
        <div className="text-sm text-muted" style={{ marginTop: "0.2rem" }}>
          Searching…
        </div>
      )}
      {showResults && results.length > 0 && (
        <div className="venue-dropdown">
          {results.map((f) => {
            const v = formatCityResult(f);
            return (
              <button
                key={f.properties.osm_id}
                type="button"
                className="venue-dropdown-item"
                onClick={() => select(f)}
              >
                <span className="venue-dropdown-name">{v.label}</span>
                <span className="venue-dropdown-addr">{v.sub}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
