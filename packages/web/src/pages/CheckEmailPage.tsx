import { useSearch } from "wouter";

export function CheckEmailPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const email = params.get("email") || "your email";

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        Check your email
      </h1>
      <div className="card">
        <p>
          We sent a verification link to <strong>{email}</strong>. Click it to activate your account.
        </p>
        <p className="text-sm text-dim mt-2">
          The link expires in 24 hours. If you don't see the email, check your spam folder.
        </p>
      </div>
    </div>
  );
}
