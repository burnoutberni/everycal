import { useState } from "react";
import { uploads, type EventInput } from "../lib/api";

interface Props {
  initial?: Partial<EventInput>;
  onSubmit: (data: EventInput) => Promise<void>;
  submitLabel: string;
}

export function EventForm({ initial, onSubmit, submitLabel }: Props) {
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [startDate, setStartDate] = useState(initial?.startDate?.slice(0, 16) || "");
  const [endDate, setEndDate] = useState(initial?.endDate?.slice(0, 16) || "");
  const [allDay, setAllDay] = useState(initial?.allDay || false);
  const [locationName, setLocationName] = useState(initial?.location?.name || "");
  const [locationAddress, setLocationAddress] = useState(initial?.location?.address || "");
  const [imageUrl, setImageUrl] = useState(initial?.image?.url || "");
  const [url, setUrl] = useState(initial?.url || "");
  const [tags, setTags] = useState(initial?.tags?.join(", ") || "");
  const [visibility, setVisibility] = useState(initial?.visibility || "public");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await uploads.upload(file);
      setImageUrl(result.url);
    } catch (err) {
      setError("Image upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const data: EventInput = {
        title,
        description: description || undefined,
        startDate: allDay ? startDate.slice(0, 10) : new Date(startDate).toISOString(),
        endDate: endDate ? (allDay ? endDate.slice(0, 10) : new Date(endDate).toISOString()) : undefined,
        allDay,
        visibility,
        url: url || undefined,
        tags: tags
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
      };
      if (locationName) {
        data.location = { name: locationName, address: locationAddress || undefined };
      }
      if (imageUrl) {
        data.image = { url: imageUrl };
      }
      await onSubmit(data);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="title">Title *</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>

      <div className="field">
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
        />
      </div>

      <div className="flex gap-2">
        <div className="field flex-1">
          <label htmlFor="startDate">Start {allDay ? "date" : "date & time"} *</label>
          <input
            id="startDate"
            type={allDay ? "date" : "datetime-local"}
            value={allDay ? startDate.slice(0, 10) : startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
        </div>
        <div className="field flex-1">
          <label htmlFor="endDate">End {allDay ? "date" : "date & time"}</label>
          <input
            id="endDate"
            type={allDay ? "date" : "datetime-local"}
            value={allDay ? endDate.slice(0, 10) : endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            style={{ width: "auto" }}
          />
          All-day event
        </label>
      </div>

      <div className="flex gap-2">
        <div className="field flex-1">
          <label htmlFor="locationName">Location name</label>
          <input
            id="locationName"
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            placeholder="e.g. Flex Vienna"
          />
        </div>
        <div className="field flex-1">
          <label htmlFor="locationAddress">Address</label>
          <input
            id="locationAddress"
            value={locationAddress}
            onChange={(e) => setLocationAddress(e.target.value)}
            placeholder="e.g. Donaukanal 1, 1010 Wien"
          />
        </div>
      </div>

      <div className="field">
        <label>Header image</label>
        {imageUrl && (
          <div style={{ marginBottom: "0.5rem" }}>
            <img
              src={imageUrl}
              alt="Preview"
              style={{
                maxWidth: "100%",
                maxHeight: "200px",
                objectFit: "cover",
                borderRadius: "var(--radius-sm)",
              }}
            />
            <button
              type="button"
              className="btn-ghost btn-sm mt-1"
              onClick={() => setImageUrl("")}
            >
              Remove
            </button>
          </div>
        )}
        <input type="file" accept="image/*" onChange={handleImageUpload} disabled={uploading} />
        {uploading && <p className="text-sm text-muted">Uploading…</p>}
        <div style={{ marginTop: "0.3rem" }}>
          <label htmlFor="imageUrlDirect" className="text-sm text-dim">
            Or paste image URL directly:
          </label>
          <input
            id="imageUrlDirect"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="url">Event URL</label>
        <input
          id="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />
      </div>

      <div className="field">
        <label htmlFor="tags">Tags (comma-separated)</label>
        <input
          id="tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="music, vienna, concert"
        />
      </div>

      <div className="field">
        <label htmlFor="visibility">Visibility</label>
        <select id="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          <option value="public">Public — visible to everyone</option>
          <option value="unlisted">Unlisted — not in public feeds, but accessible via link</option>
          <option value="followers_only">Followers only</option>
          <option value="private">Private — only you</option>
        </select>
      </div>

      {error && <p className="error-text mb-2">{error}</p>}

      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
