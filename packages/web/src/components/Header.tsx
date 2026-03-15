import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { profilePath } from "../lib/urls";
import { CalendarIcon, GlobeIcon, HamburgerIcon, KeyIcon, ListIcon, LogOutIcon, PlusIcon, SettingsIcon, UserIcon } from "./icons";
import { Logo } from "./Logo";

export function Header() {
  const { t } = useTranslation("common");
  const { user, logout, authStatus } = useAuth();
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const showAuthenticated = authStatus === "authenticated" && !!user;
  const showAnonymous = authStatus === "anonymous";
  const showAuthSkeleton = authStatus === "unknown";
  const myProfilePath = showAuthenticated && user ? profilePath(user.username) : "";
  const onCalendar = location.startsWith("/calendar");

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
    setDrawerOpen(false);
  }, [location]);

  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape") setDrawerOpen(false);
      };
      document.addEventListener("keydown", handleEscape);
      return () => {
        document.body.style.overflow = "";
        document.removeEventListener("keydown", handleEscape);
      };
    } else {
      document.body.style.overflow = "";
    }

    return undefined;
  }, [drawerOpen]);

  return (
    <header
      className="app-header"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <nav className="container flex items-center justify-between" style={{ height: "3.5rem" }}>
        {/* Desktop: full nav */}
        <div className="header-nav-desktop flex items-center gap-2">
          <Link
            href="/?reset=1"
            style={{ display: "flex", alignItems: "center", marginRight: "1rem" }}
          >
            <Logo />
          </Link>
          <NavLink href="/" current={location}>
            {t("events")}
          </NavLink>
          <NavLink href="/discover" current={location}>
            {t("discover")}
          </NavLink>
        </div>

        {/* Mobile: logo (left) */}
        <div className="header-nav-mobile header-nav-mobile-left">
          <Link
            href="/?reset=1"
            style={{ display: "flex", alignItems: "center" }}
          >
            <Logo />
          </Link>
        </div>

        {/* Desktop + Mobile right side */}
        <div className="flex items-center gap-1">
          {showAuthenticated && user ? (
            <>
              {/* Desktop: calendar, plus, user menu */}
              <div className="header-nav-desktop flex items-center gap-1">
                <Link
                  href="/calendar"
                  className={`header-icon-btn header-icon-btn-calendar ${onCalendar ? "header-icon-btn-active" : ""}`}
                  title={t("myCalendar")}
                >
                  <CalendarIcon />
                </Link>
                <span className="header-icon-sep" aria-hidden="true" />
                <Link
                  href="/create"
                  className="header-icon-btn"
                  title={t("createNewEvent")}
                >
                  <PlusIcon />
                </Link>
              </div>
              <div ref={menuRef} className="header-nav-desktop" style={{ position: "relative" }}>
                <button
                  type="button"
                  className="header-user-btn"
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-expanded={menuOpen}
                  aria-haspopup="true"
                >
                  <span
                    className="header-user-avatar"
                    style={{
                      background: user.avatarUrl ? undefined : "var(--bg-hover)",
                      color: user.avatarUrl ? undefined : "var(--text-muted)",
                    }}
                  >
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt="" />
                    ) : (
                      user.username[0].toUpperCase()
                    )}
                  </span>
                  <span className="header-user-name">{user.displayName || user.username}</span>
                </button>
                {menuOpen && (
                  <div className="header-dropdown">
                    <Link
                      href={myProfilePath}
                      className="header-dropdown-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      <UserIcon /> {t("myProfile")}
                    </Link>
                    <Link
                      href="/calendar"
                      className="header-dropdown-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      <CalendarIcon /> {t("myCalendar")}
                    </Link>
                    <Link
                      href="/settings"
                      className="header-dropdown-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      <SettingsIcon /> {t("settings")}
                    </Link>
                    <button
                      type="button"
                      className="header-dropdown-item header-dropdown-item-muted"
                      onClick={() => {
                        setMenuOpen(false);
                        logout();
                      }}
                    >
                      <LogOutIcon /> {t("logOut")}
                    </button>
                  </div>
                )}
              </div>

              {/* Mobile: My Calendar (icon only) + separator + hamburger */}
              <div className="header-nav-mobile flex items-center gap-1">
                <Link
                  href="/calendar"
                  className={`header-icon-btn header-icon-btn-calendar ${onCalendar ? "header-icon-btn-active" : ""}`}
                  title={t("myCalendar")}
                >
                  <CalendarIcon />
                </Link>
                <span className="header-icon-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="header-hamburger-btn"
                  onClick={() => setDrawerOpen(true)}
                  aria-label={t("menu")}
                  aria-expanded={drawerOpen}
                >
                  <HamburgerIcon />
                </button>
              </div>
            </>
          ) : showAnonymous ? (
            <>
              <div className="header-nav-desktop">
                <Link href="/login">
                  <button className="btn-ghost btn-sm">{t("logIn")}</button>
                </Link>
                <Link href="/register">
                  <button className="btn-primary btn-sm">{t("signUp")}</button>
                </Link>
              </div>
              <div className="header-nav-mobile">
                <button
                  type="button"
                  className="header-hamburger-btn"
                  onClick={() => setDrawerOpen(true)}
                  aria-label={t("menu")}
                  aria-expanded={drawerOpen}
                >
                  <HamburgerIcon />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="header-nav-desktop flex items-center gap-1">
                <div className="header-auth-skeleton" aria-hidden="true">
                  <span className="header-user-avatar header-auth-skeleton-avatar" />
                  <span className="header-auth-skeleton-line" />
                </div>
                <button type="button" className="header-icon-btn" disabled aria-label={t("account")}>
                  <UserIcon />
                </button>
              </div>
              <div className="header-nav-mobile">
                <div className="header-auth-skeleton-mobile" aria-hidden="true">
                  <span className="header-user-avatar header-auth-skeleton-avatar" />
                </div>
              </div>
            </>
          )}
        </div>
      </nav>

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div
          className="header-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
          role="button"
          tabIndex={0}
          aria-label={t("closeMenu")}
        />
      )}

      {/* Mobile drawer */}
      <div
        className={`header-drawer ${drawerOpen ? "header-drawer-open" : ""}`}
        role="dialog"
        aria-label={t("menu")}
      >
        <div className="header-drawer-header">
          <span className="header-drawer-title">{showAuthenticated && user ? (user.displayName || user.username) : t("menu")}</span>
          <button
            type="button"
            className="header-drawer-close"
            onClick={() => setDrawerOpen(false)}
            aria-label={t("closeMenu")}
          >
            ×
          </button>
        </div>
        <nav className="header-drawer-nav">
          {showAuthenticated && user && (
            <Link
              href="/calendar"
              className={`header-drawer-item ${onCalendar ? "header-drawer-item-active" : ""}`}
              onClick={() => setDrawerOpen(false)}
            >
              <CalendarIcon /> {t("myCalendar")}
            </Link>
          )}
          <Link
            href="/"
            className={`header-drawer-item ${location === "/" ? "header-drawer-item-active" : ""}`}
            onClick={() => setDrawerOpen(false)}
          >
            <ListIcon /> {t("events")}
          </Link>
          <Link
            href="/discover"
            className={`header-drawer-item ${location.startsWith("/discover") ? "header-drawer-item-active" : ""}`}
            onClick={() => setDrawerOpen(false)}
          >
            <GlobeIcon /> {t("discover")}
          </Link>
          <Link
            href="/create"
            className="header-drawer-item"
            onClick={() => setDrawerOpen(false)}
          >
            <PlusIcon /> {t("createNewEvent")}
          </Link>
          {showAuthenticated && user && (
            <>
              <Link
                href={myProfilePath}
                className={`header-drawer-item ${location === myProfilePath ? "header-drawer-item-active" : ""}`}
                onClick={() => setDrawerOpen(false)}
              >
                <UserIcon /> {t("myProfile")}
              </Link>
              <Link
                href="/settings"
                className={`header-drawer-item ${location.startsWith("/settings") ? "header-drawer-item-active" : ""}`}
                onClick={() => setDrawerOpen(false)}
              >
                <SettingsIcon /> {t("settings")}
              </Link>
              <button
                type="button"
                className="header-drawer-item header-drawer-item-muted"
                onClick={() => {
                  setDrawerOpen(false);
                  logout();
                }}
              >
                <LogOutIcon /> {t("logOut")}
              </button>
            </>
          )}
          {showAnonymous && (
            <div className="header-drawer-auth" style={{ marginTop: "auto", padding: "1rem 1.25rem", borderTop: "1px solid var(--border)" }}>
              <Link href="/login" className="header-drawer-item" onClick={() => setDrawerOpen(false)} style={{ width: "100%", justifyContent: "center", marginBottom: "0.5rem" }}>
                <KeyIcon /> {t("logIn")}
              </Link>
              <Link href="/register" className="header-drawer-item" onClick={() => setDrawerOpen(false)} style={{ width: "100%", justifyContent: "center", background: "var(--accent)", color: "#000" }}>
                <UserIcon /> {t("signUp")}
              </Link>
            </div>
          )}
          {showAuthSkeleton && (
            <div className="header-drawer-auth" style={{ marginTop: "auto", padding: "1rem 1.25rem", borderTop: "1px solid var(--border)" }}>
              <div className="header-auth-skeleton" aria-hidden="true" style={{ width: "100%" }}>
                <span className="header-user-avatar header-auth-skeleton-avatar" />
                <span className="header-auth-skeleton-line" style={{ flex: 1 }} />
              </div>
              <button type="button" className="header-drawer-item" disabled style={{ width: "100%", justifyContent: "center", marginTop: "0.5rem" }}>
                <UserIcon /> {t("account")}
              </button>
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavLink({
  href,
  current,
  children,
}: {
  href: string;
  current: string;
  children: React.ReactNode;
}) {
  const active = href === "/" ? current === "/" : current.startsWith(href);
  return (
    <Link
      href={href}
      style={{
        fontSize: "0.9rem",
        color: active ? "var(--text)" : "var(--text-muted)",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </Link>
  );
}
