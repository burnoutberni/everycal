import { useRef, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { profilePath } from "../lib/urls";
import { CalendarIcon, LogOutIcon, PlusIcon, SettingsIcon, UserIcon } from "./icons";

export function Header() {
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
          <Link href="/" style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text)" }}>
            🗓️ EveryCal
          </Link>
          <NavLink href="/" current={location}>
            Events
          </NavLink>
          <NavLink href="/explore" current={location}>
            Explore
          </NavLink>
          <NavLink href="/federation" current={location}>
            Federation
          </NavLink>
        </div>

        <div className="flex items-center gap-1">
          {user ? (
            <>
              <div className="flex items-center gap-1">
                <Link
                  href="/calendar"
                  className={`header-icon-btn header-icon-btn-calendar ${onCalendar ? "header-icon-btn-active" : ""}`}
                  title="My Calendar"
                >
                  <CalendarIcon />
                </Link>
                <span className="header-icon-sep" aria-hidden="true" />
                <Link
                  href="/events/new"
                  className="header-icon-btn"
                  title="Create new event"
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
                      <UserIcon /> My profile
                    </Link>
                    <Link
                      href="/calendar"
                      className="header-dropdown-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      <CalendarIcon /> My Calendar
                    </Link>
                    <Link
                      href="/settings"
                      className="header-dropdown-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      <SettingsIcon /> Settings
                    </Link>
                    <button
                      type="button"
                      className="header-dropdown-item header-dropdown-item-muted"
                      onClick={() => {
                        setMenuOpen(false);
                        logout();
                      }}
                    >
                      <LogOutIcon /> Log out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link href="/login">
                <button className="btn-ghost btn-sm">Log in</button>
              </Link>
              <Link href="/register">
                <button className="btn-primary btn-sm">Sign up</button>
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
