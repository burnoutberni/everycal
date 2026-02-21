import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useLocation, Link } from "wouter";
import { events as eventsApi, locations as locationsApi, images as imagesApi, type EventInput, type CalEvent, type SavedLocation, type ImageAttribution } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { eventPath } from "../lib/urls";
import { inferImageSearchTerm, inferTagsFromTitle, toSingleWordTag } from "../lib/inferImageSearchTerm";
import { formatEventDateTime } from "../lib/formatEventDateTime";
import { LocationPinIcon, ExternalLinkIcon, GlobeIcon, TrashIcon, ImageIcon } from "../components/icons";
import { ImagePickerModal } from "../components/ImagePickerModal";
import { LocationMap } from "../components/LocationMap";
import { ImageAttributionBadge } from "../components/ImageAttributionBadge";
import { RichTextEditor } from "../components/RichTextEditor";
import { TagInput } from "../components/TagInput";

// ---- Duration helpers ----

type Duration = "30m" | "1h" | "2h" | "allday";

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(18, 0, 0, 0);
  return toDatetimeLocal(d);
}

function addDuration(start: string, dur: Duration): string {
  const d = new Date(start);
  if (dur === "30m") d.setMinutes(d.getMinutes() + 30);
  else if (dur === "1h") d.setHours(d.getHours() + 1);
  else if (dur === "2h") d.setHours(d.getHours() + 2);
  return toDatetimeLocal(d);
}

/** Complete partial datetime-local value (e.g. date-only) to full YYYY-MM-DDTHH:mm */
function completeDatetimeLocal(
  value: string,
  defaultTime: string
): string | null {
  if (!value || value.length >= 16) return null;
  const dateMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;
  const datePart = dateMatch[1];
  if (value.length === 10) return datePart + "T" + defaultTime;
  if (value === datePart + "T") return datePart + "T" + defaultTime;
  return null;
}

const DURATION_PRESETS: { value: Duration; label: string }[] = [
  { value: "30m", label: "30 min" },
  { value: "1h", label: "1 h" },
  { value: "2h", label: "2 h" },
];

// ---- Draft persistence ----

const DRAFT_STORAGE_KEY = "everycal-event-draft";

interface EventDraft {
  title: string;
  description: string;
  startDate: string;
  duration: Duration;
  showCustomEnd: boolean;
  customEnd: string;
  imageUrl: string;
  imageAttribution?: ImageAttribution;
  url: string;
  tags: string;
  visibility: string;
  locationMode: LocationMode;
  venueQuery: string;
  locationName: string;
  locationAddress: string;
  locationLat?: number;
  locationLng?: number;
  locationUrl: string;
  showAddress: boolean;
  manualLocation: boolean;
}

function loadDraft(): EventDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EventDraft;
  } catch {
    return null;
  }
}

