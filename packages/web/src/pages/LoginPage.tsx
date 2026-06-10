import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";
import { PasswordInput } from "../components/PasswordInput";
import { auth as authApi, type AuthProviderInfo } from "../lib/api";

const OIDC_ERROR_MESSAGE_KEYS: Record<string, string> = {
  account_disabled: "oidcAccountDisabled",
  oidc_client_id_missing: "oidcUnavailable",
  oidc_client_secret_missing: "oidcUnavailable",
  oidc_disabled: "oidcUnavailable",
  oidc_email_conflict: "oidcEmailConflict",
  oidc_invalid_state: "oidcSessionExpired",
  oidc_issuer_url_missing: "oidcUnavailable",
  oidc_jit_provisioning_disabled: "oidcProvisioningDisabled",
  oidc_login_failed: "oidcLoginFailed",
  oidc_missing_identity_claims: "oidcLoginFailed",
  oidc_redirect_uri_missing: "oidcUnavailable",
  oidc_scope_openid_required: "oidcUnavailable",
  oidc_verified_email_required: "oidcVerifiedEmailRequired",
};

function sanitizeRedirectTarget(redirectTarget: string | null) {
  if (!redirectTarget) return "/";
  return redirectTarget.startsWith("/") && !redirectTarget.startsWith("//") ? redirectTarget : "/";
}

export function LoginPage() {
  const { t } = useTranslation("auth");
  const { user, login } = useAuth();
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [providers, setProviders] = useState<AuthProviderInfo | null>(null);

  const redirectTo = useMemo(() => {
    if (typeof window === "undefined") return "/";
    const params = new URLSearchParams(window.location.search);
    return sanitizeRedirectTarget(params.get("next") || params.get("redirectTo"));
  }, []);

  useEffect(() => {
    authApi.oidcProviders().then(setProviders).catch((error) => {
      console.error("Failed to fetch OIDC provider capabilities for login page", error);
      setProviders(null);
    });
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const oidcError = params.get("oidcError");
      if (oidcError) setError(t(OIDC_ERROR_MESSAGE_KEYS[oidcError] || "oidcLoginFailed"));
    }
  }, []);

  if (user) {
    navigate("/");
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const u = await login(username, password);
      if (u.notificationPrefs && !u.notificationPrefs.onboardingCompleted) {
        navigate("/onboarding");
      } else {
        navigate(redirectTo);
      }
    } catch (err: any) {
      setError(err.message || t("loginFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSso = async () => {
    setError("");
    setSsoLoading(true);
    try {
      const res = await authApi.startOidc(redirectTo);
      window.location.assign(res.authorizationUrl);
    } catch (err: any) {
      setError(err.message || t("ssoLoginFailed"));
      setSsoLoading(false);
    }
  };

  const showLocal = providers?.localPasswordAuthEnabled !== false;
  const showRegister = providers?.localRegistrationEnabled !== false;

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        {t("logIn")}
      </h1>
      <div className="card">
      {providers?.oidcEnabled && (
        <>
          <button type="button" className="btn-primary" style={{ width: "100%" }} disabled={ssoLoading} onClick={handleSso}>
            {ssoLoading
              ? t("ssoRedirecting")
              : (providers.providers[0]?.label
                ? t("signInWithProvider", { provider: providers.providers[0].label })
                : t("signInWithSso"))}
          </button>
          {showLocal && <div className="text-sm text-muted text-center mt-2 mb-2">{t("orSignInWithLocalAccount")}</div>}
        </>
      )}
      {error && <p className="error-text mb-2">{error}</p>}
      {showLocal ? (
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="username">{t("username")}</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t("password")}</label>
          <PasswordInput
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <p className="text-sm mt-1">
            <Link href="/forgot-password" className="text-dim">
              {t("forgotPassword")}
            </Link>
          </p>
        </div>
        <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={loading}>
          {loading ? t("loggingIn") : t("logIn")}
        </button>
        {showRegister && <p className="text-sm text-muted text-center mt-2">
          {t("dontHaveAccount")} <Link href="/register">{t("signUp", { ns: "common" })}</Link>
        </p>}
      </form>
      ) : (
        <p className="text-sm text-muted text-center mt-2">{t("localSignInDisabled")}</p>
      )}
      </div>
    </div>
  );
}
