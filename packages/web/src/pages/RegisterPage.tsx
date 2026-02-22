import { useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";
import { CitySearch, type CitySelection } from "../components/CitySearch";

export function RegisterPage() {
  const { t } = useTranslation("auth");
  const { user, register } = useAuth();
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [city, setCity] = useState<CitySelection | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (user) {
    navigate("/");
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!city) {
      setError(t("pleaseSelectCity"));
      return;
    }
    setLoading(true);
    try {
      const result = await register(
        username,
        password,
        displayName || undefined,
        city.city,
        city.lat,
        city.lng,
        email || undefined
      );
      if (result?.requiresVerification && result.email) {
        navigate(`/check-email?email=${encodeURIComponent(result.email)}`);
      } else {
        navigate("/");
      }
    } catch (err: any) {
      setError(err.message || t("registrationFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        {t("createAccount")}
      </h1>
      <form onSubmit={handleSubmit} className="card">
        <div className="field">
          <label htmlFor="username">{t("username")}</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            pattern="[a-z0-9_-]{2,30}"
            title={t("usernamePattern")}
          />
        </div>
        <div className="field">
          <label htmlFor="displayName">{t("displayNameOptional")}</label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="email">{t("email")}</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t("password")}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
          <p className="text-sm text-dim mt-1">{t("atLeast8Chars")}</p>
        </div>
        <div className="field">
          <label htmlFor="city">{t("cityRequired")}</label>
          <CitySearch
            id="city"
            value={city}
            onChange={setCity}
            placeholder={t("whereBased")}
            required
          />
        </div>
        {error && <p className="error-text mb-2">{error}</p>}
        <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={loading}>
          {loading ? t("creating") : t("createAccount")}
        </button>
        <p className="text-sm text-muted text-center mt-2">
          {t("alreadyHaveAccountText")} <Link href="/login">{t("logIn")}</Link>
        </p>
      </form>
    </div>
  );
}