function saveDraft(draft: EventDraft): void {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore quota/parse errors
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

function hasDraftContent(draft: EventDraft): boolean {
  return !!(
    draft.title.trim() ||
    draft.description.trim() ||
    draft.url.trim() ||
    draft.tags.trim() ||
    draft.imageUrl ||
    draft.locationName.trim() ||
    draft.venueQuery.trim() ||
    draft.locationUrl.trim()
  );
}

/** Derive duration preset from start/end; null if custom. */
function durationFromStartEnd(
  start: string,
  end: string | null,
  allDay: boolean
): { duration: Duration; showCustomEnd: boolean; customEnd: string } {
  if (allDay) {
    return { duration: "allday", showCustomEnd: !!end, customEnd: end ? end.slice(0, 10) : "" };
  }
  if (!end || !start) {
    return { duration: "1h", showCustomEnd: false, customEnd: "" };
  }
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const diffMins = Math.round((endMs - startMs) / 60000);
  if (diffMins === 30) return { duration: "30m", showCustomEnd: false, customEnd: "" };
  if (diffMins === 60) return { duration: "1h", showCustomEnd: false, customEnd: "" };
  if (diffMins === 120) return { duration: "2h", showCustomEnd: false, customEnd: "" };
  return {
    duration: "1h",
    showCustomEnd: true,
    customEnd: toDatetimeLocal(new Date(end)),
  };
}

/** Map CalEvent to form initial state for edit mode. */
function eventToInitialState(event: CalEvent): Partial<EventDraft> & { startDate: string } {
  const loc = event.location;
  const isOnline = !!(loc?.url);
  const { duration, showCustomEnd, customEnd } = durationFromStartEnd(
    event.startDate,
    event.endDate,
    event.allDay
  );
  const startDate = event.allDay
    ? event.startDate.slice(0, 10)
    : toDatetimeLocal(new Date(event.startDate));
  return {
    title: event.title,
    description: event.description || "",
    startDate,
    duration,
    showCustomEnd,
    customEnd: customEnd ? (event.allDay ? customEnd.slice(0, 10) : customEnd.slice(0, 16)) : "",
    imageUrl: event.image?.url || "",
    imageAttribution: event.image?.attribution,
    url: event.url || "",
    tags: event.tags?.join(", ") || "",
    visibility: event.visibility,
    locationMode: isOnline ? "online" : "inperson",
    venueQuery: loc?.name || "",
    locationName: loc?.name || "",
    locationAddress: loc?.address || "",
    locationLat: loc?.latitude,
    locationLng: loc?.longitude,
    locationUrl: loc?.url || "",
    showAddress: !!(loc?.address),
    manualLocation: !!(loc?.name && !loc?.latitude && !loc?.longitude),
  };
}

// ---- Photon geocoding (komoot) ----

const PHOTON_URL = "https://photon.komoot.io/api/";
const PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse";

interface PhotonFeature {
  properties: {
    osm_id: number;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    district?: string;
    locality?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
  };
  geometry: { type: string; coordinates: [number, number] };
}

const HOUSE_NUMBER_FIRST = new Set(["us", "gb", "ca", "au", "nz", "ie", "za", "in"]);

function extractVenueParts(f: PhotonFeature): { name: string; address: string } {
  const p = f.properties;
  const name = p.name || p.street || p.district || p.city || "Unknown";

  const road = p.street || "";
  const hn = p.housenumber || "";
  const city = p.city || "";
  const postcode = p.postcode || "";
  const district = p.district || p.locality || "";
  const state = p.state || "";
  const country = p.country || "";
  const cc = (p.countrycode || "").toLowerCase();

  let street = "";
  if (road && hn) {
    street = HOUSE_NUMBER_FIRST.has(cc) ? `${hn} ${road}` : `${road} ${hn}`;
  } else if (road && road !== name) {
    street = road;
  }

  let cityPart = "";
  if (postcode && city) {
    cityPart = `${postcode} ${city}`;
  } else if (city) {
    cityPart = city;
  }

  const parts = [
    street,
    !street && district && district !== name ? district : "",
    cityPart,
  ].filter(Boolean);

  if (parts.length === 0) {
    const fallback = [state, country].filter((s) => s && s !== name);
    return { name, address: fallback.join(", ") };
  }

  return { name, address: parts.join(", ") };
}

/** Extract city/town from Photon feature for use as a tag (local language from OSM). */
function extractCityFromPhotonFeature(f: PhotonFeature): string | null {
  const p = f.properties;
  return p.city || p.locality || p.district || null;
}

/** Geocode an address string via Photon; returns coords and city for tag, or null. */
async function geocodeAddress(
  query: string,
  bias?: { lat: number; lon: number }
): Promise<{ lat: number; lng: number; city: string | null } | null> {
  const q = query.trim();
  if (!q) return null;
  const params = new URLSearchParams({ q, limit: "1" });
  if (bias) {
    params.set("lat", String(bias.lat));
    params.set("lon", String(bias.lon));
  }
  const res = await fetch(`${PHOTON_URL}?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { features: PhotonFeature[] };
  const f = data.features?.[0];
  if (!f?.geometry?.coordinates) return null;
  const [lon, lat] = f.geometry.coordinates;
  const city = extractCityFromPhotonFeature(f);
  return { lat, lng: lon, city };
}

type LocationMode = "inperson" | "online";

/** Add a tag to the tags string if not already present. All tags single-word (spaces → dashes). */
function mergeTagIntoTags(current: string, tag: string): string {
  const normalized = toSingleWordTag(tag);
  if (!normalized) return current;
  const existing = current.split(",").map((s) => toSingleWordTag(s)).filter(Boolean);
  if (existing.includes(normalized)) return current;
  return [...existing, normalized].join(", ");
}

/** Remove a tag from the tags string (case-insensitive). */
function removeTagFromTags(current: string, tag: string): string {
  const normalized = toSingleWordTag(tag);
  if (!normalized) return current;
  const list = current.split(",").map((s) => toSingleWordTag(s)).filter(Boolean);
  return list.filter((t) => t !== normalized).join(", ");
}

// ---- Component ----

interface NewEventPageProps {
  /** When provided, renders in edit mode (load from event, call update on submit). */
  initialEvent?: CalEvent | null;
}

export function NewEventPage({ initialEvent }: NewEventPageProps = {}) {
  const { user, refreshUser } = useAuth();
  const [, navigate] = useLocation();
  const isEdit = !!initialEvent;

  const defaultVis = user?.discoverable ? "public" : "private";
  const initialState = initialEvent ? eventToInitialState(initialEvent) : null;

  // Core fields
  const [title, setTitle] = useState(initialState?.title ?? "");
  const [description, setDescription] = useState(initialState?.description ?? "");
  const [startDate, setStartDate] = useState(initialState?.startDate ?? defaultStart);
  const [duration, setDuration] = useState<Duration>(initialState?.duration ?? "1h");
  const [showCustomEnd, setShowCustomEnd] = useState(initialState?.showCustomEnd ?? false);
  const [customEnd, setCustomEnd] = useState(initialState?.customEnd ?? "");
  const [imageUrl, setImageUrl] = useState(initialState?.imageUrl ?? "");
  const [imageAttribution, setImageAttribution] = useState<ImageAttribution | undefined>(initialState?.imageAttribution);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [url, setUrl] = useState(initialState?.url ?? "");
  const [urlError, setUrlError] = useState("");
  const [tags, setTags] = useState(initialState?.tags ?? "");
  const [visibility, setVisibility] = useState(initialState?.visibility ?? defaultVis);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Location
  const [locationMode, setLocationMode] = useState<LocationMode>(initialState?.locationMode ?? "inperson");
  const [venueQuery, setVenueQuery] = useState(initialState?.venueQuery ?? "");
  const [locationName, setLocationName] = useState(initialState?.locationName ?? "");
  const [locationAddress, setLocationAddress] = useState(initialState?.locationAddress ?? "");
  const [locationLat, setLocationLat] = useState<number | undefined>(initialState?.locationLat);
  const [locationLng, setLocationLng] = useState<number | undefined>(initialState?.locationLng);
  const [locationUrl, setLocationUrl] = useState(initialState?.locationUrl ?? "");
  const [locationUrlError, setLocationUrlError] = useState("");
  const [showAddress, setShowAddress] = useState(initialState?.showAddress ?? false);
  const [manualLocation, setManualLocation] = useState(initialState?.manualLocation ?? false);
  const [venueResults, setVenueResults] = useState<PhotonFeature[]>([]);
  const [searchingVenue, setSearchingVenue] = useState(false);
  const [resolvingAddress, setResolvingAddress] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [searchingImage, setSearchingImage] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const imageSearchQueryRef = useRef<string>("");
  const imageUrlRef = useRef(imageUrl);
  const resultsRef = useRef<HTMLDivElement>(null);
  const lastLocationTagRef = useRef<string | null>(null);

  imageUrlRef.current = imageUrl;

  // Reset loaded state when image URL changes
  useEffect(() => {
    setImageLoaded(false);
  }, [imageUrl]);

  // Auto-search header image and auto-add tags when title changes (debounced, create mode only)
  // Uses heuristics to infer event type → search term; never sends raw title to API
  useEffect(() => {
    if (isEdit) return;
    const t = title.trim();
    if (t.length < 2) return;
    const searchTerm = inferImageSearchTerm(t);
    const inferredTags = inferTagsFromTitle(t);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      imageSearchQueryRef.current = t;
      // Auto-add inferred tags if not already present (runs immediately, no API wait)
      if (inferredTags.length > 0) {
        setTags((prev) => {
          const current = prev.split(",").map((s) => toSingleWordTag(s)).filter(Boolean);
          const toAdd = inferredTags
            .map((tag) => toSingleWordTag(tag))
            .filter((tag) => tag && !current.includes(tag));
          if (toAdd.length === 0) return prev;
          return [...current, ...toAdd].join(", ");
        });
      }
      setSearchingImage(true);
      try {
        const result = await imagesApi.search(searchTerm, 1);
        if (result?.results?.[0] && imageSearchQueryRef.current === t && !imageUrlRef.current) {
          const first = result.results[0];
          setImageLoaded(false);
          setImageUrl(first.url);
          setImageAttribution(first.attribution);
        }
      } catch {
        // Ignore
      } finally {
        if (imageSearchQueryRef.current === t) setSearchingImage(false);
      }
    }, 500);
    return () => clearTimeout(searchTimer.current);
  }, [title, isEdit]);

  useEffect(() => {
    if (user) {
      locationsApi.list().then(setSavedLocations).catch(() => {});
    }
  }, [user]);

  // Load draft from localStorage when user is available (create mode only)
  useEffect(() => {
    if (!user || isEdit) return;
    const d = loadDraft();
    if (!d || !hasDraftContent(d)) return;
    setTitle(d.title);
    setDescription(d.description);
    setStartDate(d.startDate || defaultStart());
    setDuration(d.duration || "1h");
    setShowCustomEnd(d.showCustomEnd ?? false);
    setCustomEnd(d.customEnd || "");
    setImageUrl(d.imageUrl || "");
    setImageAttribution(d.imageAttribution);
    setUrl(d.url || "");
    setTags(d.tags || "");
    setVisibility(d.visibility || defaultVis);
    setLocationMode(d.locationMode || "inperson");
    setVenueQuery(d.venueQuery || "");
    setLocationName(d.locationName || "");
    setLocationAddress(d.locationAddress || "");
    setLocationLat(d.locationLat);
    setLocationLng(d.locationLng);
    setLocationUrl(d.locationUrl || "");
    setShowAddress(d.showAddress ?? false);
    setManualLocation(d.manualLocation ?? false);
  }, [user, isEdit]);

  // Save draft to localStorage (debounced, create mode only)
  useEffect(() => {
    if (!user || isEdit) return;
    const draft: EventDraft = {
      title,
      description,
      startDate,
      duration,
      showCustomEnd,
      customEnd,
      imageUrl,
      imageAttribution,
      url,
      tags,
      visibility,
      locationMode,
      venueQuery,
      locationName,
      locationAddress,
      locationLat,
      locationLng,
      locationUrl,
      showAddress,
      manualLocation,
    };
    if (!hasDraftContent(draft)) return;
    const t = setTimeout(() => saveDraft(draft), 500);
    return () => clearTimeout(t);
  }, [
    user,
    isEdit,
    title,
    description,
    startDate,
    duration,
    showCustomEnd,
    customEnd,
    imageUrl,
    imageAttribution,
    url,
    tags,
    visibility,
    locationMode,
    venueQuery,
    locationName,
    locationAddress,
    locationLat,
    locationLng,
    locationUrl,
    showAddress,
    manualLocation,
  ]);

  // Derived
  const allDay = duration === "allday";
  const minStartNow = toDatetimeLocal(new Date());
  const minStartToday = new Date().toISOString().slice(0, 10);
  const endDate = useMemo(() => {
    if (customEnd) return customEnd;
    if (duration === "allday") return "";
    if (!startDate) return "";
    return addDuration(startDate, duration);
  }, [startDate, duration, customEnd]);

  // Which preset matches the actual end (for highlighting); null when custom duration
  const highlightedPreset = useMemo((): Duration | null => {
    if (duration === "allday") return "allday";
    if (!startDate || !endDate) return duration;
    for (const p of DURATION_PRESETS) {
      if (addDuration(startDate, p.value) === endDate) return p.value;
    }
    return null;
  }, [startDate, endDate, duration]);

  // Detect if material fields (title, time, location) changed — these trigger notifications to RSVPs
  const materialFieldsChanged = useMemo(() => {
    if (!isEdit || !initialEvent) return false;
    if (title.trim() !== (initialEvent.title || "").trim()) return true;
    const initStart = initialEvent.allDay ? initialEvent.startDate.slice(0, 10) : toDatetimeLocal(new Date(initialEvent.startDate));
    const initEnd = initialEvent.endDate
      ? (initialEvent.allDay ? initialEvent.endDate.slice(0, 10) : toDatetimeLocal(new Date(initialEvent.endDate)))
      : "";
    const currStart = allDay ? startDate.slice(0, 10) : startDate;
    const currEnd = endDate || "";
    if (currStart !== initStart || currEnd !== initEnd || allDay !== (initialEvent.allDay ?? false)) return true;
    const initLoc = initialEvent.location;
    const initOnline = !!(initLoc?.url);
    if (locationMode === "online" !== initOnline) return true;
    if (locationMode === "inperson") {
      const initName = initLoc?.name || "";
      const initAddr = initLoc?.address || "";
      const currName = locationName || venueQuery.trim();
      if (currName !== initName || (locationAddress || "") !== initAddr) return true;
      if ((locationLat ?? null) !== (initLoc?.latitude ?? null) || (locationLng ?? null) !== (initLoc?.longitude ?? null)) return true;
    } else {
      if ((locationUrl || "") !== (initLoc?.url || "")) return true;
    }
    return false;
  }, [
    isEdit,
    initialEvent,
    title,
    startDate,
    endDate,
    allDay,
    locationMode,
    locationName,
    locationAddress,
    locationLat,
    locationLng,
    locationUrl,
    venueQuery,
  ]);

  if (!user) {
    return (
      <div className="empty-state mt-3">
        <p>
          <Link href="/login">Log in</Link> to create events.
        </p>
      </div>
    );
  }

  // ---- Photon venue search (biased to user's city) ----

  const searchVenue = useCallback(async (q: string) => {
    if (q.length < 3) {
      setVenueResults([]);
      return;
    }
    setSearchingVenue(true);
    try {
      const params = new URLSearchParams({ q, limit: "5" });
      if (user?.cityLat != null && user?.cityLng != null) {
        params.set("lat", String(user.cityLat));
        params.set("lon", String(user.cityLng));
      }
      const res = await fetch(`${PHOTON_URL}?${params}`);
      if (!res.ok) return;
      const data = await res.json() as { features: PhotonFeature[] };
      setVenueResults(data.features || []);
      setShowResults(true);
    } catch {
      setVenueResults([]);
    } finally {
      setSearchingVenue(false);
    }
  }, [user?.cityLat, user?.cityLng]);

  const handleVenueInput = (value: string) => {
    setVenueQuery(value);
    // If the user edits after selecting, clear the selection
    if (locationName && value !== locationName) {
      setLocationName("");
      setLocationAddress("");
      setLocationLat(undefined);
      setLocationLng(undefined);
      setShowAddress(false);
    }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchVenue(value), 400);
  };

  const updateLocationTag = useCallback((newTag: string | null) => {
    const oldTag = lastLocationTagRef.current;
    lastLocationTagRef.current = newTag;
    setTags((prev) => {
      let next = oldTag ? removeTagFromTags(prev, oldTag) : prev;
      if (newTag) next = mergeTagIntoTags(next, newTag);
      return next;
    });
  }, []);

  const selectVenue = (f: PhotonFeature) => {
    const { name, address } = extractVenueParts(f);
    const [lon, lat] = f.geometry.coordinates;
    setLocationName(name);
    setLocationAddress(address);
    setLocationLat(lat);
    setLocationLng(lon);
    setVenueQuery(name);
    setShowResults(false);
    setVenueResults([]);
    const city = extractCityFromPhotonFeature(f);
    updateLocationTag(city);
  };

  const selectSavedLocation = async (loc: SavedLocation) => {
    setLocationName(loc.name);
    setLocationAddress(loc.address || "");
    setLocationLat(loc.latitude ?? undefined);
    setLocationLng(loc.longitude ?? undefined);
    setVenueQuery(loc.name);
    setShowResults(false);
    setVenueResults([]);
    if (loc.latitude != null && loc.longitude != null) {
      try {
        const res = await fetch(
          `${PHOTON_REVERSE_URL}?lat=${loc.latitude}&lon=${loc.longitude}`
        );
        if (res.ok) {
          const data = (await res.json()) as { features?: PhotonFeature[] };
          const f = data.features?.[0];
          const city = f ? extractCityFromPhotonFeature(f) : null;
          updateLocationTag(city);
        } else {
          updateLocationTag(null);
        }
      } catch {
        updateLocationTag(null);
      }
    } else {
      updateLocationTag(null);
    }
  };

  const matchingSavedLocations = useMemo(() => {
    if (!venueQuery || venueQuery.length < 2) return savedLocations;
    const q = venueQuery.toLowerCase();
    const filtered = savedLocations.filter(
      (l) => l.name.toLowerCase().includes(q) || (l.address && l.address.toLowerCase().includes(q))
    );
    // Deduplicate by visible display (name + address); keep the one with coords or most recent
    const seen = new Map<string, SavedLocation>();
    for (const loc of filtered) {
      const key = `${loc.name}|${loc.address ?? ""}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, loc);
      } else {
        const locHasCoords = loc.latitude != null && loc.longitude != null;
        const existingHasCoords = existing.latitude != null && existing.longitude != null;
        const keep =
          locHasCoords && !existingHasCoords
            ? loc
            : !locHasCoords && existingHasCoords
              ? existing
              : existing.usedAt >= loc.usedAt
                ? existing
                : loc;
        seen.set(key, keep);
      }
    }
    return Array.from(seen.values());
  }, [venueQuery, savedLocations]);

  const clearVenue = () => {
    setVenueQuery("");
    setLocationName("");
    setLocationAddress("");
    setLocationLat(undefined);
    setLocationLng(undefined);
    setShowAddress(false);
    setManualLocation(false);
    setVenueResults([]);
    updateLocationTag(null);
  };

  const clearLocationCoords = useCallback(() => {
    setLocationLat(undefined);
    setLocationLng(undefined);
  }, []);

  const handleAddressBlur = useCallback(async (addressValue: string) => {
    const effectiveName = locationName || venueQuery.trim();
    const geocodeQuery = [effectiveName, addressValue].filter(Boolean).join(", ");
    if (!geocodeQuery || (locationLat != null && locationLng != null)) return;
    const looksLikeAddress = /[0-9,]/.test(geocodeQuery);
    const hasAddressContent = !!addressValue.trim();
    if (!manualLocation && !looksLikeAddress && !hasAddressContent) return;
    setResolvingAddress(true);
    try {
      const bias = user?.cityLat != null && user?.cityLng != null
        ? { lat: user.cityLat, lon: user.cityLng }
        : undefined;
      const geocoded = await geocodeAddress(geocodeQuery, bias);
      if (geocoded) {
        setLocationLat(geocoded.lat);
        setLocationLng(geocoded.lng);
        if (geocoded.city) updateLocationTag(geocoded.city);
      }
    } finally {
      setResolvingAddress(false);
    }
  }, [locationName, venueQuery, locationLat, locationLng, manualLocation, user?.cityLat, user?.cityLng, updateLocationTag]);

  const enterManualLocation = () => {
    setLocationName(venueQuery);
    setShowResults(false);
    setVenueResults([]);
    setManualLocation(true);
    setShowAddress(true);
  };

  // Keep end >= start when start changes
  useEffect(() => {
    if (!customEnd || !startDate) return;
    const minEnd = allDay ? startDate.slice(0, 10) : startDate;
    const endVal = allDay ? customEnd.slice(0, 10) : customEnd;
    if (endVal < minEnd) {
      setCustomEnd(minEnd);
    }
  }, [startDate, allDay, customEnd]);

  // Close dropdown when clicking outside; if no suggestion picked, unfold address field
  const maybeUnfoldAddress = useCallback(() => {
    const q = venueQuery.trim();
    if (q && !locationName) {
      setLocationName(q);
      setShowAddress(true);
      setShowResults(false);
    }
  }, [venueQuery, locationName]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (resultsRef.current && !resultsRef.current.contains(e.target as Node)) {
        setShowResults(false);
        maybeUnfoldAddress();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [maybeUnfoldAddress]);

  const switchLocationMode = (mode: LocationMode) => {
    setLocationMode(mode);
    if (mode === "online") {
      clearVenue();
      updateLocationTag("online");
    } else {
      setLocationUrl("");
      setLocationUrlError("");
      updateLocationTag(null);
    }
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setStartDate(defaultStart());
    setDuration("1h");
    setShowCustomEnd(false);
    setCustomEnd("");
    setImageUrl("");
    setImageAttribution(undefined);
    setImageLoaded(false);
    setUrl("");
    setUrlError("");
    setTags("");
    setVisibility(defaultVis);
    setError("");
    setLocationMode("inperson");
    setVenueQuery("");
    setLocationName("");
    setLocationAddress("");
    setLocationLat(undefined);
    setLocationLng(undefined);
    setLocationUrl("");
    setLocationUrlError("");
    setShowAddress(false);
    setManualLocation(false);
    setVenueResults([]);
    setShowResults(false);
    updateLocationTag(null);
    clearDraft();
  };

  const handleClearForm = () => {
    if (!window.confirm("Clear the form and start over? Your draft will be discarded.")) return;
    resetForm();
  };

  // ---- Handlers ----

  const selectDuration = (d: Duration) => {
    setDuration(d);
    if (showCustomEnd && startDate) {
      setCustomEnd(
        d === "allday" ? startDate.slice(0, 10) : addDuration(startDate, d)
      );
    } else {
      setCustomEnd(""); // Use preset when custom is closed
    }
  };

  const toggleCustomEnd = () => {
    if (!showCustomEnd) {
      setCustomEnd(
        duration === "allday"
          ? startDate.slice(0, 10)
          : endDate || (startDate ? addDuration(startDate, duration) : "")
      );
    }
    setShowCustomEnd(!showCustomEnd);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Check for commonly recommended fields; ask confirmation if any are missing (create mode only)
    if (!isEdit) {
      const missing: string[] = [];
      if (!imageUrl) missing.push("header image");
      if (!description.trim()) missing.push("description");
      const hasLocation =
        locationMode === "inperson"
          ? !!(locationName || venueQuery || locationAddress || (locationLat != null && locationLng != null))
          : !!locationUrl.trim();
      if (!hasLocation) missing.push("location");
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (tagList.length === 0) missing.push("tags");
      if (missing.length > 0) {
        const msg =
          missing.length === 1
            ? `You haven't set a ${missing[0]}. Are you sure you want to create this event?`
            : `You haven't set: ${missing.join(", ")}. Are you sure you want to create this event?`;
        if (!window.confirm(msg)) return;
      }
    }

    // Validate and normalize event URL if provided
    let resolvedUrl = url.trim() || undefined;
    if (resolvedUrl) {
      if (!/^https?:\/\//i.test(resolvedUrl) && /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}/i.test(resolvedUrl)) {
        resolvedUrl = `https://${resolvedUrl}`;
        setUrl(resolvedUrl);
      }
      if (!/^https?:\/\/.+/i.test(resolvedUrl)) {
        setUrlError("Please enter a valid URL (e.g. https://…)");
        return;
      }
    }
    setSubmitting(true);
    try {
      let locLat = locationLat;
      let locLng = locationLng;
      let locTags = tags;

      // Geocode when we have a custom address but no coords. Do NOT geocode vague
      // place names like "home" alone (from blurring without selecting). DO geocode
      // when: manualLocation, address-like text (digits/comma), or user typed in
      // the address field (e.g. typed venue, ignored suggestions, then filled address).
      const effectiveLocationName = locationName || venueQuery.trim();
      const geocodeQuery = [effectiveLocationName, locationAddress].filter(Boolean).join(", ");
      const looksLikeAddress = /[0-9,]/.test(geocodeQuery);
      const hasAddressFieldContent = !!(locationAddress?.trim());
      if (
        locationMode === "inperson" &&
        effectiveLocationName &&
        (locLat == null || locLng == null) &&
        (manualLocation || looksLikeAddress || hasAddressFieldContent)
      ) {
        const bias = user?.cityLat != null && user?.cityLng != null
          ? { lat: user.cityLat, lon: user.cityLng }
          : undefined;
        const geocoded = await geocodeAddress(geocodeQuery, bias);
        if (geocoded) {
          locLat = geocoded.lat;
          locLng = geocoded.lng;
          if (geocoded.city) {
            locTags = mergeTagIntoTags(locTags, geocoded.city);
          }
        }
      }

      const data: EventInput = {
        title,
        description: description || undefined,
        startDate: allDay ? startDate.slice(0, 10) : new Date(startDate).toISOString(),
        endDate: endDate
          ? allDay ? endDate.slice(0, 10) : new Date(endDate).toISOString()
          : undefined,
        allDay,
        visibility,
        url: resolvedUrl,
        tags: locTags
          ? locTags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
      };
      if (locationMode === "inperson" && effectiveLocationName) {
        data.location = {
          name: effectiveLocationName,
          address: locationAddress || undefined,
          latitude: locLat,
          longitude: locLng,
        };
      } else if (locationMode === "online") {
        data.location = {
          name: "Online",
          url: locationUrl || undefined,
        };
      }
      if (imageUrl) {
        data.image = { url: imageUrl, attribution: imageAttribution };
      }
      if (locationMode === "inperson" && effectiveLocationName) {
        locationsApi.save({
          name: effectiveLocationName,
          address: locationAddress || undefined,
          latitude: locLat,
          longitude: locLng,
        }).catch(() => {});
      }
      const event = isEdit && initialEvent
        ? await eventsApi.update(initialEvent.id, data)
        : await eventsApi.create(data);
      if (!isEdit) clearDraft();
      refreshUser().catch(() => {}); // Update auth context (e.g. for profile stats)
      navigate(eventPath(event));
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Derived for preview ----

  const parsedTags = tags
    ? tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  const previewDateStr = startDate
    ? formatEventDateTime(
        {
          startDate: allDay ? startDate.slice(0, 10) : new Date(startDate).toISOString(),
          endDate: endDate
            ? allDay ? endDate.slice(0, 10) : new Date(endDate).toISOString()
            : null,
          allDay,
        },
        true,
      )
    : null;

  const hasPreviewLocation =
    (locationMode === "inperson" && (venueQuery || locationName)) ||
    locationMode === "online";

  const previewLocationName = locationMode === "inperson" ? (locationName || venueQuery) : null;

  // ---- Render ----

  return (
    <div className="create-event-layout">
      {/* Live preview */}
      <article className="create-event-preview">
        <div className="header-image-wrap" style={{ marginBottom: "1.5rem" }}>
          <div className="header-image-skeleton" aria-hidden={imageLoaded}>
            <span className="skeleton-image-label">Header image</span>
          </div>
          {imageUrl && (
            <>
              <img
                src={imageUrl}
                alt={title || "Event image"}
                className={`header-image-img ${imageLoaded ? "header-image-loaded" : ""}`}
                onLoad={() => setImageLoaded(true)}
              />
              {imageAttribution && (
                <ImageAttributionBadge attribution={imageAttribution} position="top-right" />
              )}
            </>
          )}
          <div className={`header-image-actions ${!imageUrl ? "header-image-actions-visible" : ""}`}>
            {imageUrl ? (
              <>
                <button
                  type="button"
                  className="header-image-btn"
                  onClick={() => setImagePickerOpen(true)}
                  title="Choose different image"
                >
                  <ImageIcon />
                  Change
                </button>
                <button
                  type="button"
                  className="header-image-btn header-image-btn-danger"
                  onClick={() => { setImageUrl(""); setImageAttribution(undefined); setImageLoaded(false); }}
                  title="Remove image"
                >
                  <TrashIcon />
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                className="header-image-btn header-image-btn-add"
                onClick={() => setImagePickerOpen(true)}
                title="Add header image"
              >
                <ImageIcon />
                Add image
              </button>
            )}
          </div>
        </div>
        <ImagePickerModal
          isOpen={imagePickerOpen}
          onClose={() => setImagePickerOpen(false)}
          onSelect={(sel) => { setImageLoaded(false); setImageUrl(sel.url); setImageAttribution(sel.attribution); }}
          searchHint={inferImageSearchTerm(title)}
        />

        <div className="flex items-center justify-between mb-2">
          <div className="flex flex-col gap-1">
            {previewDateStr ? (
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>{previewDateStr}</span>
            ) : (
              <span className="skeleton-line" style={{ width: "220px", height: "1.1em" }} />
            )}
            {visibility !== "public" && (
              <span
                className={`visibility-badge ${visibility}`}
                style={{ alignSelf: "flex-start" }}
              >
                {visibility === "followers_only" ? "followers only" : visibility === "private" ? "Only me" : visibility}
              </span>
            )}
          </div>
        </div>

        {title ? (
          <h1
            style={{
              fontSize: "1.8rem",
              fontWeight: 700,
              lineHeight: 1.2,
              marginBottom: "0.5rem",
            }}
          >
            {title}
          </h1>
        ) : (
          <div style={{ marginBottom: "0.5rem" }}>
            <span className="skeleton-line" style={{ width: "60%", height: "1.8rem" }} />
          </div>
        )}

        <p className="text-muted mb-2">by {user.displayName || user.username}</p>

        {/* Location preview */}
        {hasPreviewLocation ? (
          locationMode === "online" ? (
            <p
              className="mb-2"
              style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}
            >
              <GlobeIcon />
              <span>Online</span>
              {locationUrl && (
                <>
                  <span style={{ color: "var(--text-dim)" }}>·</span>
                  <a
                    href={locationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem" }}
                  >
                    {(() => { try { return new URL(locationUrl).hostname; } catch { return locationUrl; } })()}
                    <ExternalLinkIcon className="text-sm" />
                  </a>
                </>
              )}
            </p>
          ) : (
            <p
              className="mb-2"
              style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
            >
              <LocationPinIcon />
              {previewLocationName}
              {locationAddress && ` — ${locationAddress}`}
            </p>
          )
        ) : (
          <p
            className="mb-2"
            style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
          >
            <LocationPinIcon />
            <span className="skeleton-line" style={{ width: "180px", height: "1em" }} />
          </p>
        )}

        {description ? (
          <div
            className="event-description"
            dangerouslySetInnerHTML={{ __html: description }}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
            <span className="skeleton-line" style={{ width: "100%", height: "0.9em" }} />
            <span className="skeleton-line" style={{ width: "92%", height: "0.9em" }} />
            <span className="skeleton-line" style={{ width: "75%", height: "0.9em" }} />
          </div>
        )}

        {url && (
          <p
            className="mt-2"
            style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
          >
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
              }}
            >
              <ExternalLinkIcon />
              {url}
            </a>
          </p>
        )}

        {parsedTags.length > 0 ? (
          <div className="flex gap-1 mt-2" style={{ flexWrap: "wrap" }}>
            {parsedTags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <div className="flex gap-1 mt-2">
            <span className="skeleton-tag" />
            <span className="skeleton-tag" style={{ width: "52px" }} />
            <span className="skeleton-tag" style={{ width: "44px" }} />
          </div>
        )}
      </article>

      {/* Form sidebar */}
      <aside className="create-event-form">
        <form onSubmit={handleSubmit}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "0.75rem",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: "1.1rem",
                color: "var(--text)",
              }}
            >
              {isEdit ? "Edit Event" : "New Event"}
            </div>
            {!isEdit && (
              <button
                type="button"
                onClick={handleClearForm}
                className="text-sm"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  padding: "0.25rem 0.5rem",
                  textDecoration: "underline",
                }}
                title="Clear form and discard draft"
              >
                Clear form
              </button>
            )}
          </div>

          {materialFieldsChanged && (
            <div
              className="field"
              style={{
                padding: "0.5rem 0.75rem",
                background: "var(--surface)",
                borderRadius: "var(--radius)",
                fontSize: "0.9rem",
                color: "var(--text-dim)",
              }}
            >
              Changing title, time, or location will notify users who RSVP&apos;d to this event and have email notifications enabled.
            </div>
          )}

          <div className="field">
            <label htmlFor="ce-title">Title *</label>
            <input
              id="ce-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="Event name"
            />
          </div>

          <div className="field">
            <label>Description</label>
            <RichTextEditor
              value={description}
              onChange={setDescription}
              placeholder="What's this event about?"
            />
          </div>

          <div className="field">
            <label htmlFor="ce-startDate">Start *</label>
            <input
              id="ce-startDate"
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? startDate.slice(0, 10) : startDate}
              onChange={(e) => setStartDate(e.target.value)}
              onBlur={(e) => {
                if (allDay) return;
                const completed = completeDatetimeLocal(e.target.value, "00:00");
                if (completed) setStartDate(completed);
              }}
              min={allDay ? minStartToday : minStartNow}
              required
            />
          </div>

          <div className="field">
            <label>Duration</label>
            <div className="flex gap-1" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => selectDuration(p.value)}
                  className={`duration-btn ${highlightedPreset === p.value ? "duration-btn-active" : ""}`}
                >
                  {p.label}
                </button>
              ))}
              <span className="duration-sep" />
              <button
                type="button"
                onClick={() => selectDuration("allday")}
                className={`duration-btn duration-btn-allday ${highlightedPreset === "allday" ? "duration-btn-active" : ""}`}
              >
                All day
              </button>
              <span className="duration-sep" />
              <button
                type="button"
                onClick={toggleCustomEnd}
                className={`duration-btn duration-btn-custom ${showCustomEnd ? "duration-btn-active" : ""}`}
              >
                Custom
              </button>
            </div>
          </div>

          {showCustomEnd && (
            <div className="field">
              <label htmlFor="ce-endDate">End</label>
              <input
                id="ce-endDate"
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? customEnd.slice(0, 10) : customEnd}
                onChange={(e) => {
                  const val = e.target.value;
                  const min = allDay ? startDate.slice(0, 10) : startDate;
                  setCustomEnd(val && val < min ? min : val);
                }}
                onBlur={(e) => {
                  if (allDay) return;
                  const val = e.target.value;
                  const datePart = val.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
                  const defaultTime =
                    datePart && startDate.startsWith(datePart)
                      ? addDuration(startDate, "1h").slice(11, 16)
                      : "00:00";
                  const completed = completeDatetimeLocal(val, defaultTime);
                  if (completed) setCustomEnd(completed);
                }}
                min={allDay ? startDate.slice(0, 10) : startDate}
              />
            </div>
          )}

          {/* Location */}
          <div className="field">
            <label>Location</label>
            <div className="flex gap-1" style={{ marginBottom: "0.4rem" }}>
              <button
                type="button"
                onClick={() => switchLocationMode("inperson")}
                className={`duration-btn ${locationMode === "inperson" ? "duration-btn-active" : ""}`}
              >
                In person
              </button>
              <button
                type="button"
                onClick={() => switchLocationMode("online")}
                className={`duration-btn ${locationMode === "online" ? "duration-btn-active" : ""}`}
              >
                Online
              </button>
            </div>

            {locationMode === "inperson" && (
              <div ref={resultsRef}>
                {!manualLocation && (
                  <>
                    <div style={{ position: "relative" }}>
                      <input
                        value={venueQuery}
                        onChange={(e) => handleVenueInput(e.target.value)}
                        onFocus={() => {
                          if (venueResults.length > 0 || savedLocations.length > 0) setShowResults(true);
                        }}
                        onBlur={() => {
                          setTimeout(() => maybeUnfoldAddress(), 150);
                        }}
                        placeholder="Search venue or place…"
                        autoComplete="off"
                      />
                      {locationName && (
                        <button
                          type="button"
                          onClick={clearVenue}
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
                      {showResults && (matchingSavedLocations.length > 0 || venueResults.length > 0 || (!searchingVenue && venueQuery.length >= 3)) && (
                        <div className="venue-dropdown">
                    {matchingSavedLocations.length > 0 && (
                      <>
                        {matchingSavedLocations.map((loc) => (
                          <div
                            key={`saved-${loc.id}`}
                            className="venue-dropdown-item"
                            style={{ display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "space-between" }}
                          >
                            <button
                              type="button"
                              onClick={() => selectSavedLocation(loc)}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                display: "flex",
                                alignItems: "baseline",
                                gap: "0.5rem",
                                background: "none",
                                border: "none",
                                padding: 0,
                                color: "inherit",
                                cursor: "pointer",
                                font: "inherit",
                                textAlign: "left",
                              }}
                            >
                              <span className="venue-dropdown-name">{loc.name}</span>
                              <span className="venue-dropdown-addr">{loc.address || ""}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                locationsApi.delete(loc.id).then(() => {
                                  setSavedLocations((prev) => prev.filter((l) => l.id !== loc.id));
                                }).catch(() => {});
                              }}
                              title="Remove from suggestions"
                              className="venue-dropdown-remove"
                              style={{
                                flexShrink: 0,
                                width: "1.25rem",
                                height: "1.25rem",
                                padding: 0,
                                borderRadius: "50%",
                                border: "none",
                                background: "transparent",
                                color: "var(--text-dim)",
                                cursor: "pointer",
                                fontSize: "0.9rem",
                                lineHeight: 1,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        {venueResults.length > 0 && (
                          <div className="venue-dropdown-sep" />
                        )}
                      </>
                    )}
                    {venueResults.map((f) => {
                      const v = extractVenueParts(f);
                      return (
                        <button
                          key={f.properties.osm_id}
                          type="button"
                          className="venue-dropdown-item"
                          onClick={() => selectVenue(f)}
                        >
                          <span className="venue-dropdown-name">{v.name}</span>
                          <span className="venue-dropdown-addr">{v.address}</span>
                        </button>
                      );
                    })}
                    {(venueResults.length > 0 || (!searchingVenue && venueQuery.length >= 3)) && (
                      <button
                        type="button"
                        className="venue-dropdown-item venue-dropdown-manual"
                        onClick={enterManualLocation}
                      >
                        {venueResults.length === 0 && matchingSavedLocations.length === 0
                          ? "No results — enter location manually"
                          : "Not in this list? Enter manually"}
                      </button>
                    )}
                        </div>
                      )}
                    </div>
                    {searchingVenue && (
                      <div className="text-sm text-muted" style={{ marginTop: "0.2rem" }}>
                        Searching…
                      </div>
                    )}
                  </>
                )}
                {!manualLocation && locationName && !showAddress && (
                  <div style={{ marginTop: "0.3rem" }}>
                    <span className="text-sm text-muted">
                      {locationAddress}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowAddress(true)}
                      className="duration-btn duration-btn-custom"
                      style={{ marginLeft: "0.4rem", fontSize: "0.72rem" }}
                    >
                      Edit address
                    </button>
                  </div>
                )}
                {locationName && locationLat != null && locationLng != null && (
                  <div style={{ marginTop: "0.5rem", position: "relative" }}>
                    <button
                      type="button"
                      onClick={clearLocationCoords}
                      title="Remove map and coordinates"
                      style={{
                        position: "absolute",
                        right: "0.5rem",
                        top: "0.5rem",
                        zIndex: 1000,
                        width: "1.75rem",
                        height: "1.75rem",
                        minWidth: "1.75rem",
                        minHeight: "1.75rem",
                        padding: 0,
                        borderRadius: "50%",
                        border: "1px solid rgba(0,0,0,0.2)",
                        background: "rgba(13, 13, 13, 0.92)",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontSize: "1.1rem",
                        lineHeight: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                      }}
                    >
                      ×
                    </button>
                    <LocationMap
                      location={{ name: locationName, address: locationAddress }}
                      latitude={locationLat}
                      longitude={locationLng}
                      compact
                      onMarkerDrag={(lat, lng) => {
                        setLocationLat(lat);
                        setLocationLng(lng);
                      }}
                    />
                  </div>
                )}
                {manualLocation && (
                  <div style={{ marginTop: "0.4rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                    <div>
                      <label htmlFor="ce-locname" className="text-sm">Venue name</label>
                      <input
                        id="ce-locname"
                        value={locationName}
                        onChange={(e) => setLocationName(e.target.value)}
                        placeholder="e.g. Flex"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label htmlFor="ce-address" className="text-sm">Address (optional)</label>
                      <div style={{ position: "relative" }}>
                        <input
                          id="ce-address"
                          value={locationAddress}
                          onChange={(e) => setLocationAddress(e.target.value)}
                          onBlur={(e) => handleAddressBlur((e.target as HTMLInputElement).value)}
                          placeholder="Street, city"
                          style={resolvingAddress ? { paddingRight: "2.25rem" } : undefined}
                        />
                        {resolvingAddress && (
                          <div
                            className="address-field-spinner"
                            style={{
                              position: "absolute",
                              right: "0.6rem",
                              top: "50%",
                              transform: "translateY(-50%)",
                              pointerEvents: "none",
                            }}
                          />
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={clearVenue}
                      className="text-sm"
                      style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: 0, textAlign: "left" }}
                    >
                      ← Back to search
                    </button>
                  </div>
                )}
                {!manualLocation && (showAddress || venueQuery.trim().length >= 2) && (
                  <div style={{ marginTop: "0.4rem" }}>
                    <label htmlFor="ce-address" className="text-sm">Address</label>
                    <div style={{ position: "relative" }}>
                      <input
                        id="ce-address"
                        value={locationAddress}
                        onChange={(e) => setLocationAddress(e.target.value)}
                        onFocus={() => {
                          if (venueQuery.trim() && !locationName) {
                            setLocationName(venueQuery.trim());
                            setShowAddress(true);
                            setShowResults(false);
                          }
                        }}
                        onBlur={(e) => handleAddressBlur((e.target as HTMLInputElement).value)}
                        placeholder="Street, city"
                        style={resolvingAddress ? { paddingRight: "2.25rem" } : undefined}
                      />
                      {resolvingAddress && (
                        <div
                          className="address-field-spinner"
                          style={{
                            position: "absolute",
                            right: "0.6rem",
                            top: "50%",
                            transform: "translateY(-50%)",
                            pointerEvents: "none",
                          }}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {locationMode === "online" && (
              <div>
                <input
                  type="url"
                  value={locationUrl}
                  onChange={(e) => { setLocationUrl(e.target.value); setLocationUrlError(""); }}
                  onBlur={() => {
                    if (!locationUrl) return;
                    let url = locationUrl.trim();
                    if (!/^https?:\/\//i.test(url) && /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}/i.test(url)) {
                      url = `https://${url}`;
                      setLocationUrl(url);
                    }
                    if (!/^https?:\/\/.+/i.test(url)) {
                      setLocationUrlError("Please enter a valid URL (e.g. https://…)");
                    }
                  }}
                  placeholder="https://… (optional)"
                  style={locationUrlError ? { borderColor: "var(--danger)" } : undefined}
                />
                {locationUrlError && (
                  <p className="text-sm" style={{ color: "var(--danger)", marginTop: "0.2rem" }}>{locationUrlError}</p>
                )}
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="ce-url">Event URL</label>
            <input
              id="ce-url"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setUrlError(""); }}
              onBlur={() => {
                if (!url) return;
                let urlVal = url.trim();
                if (!/^https?:\/\//i.test(urlVal) && /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}/i.test(urlVal)) {
                  urlVal = `https://${urlVal}`;
                  setUrl(urlVal);
                }
                if (!/^https?:\/\/.+/i.test(urlVal)) {
                  setUrlError("Please enter a valid URL (e.g. https://…)");
                }
              }}
              placeholder="https://... (optional)"
              style={urlError ? { borderColor: "var(--danger)" } : undefined}
            />
            {urlError && (
              <p className="text-sm" style={{ color: "var(--danger)", marginTop: "0.2rem" }}>{urlError}</p>
            )}
          </div>

          <div className="field">
            <label htmlFor="ce-tags">Tags</label>
            <TagInput
              id="ce-tags"
              value={tags}
              onChange={setTags}
              placeholder="e.g. music, wien, concert"
            />
          </div>

          <div className="field">
            <label htmlFor="ce-visibility">Visibility</label>
            <select
              id="ce-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="followers_only">Followers only</option>
              <option value="private">Only me</option>
            </select>
          </div>

          {error && <p className="error-text mb-2">{error}</p>}

          <div style={{ display: "flex", gap: "0.5rem", width: "100%" }}>
            {isEdit && (
              <Link href={initialEvent ? eventPath(initialEvent) : "/"}>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={submitting}
                  style={{ flexShrink: 0 }}
                >
                  Cancel
                </button>
              </Link>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting}
              style={{ flex: 1, minWidth: 0 }}
            >
              {submitting
                ? (isEdit ? "Saving…" : "Creating…")
                : (isEdit ? "Save Changes" : "Create Event")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
