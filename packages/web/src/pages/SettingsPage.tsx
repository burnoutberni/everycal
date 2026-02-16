import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { auth as authApi } from "../lib/api";
import { Link, useLocation } from "wouter";

export function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [, navigate] = useLocation();

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [website, setWebsite] = useState("");
  const [discoverable, setDiscoverable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // API keys
  const [keys, setKeys] = useState<{ id: string; label: string; lastUsedAt: string | null; createdAt: string }[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");

  useEffect(() => {
    if (!user) return;
    authApi.me().then((u) => {
      setDisplayName(u.displayName || "");
      setBio(u.bio || "");
      setWebsite(u.website || "");
      setDiscoverable(!!u.discoverable);
    });
    authApi.listApiKeys().then((r) => setKeys(r.keys));
  }, [user]);

  if (!user) {
    return (
      <div className="empty-state mt-3">
        <p>
          <Link href="/login">Log in</Link> to access settings.
        </p>
      </div>
    );
  }

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await authApi.updateProfile({ displayName, bio, website, discoverable });
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyLabel) return;
    const result = await authApi.createApiKey(newKeyLabel);
    setNewKeyValue(result.key);
    setNewKeyLabel("");
    authApi.listApiKeys().then((r) => setKeys(r.keys));
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm("Delete this API key?")) return;
    await authApi.deleteApiKey(id);
    setKeys(keys.filter((k) => k.id !== id));
  };

  const handleDeleteAccount = async () => {
    if (
      !confirm(
        "Are you sure you want to delete your account? This action cannot be undone and will delete all your events and data."
      )
    ) {
      return;
    }

    // Double confirmation
    const username = prompt(`Please type your username (${user.username}) to confirm:`);
    if (username !== user.username) {
      alert("Username does not match.");
      return;
    }

    try {
      await authApi.deleteAccount();
      // Force logout and redirect
      window.location.href = "/";
    } catch (err) {
      alert("Failed to delete account");
    }
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem" }}>Settings</h1>

      <section className="card mb-2">
        <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem" }}>Profile</h2>
        <form onSubmit={handleSaveProfile}>
          <div className="field">
            <label htmlFor="displayName">Display name</label>
            <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bio">Bio</label>
            <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} />
          </div>
          <div className="field">
            <label htmlFor="website">Website</label>
            <input id="website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://example.com" />
          </div>
          <div className="field">
            <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={discoverable}
                onChange={(e) => setDiscoverable(e.target.checked)}
                style={{ width: "auto" }}
              />
              Public account
            </label>
            <p className="text-sm text-dim" style={{ marginTop: "0.25rem" }}>
              {discoverable
                ? "Your profile is visible on the Explore page. New events default to public."
                : "Your profile is hidden from Explore. New events default to private."}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button type="submit" className="btn-primary btn-sm" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            {saved && <span className="text-sm" style={{ color: "var(--success)" }}>Saved!</span>}
          </div>
        </form>
      </section>

      <section className="card">
        <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem" }}>API Keys</h2>
        <p className="text-sm text-muted mb-2">
          Use API keys to authenticate with the EveryCal API from scripts and scrapers.
          Send as <code style={{ fontFamily: "var(--font-mono)", background: "var(--bg-hover)", padding: "0.1rem 0.3rem", borderRadius: 3 }}>Authorization: ApiKey your-key-here</code>
        </p>

        {newKeyValue && (
          <div
            className="mb-2"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--success)",
              borderRadius: "var(--radius-sm)",
              padding: "0.75rem",
            }}
          >
            <p className="text-sm" style={{ color: "var(--success)", fontWeight: 600 }}>
              New API key created — copy it now, you won't see it again:
            </p>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.85rem",
                display: "block",
                marginTop: "0.5rem",
                wordBreak: "break-all",
              }}
            >
              {newKeyValue}
            </code>
            <button className="btn-ghost btn-sm mt-1" onClick={() => {
              navigator.clipboard.writeText(newKeyValue);
            }}>
              Copy
            </button>
            <button className="btn-ghost btn-sm mt-1" onClick={() => setNewKeyValue("")}>
              Dismiss
            </button>
          </div>
        )}

        {keys.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center justify-between" style={{ padding: "0.4rem 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <span style={{ fontWeight: 500 }}>{k.label}</span>
                  <span className="text-sm text-dim" style={{ marginLeft: "0.5rem" }}>
                    created {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt && ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`}
                  </span>
                </div>
                <button className="btn-danger btn-sm" onClick={() => handleDeleteKey(k.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-1 items-center">
          <input
            value={newKeyLabel}
            onChange={(e) => setNewKeyLabel(e.target.value)}
            placeholder="Key label, e.g. 'Scraper bot'"
            style={{ flex: 1 }}
          />
          <button className="btn-ghost btn-sm" onClick={handleCreateKey} disabled={!newKeyLabel}>
            Create Key
          </button>
        </div>
      </section>

      <section className="card mt-2" style={{ borderColor: "var(--danger)" }}>
        <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem", color: "var(--danger)" }}>
          Danger Zone
        </h2>
        <p className="text-sm text-muted mb-2">
          Deleting your account is permanent. All your events, follows, and data will be erased.
        </p>
        <button className="btn-danger" onClick={handleDeleteAccount}>
          Delete Account
        </button>
      </section>
    </div>
  );
}
