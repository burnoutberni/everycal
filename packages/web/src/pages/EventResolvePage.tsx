import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { events as eventsApi } from "../lib/api";

export function EventResolvePage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [error, setError] = useState<string | null>(null);

  const params = new URLSearchParams(search);
  const uri = params.get("uri")?.trim();

  useEffect(() => {
    if (!uri) {
      setError("Missing event URI.");
      return;
    }

    setError(null);

    let cancelled = false;
    eventsApi.resolve(uri)
      .then((res) => {
        if (cancelled) return;
        navigate(res.path, { replace: true });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Unable to resolve this event.";
        setError(message || "Unable to resolve this event.");
      });

    return () => {
      cancelled = true;
    };
  }, [navigate, uri]);

  if (!uri || error) {
    return (
      <div className="empty-state mt-3">
        <h2>Could not open event</h2>
        <p className="text-muted">{error || "Missing event URI."}</p>
        <p className="mt-2"><Link href="/">Back to home</Link></p>
      </div>
    );
  }

  return (
    <div className="empty-state mt-3">
      <h2>Opening event…</h2>
      <p className="text-muted">Resolving the latest canonical event link.</p>
    </div>
  );
}
