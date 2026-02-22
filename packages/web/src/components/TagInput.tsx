import { useRef, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toSingleWordTag } from "../lib/inferImageSearchTerm";

interface TagInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((t) => toSingleWordTag(t))
    .filter(Boolean);
}

function tagsToString(tags: string[]): string {
  return [...new Set(tags)].join(", ");
}

export function TagInput({ value, onChange, placeholder, id }: TagInputProps) {
  const { t } = useTranslation("common");
  const resolvedPlaceholder = placeholder ?? t("addTags");
  const inputRef = useRef<HTMLInputElement>(null);
  const tags = parseTags(value);

  const addTag = (tag: string) => {
    const normalized = toSingleWordTag(tag);
    if (!normalized) return;
    const next = [...tags.filter((t) => t !== normalized), normalized];
    onChange(tagsToString(next));
  };

  const removeTag = (tag: string) => {
    const next = tags.filter((t) => t !== tag);
    onChange(tagsToString(next));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = inputRef.current;
    if (!input) return;
    const v = input.value.trim();

    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (v) {
        addTag(v);
        input.value = "";
      }
      return;
    }

    if (e.key === "Backspace" && !v && tags.length > 0) {
      e.preventDefault();
      removeTag(tags[tags.length - 1]);
    }
  };

  const handleBlur = () => {
    const input = inputRef.current;
    if (input?.value.trim()) {
      addTag(input.value);
      input.value = "";
    }
  };

  return (
    <div
      className="tag-input"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span key={tag} className="tag-input-tag">
          {tag}
          <button
            type="button"
            className="tag-input-remove"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(tag);
            }}
            aria-label={t("removeTag", { tag })}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        type="text"
        className="tag-input-field"
        placeholder={tags.length === 0 ? resolvedPlaceholder : ""}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        autoComplete="off"
      />
    </div>
  );
}
