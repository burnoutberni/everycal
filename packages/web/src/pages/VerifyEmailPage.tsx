import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { auth as authApi } from "../lib/api";

export function VerifyEmailPage() {
  const { t } = useTranslation("auth");
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
      setError(t("missingToken"));
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
          setError(err.message || t("verificationFailed"));
        }
      });
    return () => { cancelled = true; };
  }, [token, navigate, refreshUser, t]);

  if (status === "loading") {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto", textAlign: "center" }}>
        <p className="text-muted">{t("verifying")}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
          {t("verificationFailed")}
        </h1>
        <div className="card">
          <p className="error-text">{error}</p>
          <p className="text-sm text-dim mt-2">{t("verificationExpiredHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto", textAlign: "center" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1rem", color: "var(--success)" }}>
        {emailChanged ? t("emailUpdated") : t("emailVerified")}
      </h1>
      <p className="text-muted">
        {emailChanged ? t("emailUpdatedRedirect") : t("emailVerifiedRedirect")}
      </p>
    </div>
  );
}
