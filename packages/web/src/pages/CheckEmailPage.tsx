import { useSearch } from "wouter";
import { useTranslation } from "react-i18next";

export function CheckEmailPage() {
  const { t } = useTranslation("auth");
  const search = useSearch();
  const params = new URLSearchParams(search);
  const email = params.get("email") || "your email";

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        {t("checkEmailTitle")}
      </h1>
      <div className="card">
        <p>{t("verificationSent", { email })}</p>
        <p className="text-sm text-dim mt-2">{t("verificationSentDetails")}</p>
      </div>
    </div>
  );
}
