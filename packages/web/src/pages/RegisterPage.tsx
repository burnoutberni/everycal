import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";

export function RegisterPage() {
  const { user, register } = useAuth();
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (user) {
    navigate("/");
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(username, password, displayName || undefined);
      navigate("/");
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem", textAlign: "center" }}>
        Create Account
      </h1>
      <form onSubmit={handleSubmit} className="card">
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            pattern="[a-z0-9_-]{2,30}"
            title="2-30 characters, lowercase letters, numbers, underscores and hyphens"
          />
        </div>
        <div className="field">
          <label htmlFor="displayName">Display name (optional)</label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
          <p className="text-sm text-dim mt-1">At least 8 characters.</p>
        </div>
        {error && <p className="error-text mb-2">{error}</p>}
        <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={loading}>
          {loading ? "Creating…" : "Create Account"}
        </button>
        <p className="text-sm text-muted text-center mt-2">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
