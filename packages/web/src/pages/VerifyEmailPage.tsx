import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { auth as authApi } from "../lib/api";

export function VerifyEmailPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { refreshUser } = useAuth();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState("");
  const [emailChanged, setEmailChanged] = useState(false);

  const params = new URLSearchParams(search);
  const token = params.get("token");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Missing verification token");
      return;
    }

    let cancelled = false;
    authApi
      .verifyEmail(token)
      .then(async (res) => {
        if (cancelled) return;
        const wasEmailChange = !!(res && "emailChanged" in res && res.emailChanged);
        setEmailChanged(wasEmailChange);
        setStatus("success");
        await refreshUser();
        if (cancelled) return;
        const redirectTo = wasEmailChange ? "/settings" : "/onboarding";
        setTimeout(() => navigate(redirectTo), 2500);
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus("error");
          setError(err.message || "Verification failed");
        }
      });
    return () => { cancelled = true; };
  }, [token, navigate, refreshUser]);

  if (status === "loading") {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto", textAlign: "center" }}>
        <p className="text-muted">Verifying your email…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
          Verification failed
        </h1>
        <div className="card">
          <p className="error-text">{error}</p>
          <p className="text-sm text-dim mt-2">
            The link may have expired. Try registering again or request a new verification email.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto", textAlign: "center" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1rem", color: "var(--success)" }}>
        {emailChanged ? "Email updated successfully!" : "Email verified!"}
      </h1>
      <p className="text-muted">
        {emailChanged
          ? "Your new email address is now active. Redirecting to settings…"
          : "Redirecting to complete setup…"}
      </p>
    </div>
  );
}
