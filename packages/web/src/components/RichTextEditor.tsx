import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useState, useRef } from "react";
import { sanitizeHtml } from "../lib/sanitize";

const icons = {
  bold: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
      <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
    </svg>
  ),
  italic: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="4" x2="10" y2="4" />
      <line x1="14" y1="20" x2="5" y2="20" />
      <line x1="15" y1="4" x2="9" y2="20" />
    </svg>
  ),
  underline: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4v6a6 6 0 0 0 12 0V4" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </svg>
  ),
  heading: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h8" />
      <path d="M4 18V6" />
      <path d="M12 18V6" />
      <path d="M17 12l3-2v8" />
    </svg>
  ),
  bulletList: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  orderedList: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="10" y1="6" x2="20" y2="6" />
      <line x1="10" y1="12" x2="20" y2="12" />
      <line x1="10" y1="18" x2="20" y2="18" />
      <text x="2" y="8" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif" fontWeight="600">1</text>
      <text x="2" y="14.5" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif" fontWeight="600">2</text>
      <text x="2" y="21" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif" fontWeight="600">3</text>
    </svg>
  ),
  blockquote: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M10 8c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h.5l-.5 2h-1.5l1-4H8c-1.1 0-2-.9-2-2v-2c0-2.2 1.8-4 4-4h1v2h-1zm8 0c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h.5l-.5 2h-1.5l1-4H16c-1.1 0-2-.9-2-2v-2c0-2.2 1.8-4 4-4h1v2h-1z" />
    </svg>
  ),
  code: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  codeBlock: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <line x1="12" y1="2" x2="12" y2="22" strokeDasharray="2 3" />
    </svg>
  ),
  link: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  horizontalRule: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  ),
};

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rte-btn${active ? " rte-btn-active" : ""}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function BlockDropdown({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const items: { label: string; icon: React.ReactNode; active: boolean; action: () => void }[] = [
    { label: "Heading 2", icon: <span style={{ fontWeight: 700, fontSize: "0.8rem" }}>H2</span>, active: editor.isActive("heading", { level: 2 }), action: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Heading 3", icon: <span style={{ fontWeight: 700, fontSize: "0.7rem" }}>H3</span>, active: editor.isActive("heading", { level: 3 }), action: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "Bullet list", icon: icons.bulletList, active: editor.isActive("bulletList"), action: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: icons.orderedList, active: editor.isActive("orderedList"), action: () => editor.chain().focus().toggleOrderedList().run() },
    { label: "Quote", icon: icons.blockquote, active: editor.isActive("blockquote"), action: () => editor.chain().focus().toggleBlockquote().run() },
    { label: "Inline code", icon: icons.code, active: editor.isActive("code"), action: () => editor.chain().focus().toggleCode().run() },
    { label: "Code block", icon: icons.codeBlock, active: editor.isActive("codeBlock"), action: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: "Divider", icon: icons.horizontalRule, active: false, action: () => editor.chain().focus().setHorizontalRule().run() },
  ];

  const hasActive = items.some((i) => i.active);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className={`rte-btn rte-dropdown-trigger${hasActive ? " rte-btn-active" : ""}`}
        onClick={() => setOpen(!open)}
        title="More formatting"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && (
        <div className="rte-dropdown-menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`rte-dropdown-item${item.active ? " rte-dropdown-item-active" : ""}`}
              onClick={() => { item.action(); setOpen(false); }}
            >
              <span className="rte-dropdown-item-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="rte-toolbar">
      <ToolbarButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
      >
        {icons.bold}
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
      >
        {icons.italic}
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (Ctrl+U)"
      >
        {icons.underline}
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("link")}
        onClick={() => {
          if (editor.isActive("link")) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const url = window.prompt("URL or email:");
          if (url) {
            let href = url;
            if (url.includes("@") && !url.includes("://")) {
              href = `mailto:${url}`;
            } else if (!/^(https?:\/\/|mailto:)/i.test(url)) {
              href = `https://${url}`;
            }
            editor.chain().focus().setLink({ href }).run();
          }
        }}
        title="Link"
      >
        {icons.link}
      </ToolbarButton>
      <span className="rte-sep" />
      <BlockDropdown editor={editor} />
    </div>
  );
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Describe your event…",
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const clean = sanitizeHtml(html);
      const isEmpty = editor.isEmpty;
      onChange(isEmpty ? "" : clean);
    },
  });

  useEffect(() => {
    if (editor && value && editor.isEmpty && value !== editor.getHTML()) {
      editor.commands.setContent(value);
    }
  }, [editor, value]);

  if (!editor) return null;

  return (
    <div className="rte-wrapper">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="rte-content" />
    </div>
  );
}
