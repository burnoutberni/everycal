import { useState } from "react";
import { Link, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { auth as authApi } from "../lib/api";

export function ResetPasswordPage() {
  const { t } = useTranslation("auth");
  const search = useSearch();
  const params = new URLSearchParams(search);
  const token = params.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError(t("passwordsDoNotMatch"));
      return;
    }
    if (password.length < 8) {
      setError(t("passwordMinLength"));
      return;
    }
    if (!token) {
      setError(t("invalidResetLink"));
      return;
    }
    setLoading(true);
    try {
      await authApi.resetPassword(token, password);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || t("resetFailed"));
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
          {t("invalidLink")}
        </h1>
        <div className="card">
          <p className="error-text">{t("invalidResetLink")}</p>
          <p className="text-sm text-center mt-2">
            <Link href="/forgot-password">{t("requestNewLink")}</Link>
          </p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div style={{ maxWidth: 400, margin: "3rem auto" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
          {t("passwordReset")}
        </h1>
        <div className="card">
          <p>{t("passwordResetSuccess")}</p>
          <p className="text-sm text-center mt-2">
            <Link href="/login">{t("logIn")}</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        {t("setNewPassword")}
      </h1>
      <form onSubmit={handleSubmit} className="card">
        <div className="field">
          <label htmlFor="password">{t("newPassword")}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
            autoFocus
          />
          <p className="text-sm text-dim mt-1">{t("atLeast8Chars")}</p>
        </div>
        <div className="field">
          <label htmlFor="confirmPassword">{t("confirmPassword")}</label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </div>
        {error && <p className="error-text mb-2">{error}</p>}
        <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={loading}>
          {loading ? t("resetting") : t("resetPasswordBtn")}
        </button>
      </form>
    </div>
  );
}
