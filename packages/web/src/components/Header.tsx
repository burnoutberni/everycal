import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { profilePath } from "../lib/urls";
import { CalendarIcon, LogOutIcon, PlusIcon, SettingsIcon, UserIcon } from "./icons";
import { Logo } from "./Logo";

export function Header() {
  const { t } = useTranslation("common");
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const myProfilePath = user ? profilePath(user.username) : "";
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

  useEffect(() => setMenuOpen(false), [location]);

  return (
    <header
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <nav className="container flex items-center justify-between" style={{ height: "3.5rem" }}>
        <div className="flex items-center gap-2">
          <Link href="/" style={{ display: "flex", alignItems: "center", marginRight: "1rem" }}>
            <Logo />
          </Link>
          <NavLink href="/" current={location}>
            {t("events")}
          </NavLink>
          <NavLink href="/discover" current={location}>
            {t("discover")}
          </NavLink>
        </div>

        <div className="flex items-center gap-1">
          {user ? (
            <>
              <div className="flex items-center gap-1">
                <Link
                  href="/calendar"
                  className={`header-icon-btn header-icon-btn-calendar ${onCalendar ? "header-icon-btn-active" : ""}`}
                  title={t("myCalendar")}
                >
                  <CalendarIcon />
                </Link>
                <span className="header-icon-sep" aria-hidden="true" />
                <Link
                  href="/events/new"
                  className="header-icon-btn"
                  title={t("createNewEvent")}
                >
                  <PlusIcon />
                </Link>
              </div>
              <div ref={menuRef} style={{ position: "relative" }}>
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
            </>
          ) : (
            <>
              <Link href="/login">
                <button className="btn-ghost btn-sm">{t("logIn")}</button>
              </Link>
              <Link href="/register">
                <button className="btn-primary btn-sm">{t("signUp")}</button>
              </Link>
            </>
          )}
        </div>
      </nav>
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
