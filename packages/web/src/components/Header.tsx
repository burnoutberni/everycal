import { Link, useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { profilePath } from "../lib/urls";

export function Header() {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  const myProfilePath = user ? profilePath(user.username) : "";

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
              <Link href="/events/new">
                <button className="btn-primary btn-sm">+ New Event</button>
              </Link>
              <Link
                href={myProfilePath}
                style={{
                  color: location === myProfilePath ? "var(--text)" : "var(--text-muted)",
                  fontSize: "0.9rem",
                }}
              >
                {user.displayName || user.username}
              </Link>
              <Link href="/settings">
                <button className="btn-ghost btn-sm">⚙</button>
              </Link>
              <button className="btn-ghost btn-sm" onClick={logout}>
                Log out
              </button>
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
