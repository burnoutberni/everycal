import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { auth as authApi } from "../lib/api";

export function ForgotPasswordPage() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
      setSent(true);
    } catch (err: any) {
      setError(err.message || t("resetFailed"));
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
          {t("checkEmailTitle")}
        </h1>
        <div className="card">
          <p>{t("ifAccountExists", { email })}</p>
          <p className="text-sm text-dim mt-2">{t("ifAccountExistsDetails")}</p>
          <p className="text-sm text-center mt-2">
            <Link href="/login">{t("backToLogIn")}</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        {t("resetPassword")}
      </h1>
      <form onSubmit={handleSubmit} className="card">
        <div className="field">
          <label htmlFor="email">{t("email")}</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
          />
        </div>
        {error && <p className="error-text mb-2">{error}</p>}
        <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={loading}>
          {loading ? t("sending") : t("sendResetLink")}
        </button>
        <p className="text-sm text-muted text-center mt-2">
          <Link href="/login">{t("backToLogIn")}</Link>
        </p>
      </form>
    </div>
  );
}
