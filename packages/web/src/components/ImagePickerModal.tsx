/**
 * Fold-out panel for choosing an event header image (80vh, like homepage tags):
 * - Search Unsplash/Openverse by query (all licenses allowed)
 * - Paste a URL
 * - Upload a file (stored on server)
 *
 * Closes by: scrolling up (window scroll), clicking darkened overlay, or close button.
 * Inner scroll (image grid) works independently for loading more images.
 *
 * Attribution is saved for Unsplash/Openverse images per API guidelines.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { images as imagesApi, uploads, type ImageSearchResult, type ImageAttribution } from "../lib/api";
import { SearchIcon, LinkIcon, UploadIcon, ChevronUpIcon } from "./icons";

type Tab = "search" | "url" | "upload";

export interface ImageSelection {
  url: string;
  attribution?: ImageAttribution;
}

interface ImagePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (selection: ImageSelection) => void;
  searchHint?: string;
}

const SCROLL_CLOSE_RANGE = 80;

export function ImagePickerModal({
  isOpen,
  onClose,
  onSelect,
  searchHint = "",
}: ImagePickerModalProps) {
  const { t } = useTranslation(["createEvent", "common"]);
  const [tab, setTab] = useState<Tab>("search");
  const [searchQuery, setSearchQuery] = useState(searchHint);
  const [searchResults, setSearchResults] = useState<ImageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);
  const [source, setSource] = useState<string>("auto");
  const [sources, setSources] = useState<{ sources: string[]; unsplashAvailable: boolean } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unfoldScrollYRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const resultsScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<() => void>(() => {});

  const PAGE_SIZE = 12;

  useEffect(() => {
    if (isOpen) {
      imagesApi.getSources().then((s) => s && setSources(s));
      unfoldScrollYRef.current = typeof window !== "undefined" ? window.scrollY : 0;
    }
  }, [isOpen]);

  // Scroll-to-close: when user scrolls up (scrollY decreases), close. Window scroll only — inner panel scroll (images) does not trigger.
  useEffect(() => {
    if (!isOpen) return;
    const handleScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const y = window.scrollY;
        const delta = unfoldScrollYRef.current - y; // positive when user scrolled up
        const progress = Math.min(Math.max(delta / SCROLL_CLOSE_RANGE, 0), 1);
        if (progress >= 1) onClose();
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [isOpen, onClose]);

  const searchOptions = () => {
    const opts: { source?: string } = {};
    if (source !== "auto") opts.source = source;
    return opts;
  };

  const handleSelectSearchResult = async (item: ImageSearchResult) => {
    if (item.attribution?.source === "unsplash" && item.attribution.downloadLocation) {
      await imagesApi.triggerDownload(item.attribution.downloadLocation);
    }
    onSelect({ url: item.url, attribution: item.attribution });
    onClose();
  };

  // Typeahead: search automatically as user types (debounced)
  useEffect(() => {
    if (tab !== "search") return;
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setPage(1);
      setHasMore(true);
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      setSearchResults([]);
      setPage(1);
      setHasMore(true);
      try {
        const result = await imagesApi.search(q, PAGE_SIZE, 1, searchOptions());
        if (result?.results) {
          setSearchResults(result.results);
          setHasMore(result.results.length >= PAGE_SIZE);
        }
      } catch {
        setSearchResults([]);
        setHasMore(false);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [tab, searchQuery, source]);

  const loadMore = async () => {
    const q = searchQuery.trim();
    if (q.length < 2 || loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const result = await imagesApi.search(q, PAGE_SIZE, nextPage, searchOptions());
      if (result?.results?.length) {
        setSearchResults((prev) => [...prev, ...result.results]);
        setPage(nextPage);
        setHasMore(result.results.length >= PAGE_SIZE);
      } else {
        setHasMore(false);
      }
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };
  loadMoreRef.current = loadMore;

  // Load more when user scrolls to bottom of results (inside the fold)
  useEffect(() => {
    if (!isOpen || tab !== "search" || !hasMore || loadingMore) return;
    const sentinel = loadMoreSentinelRef.current;
    const scrollRoot = resultsScrollRef.current;
    if (!sentinel || !scrollRoot) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { root: scrollRoot, rootMargin: "100px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isOpen, tab, hasMore, loadingMore, searchResults.length]);

  const handleUrlSubmit = () => {
    const u = urlInput.trim();
    if (!u) return;
    try {
      new URL(u);
      if (!/^https?:/i.test(u)) throw new Error("Must be http or https");
      setUrlError("");
      onSelect({ url: u });
      onClose();
    } catch {
      setUrlError(t("invalidImageUrl"));
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await uploads.upload(file);
      onSelect({ url: result.url });
      onClose();
    } catch {
      setUploadError(t("uploadFailed"));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  useEffect(() => {
    if (isOpen) {
      setUrlError("");
      setUploadError("");
      setSearchQuery(searchHint);
    }
  }, [isOpen, searchHint]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="image-picker-fold-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-picker-title"
      >
        <div className="image-picker-fold-header">
          <h2 id="image-picker-title" className="image-picker-fold-title">
            {t("chooseHeaderImage")}
          </h2>
          <button
            type="button"
            className="image-picker-fold-close"
            onClick={onClose}
            aria-label={t("common:close")}
          >
            <ChevronUpIcon />
          </button>
        </div>
        <div className="image-picker-tabs">
          <button
            type="button"
            className={`duration-btn ${tab === "search" ? "duration-btn-active" : ""}`}
            onClick={() => { setTab("search"); setUrlError(""); setUploadError(""); }}
          >
            <SearchIcon className="icon-sm" />
            {t("common:search")}
          </button>
          <button
            type="button"
            className={`duration-btn ${tab === "url" ? "duration-btn-active" : ""}`}
            onClick={() => { setTab("url"); setUrlError(""); setUploadError(""); }}
          >
            <LinkIcon className="icon-sm" />
            URL
          </button>
          <button
            type="button"
            className={`duration-btn ${tab === "upload" ? "duration-btn-active" : ""}`}
            onClick={() => { setTab("upload"); setUrlError(""); setUploadError(""); }}
          >
            <UploadIcon className="icon-sm" />
            {t("upload")}
          </button>
        </div>
        {tab === "search" && (
          <div className="image-picker-fold-search-bar">
            <div className="field">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("searchImages")}
                autoFocus
                autoComplete="off"
              />
              {searching && (
                <p className="text-sm text-muted" style={{ marginTop: "0.25rem" }}>{t("searchingImages")}</p>
              )}
            </div>
            <div className="image-picker-filters">
              {sources && sources.unsplashAvailable && (
                <div className="field">
                  <label>{t("source")}</label>
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  >
                    <option value="auto">{t("sourceAuto")}</option>
                    <option value="unsplash">{t("sourceUnsplash")}</option>
                    <option value="openverse">{t("sourceOpenverse")}</option>
                  </select>
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={resultsScrollRef} className="image-picker-fold-body">
          {tab === "search" && (
            <div className="image-picker-search">
              {searchResults.length > 0 && (
                <>
                  <div className="image-picker-results">
                    {searchResults.map((item) => (
                      <button
                        key={item.url}
                        type="button"
                        className="image-picker-result"
                        onClick={() => handleSelectSearchResult(item)}
                      >
                        <img src={item.url} alt="" />
                      </button>
                    ))}
                  </div>
                  {hasMore && (
                    <div ref={loadMoreSentinelRef} className="image-picker-fold-sentinel" aria-hidden />
                  )}
                </>
              )}
              {!searching && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
                <p className="text-muted text-sm">{t("noImagesFound")}</p>
              )}
            </div>
          )}
          {tab === "url" && (
            <div className="image-picker-url">
              <div className="field">
                <label htmlFor="image-picker-url">{t("imageUrl")}</label>
                <input
                  id="image-picker-url"
                  type="url"
                  value={urlInput}
                  onChange={(e) => { setUrlInput(e.target.value); setUrlError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
                  placeholder={t("imageUrlPlaceholder")}
                  autoFocus
                />
                {urlError && <p className="text-sm" style={{ color: "var(--danger)", marginTop: "0.25rem" }}>{urlError}</p>}
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={handleUrlSubmit}
                disabled={!urlInput.trim()}
              >
                {t("useThisUrl")}
              </button>
            </div>
          )}
          {tab === "upload" && (
            <div className="image-picker-upload">
              <p className="text-muted text-sm" style={{ marginBottom: "0.75rem" }}>
                {t("uploadImageDesc")}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleUpload}
                disabled={uploading}
                style={{ display: "none" }}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? t("uploading") : t("chooseFile")}
              </button>
              {uploadError && (
                <p className="text-sm" style={{ color: "var(--danger)", marginTop: "0.25rem" }}>{uploadError}</p>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="image-picker-fold-spacer" aria-hidden />
      <div
        className="image-picker-fold-overlay"
        onClick={onClose}
        onKeyDown={(e) => e.key === "Enter" && onClose()}
        role="button"
        tabIndex={0}
        aria-label={t("common:close")}
      />
    </>
  );
}
