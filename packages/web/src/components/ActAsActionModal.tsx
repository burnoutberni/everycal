import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  identities as identitiesApi,
  type ActorSelectionApplyResponse,
  type PublishingIdentity,
} from "../lib/api";
import { useAuth } from "../hooks/useAuth";

type ActionKind = "follow" | "autoRepost" | "repost";

type ActorOption = {
  id: string;
  username: string;
  displayName: string | null;
  isSelf: boolean;
};

export function ActAsActionModal({
  open,
  onClose,
  onComplete,
  excludedAccountIds,
  actionKind,
  loadState,
  apply,
}: {
  open: boolean;
  onClose: () => void;
  onComplete?: (errorMessage: string | null) => void;
  excludedAccountIds?: string[];
  actionKind: ActionKind;
  loadState: () => Promise<{ activeAccountIds: string[] }>;
  apply: (desiredAccountIds: string[]) => Promise<ActorSelectionApplyResponse>;
}) {
  const { t } = useTranslation(["common"]);
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [options, setOptions] = useState<ActorOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [initial, setInitial] = useState<string[]>([]);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const fieldWrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const listboxId = useId();

  const actionLabel = actionKind === "follow"
    ? t("followAs")
    : actionKind === "autoRepost"
      ? t("autoRepostAs")
      : t("repostAs");

  useEffect(() => {
    if (!open || !user) return;
    setLoading(true);
    setError("");
    setDropdownOpen(false);
    setActiveIndex(-1);
    setQuery("");
    Promise.all([identitiesApi.list(), loadState()])
      .then(([identityRes, state]) => {
        const excluded = new Set(excludedAccountIds || []);
        const normalized = [
          {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            isSelf: true,
          },
          ...identityRes.identities.map((identity: PublishingIdentity) => ({
            id: identity.id,
            username: identity.username,
            displayName: identity.displayName,
            isSelf: false,
          })),
        ];
        const seen = new Set<string>();
        const deduped = normalized.filter((opt) => {
          if (excluded.has(opt.id)) return false;
          if (seen.has(opt.id)) return false;
          seen.add(opt.id);
          return true;
        });
        setOptions(deduped);
        const optionIds = new Set(deduped.map((opt) => opt.id));
        const initialIds = state.activeAccountIds.filter((id) => optionIds.has(id));
        setInitial(initialIds);
        setSelected(initialIds);
      })
      .catch(() => setError(t("requestFailed")))
      .finally(() => setLoading(false));
  }, [open, user, loadState, excludedAccountIds, t]);

  useEffect(() => {
    if (!open || loading) return;
    const toFocus = inputRef.current
      ?? dialogRef.current?.querySelector<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )
      ?? null;
    toFocus?.focus();
  }, [open, loading]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (dropdownOpen) {
          setDropdownOpen(false);
          setActiveIndex(-1);
          return;
        }
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (!active || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, dropdownOpen]);

  useEffect(() => {
    if (!open || !dropdownOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (fieldWrapRef.current && !fieldWrapRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, dropdownOpen]);

  const byId = useMemo(() => new Map(options.map((opt) => [opt.id, opt])), [options]);

  const selectedOptions = selected
    .map((id) => byId.get(id))
    .filter((opt): opt is ActorOption => !!opt);

  const lower = query.trim().toLowerCase();
  const availableOptions = useMemo(
    () => options.filter((opt) => {
      if (selected.includes(opt.id)) return false;
      if (!lower) return true;
      return (
        opt.username.toLowerCase().includes(lower) ||
        (opt.displayName || "").toLowerCase().includes(lower)
      );
    }),
    [options, selected, lower]
  );
  const visibleOptions = useMemo(() => availableOptions.slice(0, 8), [availableOptions]);

  useEffect(() => {
    if (!dropdownOpen || visibleOptions.length === 0) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((current) => {
      if (current < 0) return 0;
      if (current >= visibleOptions.length) return visibleOptions.length - 1;
      return current;
    });
  }, [dropdownOpen, visibleOptions]);

  const dirty = useMemo(() => {
    const a = new Set(initial);
    const b = new Set(selected);
    if (a.size !== b.size) return true;
    for (const id of a) {
      if (!b.has(id)) return true;
    }
    return false;
  }, [initial, selected]);

  const addAccount = (id: string) => {
    if (selected.includes(id)) return;
    setSelected((prev) => [...prev, id]);
    setQuery("");
    setDropdownOpen(true);
  };

  const removeAccount = (id: string) => {
    setSelected((prev) => prev.filter((value) => value !== id));
  };

  const submit = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await apply(selected);
      const failedRows = res.results.filter((row) => row.status === "error");
      if (failedRows.length > 0) {
        const firstMessage = failedRows[0]?.message?.trim();
        onComplete?.(firstMessage || t("requestFailed"));
      } else {
        onComplete?.(null);
      }
      onClose();
    } catch (err) {
      onComplete?.(err instanceof Error ? err.message : t("requestFailed"));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!dropdownOpen) setDropdownOpen(true);
      if (visibleOptions.length > 0) {
        setActiveIndex((current) => {
          if (current < 0) return 0;
          return Math.min(current + 1, visibleOptions.length - 1);
        });
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!dropdownOpen) setDropdownOpen(true);
      if (visibleOptions.length > 0) {
        setActiveIndex((current) => {
          if (current <= 0) return 0;
          return current - 1;
        });
      }
      return;
    }
    if (event.key === "Enter") {
      if (dropdownOpen && activeIndex >= 0 && visibleOptions[activeIndex]) {
        event.preventDefault();
        addAccount(visibleOptions[activeIndex].id);
      }
      return;
    }
    if (event.key === "Escape") {
      if (dropdownOpen) {
        event.preventDefault();
        event.stopPropagation();
        setDropdownOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (event.key === "Backspace" && query.length === 0 && selected.length > 0) {
      const lastId = selected[selected.length - 1];
      if (lastId) {
        event.preventDefault();
        removeAccount(lastId);
      }
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-card act-as-modal-card" ref={dialogRef}>
        <div className="modal-header">
          <h2 id={headingId} style={{ fontSize: "1rem", fontWeight: 600 }}>{actionLabel}</h2>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} aria-label={t("close")}>
            ✕
          </button>
        </div>
        <div className="modal-body act-as-modal-body">
          {loading ? (
            <p className="text-muted">{t("loading")}</p>
          ) : (
            <>
              <p className="text-sm text-muted">{t("actAsHint")}</p>
              <div className="act-as-field-wrap" ref={fieldWrapRef}>
                <div className="act-as-chip-input">
                  {selectedOptions.map((opt) => (
                    <span key={opt.id} className="act-as-chip">
                      @{opt.username}
                      <button
                        type="button"
                        onClick={() => removeAccount(opt.id)}
                        aria-label={`${t("remove")} @${opt.username}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setDropdownOpen(true);
                    }}
                    onFocus={() => setDropdownOpen(true)}
                    onKeyDown={handleInputKeyDown}
                    placeholder={t("addAccountPlaceholder")}
                    className="act-as-chip-input-control"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={dropdownOpen && visibleOptions.length > 0}
                    aria-controls={listboxId}
                    aria-activedescendant={
                      dropdownOpen && activeIndex >= 0 && visibleOptions[activeIndex]
                        ? `${listboxId}-option-${visibleOptions[activeIndex].id}`
                        : undefined
                    }
                  />
                </div>
                {dropdownOpen && visibleOptions.length > 0 && (
                  <div className="act-as-dropdown" role="listbox" id={listboxId}>
                    {visibleOptions.map((opt, index) => (
                      <button
                        key={opt.id}
                        id={`${listboxId}-option-${opt.id}`}
                        type="button"
                        className="act-as-dropdown-item"
                        role="option"
                        aria-selected={activeIndex === index}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => addAccount(opt.id)}
                      >
                        <span>@{opt.username}</span>
                        {opt.isSelf && <span className="text-dim">{t("actAsYou")}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-1 mt-2" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
                  {t("close")}
                </button>
                <button type="button" className="btn-primary btn-sm" onClick={submit} disabled={saving || !dirty}>
                  {saving ? t("saving") : t("confirmChanges")}
                </button>
              </div>

              {error && <p className="error-text mt-1" role="alert">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
