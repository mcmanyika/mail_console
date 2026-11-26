"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

/** Turn plain text (drafts / AI / templates) into TipTap-friendly HTML. */
export function plainTextToEditorHtml(text: string): string {
  const raw = text.replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return raw
    .split(/\n{2,}/)
    .map((block) => {
      const escaped = block
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/\n/g, "<br>");
      return `<p>${escaped || "<br>"}</p>`;
    })
    .join("");
}

type Props = {
  id?: string;
  name?: string;
  htmlName?: string;
  /** HTML body — used for initial content and external replaces (templates / AI). */
  value: string;
  onChange: (plain: string, html: string) => void;
  placeholder?: string;
  className?: string;
  minHeightClassName?: string;
};

function normalizeEditorHtml(html: string): string {
  const t = html.trim();
  return !t || t === "<p></p>" ? "" : t;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-ink-2 transition-colors",
        "hover:bg-canvas-deep hover:text-ink disabled:pointer-events-none disabled:opacity-40",
        active && "bg-accent-soft text-accent-ink",
      )}
    >
      {children}
    </button>
  );
}

export function RichTextEditor({
  id = "body",
  name = "body",
  htmlName = "bodyHtml",
  value,
  onChange,
  placeholder = "Write your message…",
  className,
  minHeightClassName = "min-h-64",
}: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        // Link + Underline ship inside StarterKit (TipTap 3); configure here — don't add again.
        underline: {},
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: normalizeEditorHtml(value) || plainTextToEditorHtml(value) || undefined,
    editorProps: {
      attributes: {
        id,
        class: cn(
          "prose-compose max-w-none px-3 py-2.5 text-[14px] leading-relaxed text-ink outline-none",
          minHeightClassName,
        ),
      },
    },
    onUpdate: ({ editor: ed }) => {
      const raw = ed.getHTML();
      const html = normalizeEditorHtml(raw);
      const plain = ed.getText({ blockSeparator: "\n" });
      onChange(plain, html);
    },
  });

  // Sync when parent replaces content (templates / AI), not on every keystroke.
  useEffect(() => {
    if (!editor) return;
    const next = normalizeEditorHtml(value) || plainTextToEditorHtml(value);
    const current = normalizeEditorHtml(editor.getHTML());
    if (next === current) return;
    editor.commands.setContent(next || "", { emitUpdate: false });
  }, [editor, value]);

  const html = editor ? normalizeEditorHtml(editor.getHTML()) : normalizeEditorHtml(value);
  const plain = editor ? editor.getText({ blockSeparator: "\n" }) : "";

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const next = window.prompt("Link URL", prev ?? "https://");
    if (next === null) return;
    const url = next.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className={cn("overflow-hidden rounded-md border border-line-strong bg-surface shadow-sm", className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-muted/60 px-1.5 py-1">
        <ToolbarButton label="Bold" active={editor?.isActive("bold")} disabled={!editor} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <Bold className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Italic" active={editor?.isActive("italic")} disabled={!editor} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <Italic className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Underline" active={editor?.isActive("underline")} disabled={!editor} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Strikethrough" active={editor?.isActive("strike")} disabled={!editor} onClick={() => editor?.chain().focus().toggleStrike().run()}>
          <Strikethrough className="size-4" />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <ToolbarButton label="Bullet list" active={editor?.isActive("bulletList")} disabled={!editor} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          <List className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Numbered list" active={editor?.isActive("orderedList")} disabled={!editor} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          <ListOrdered className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Quote" active={editor?.isActive("blockquote")} disabled={!editor} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
          <Quote className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Link" active={editor?.isActive("link")} disabled={!editor} onClick={setLink}>
          <Link2 className="size-4" />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <ToolbarButton label="Undo" disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}>
          <Undo2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Redo" disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}>
          <Redo2 className="size-4" />
        </ToolbarButton>
      </div>
      <EditorContent editor={editor} />
      <input type="hidden" name={name} value={plain} />
      <input type="hidden" name={htmlName} value={html} />
    </div>
  );
}
