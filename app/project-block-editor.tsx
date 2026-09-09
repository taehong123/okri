"use client";

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { ko } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { BasicTextStyleButton, BlockNoteContext, BlockNoteViewEditor, BlockTypeSelect, CreateLinkButton, FileCaptionButton, FileDeleteButton, FileReplaceButton, useCreateBlockNote } from "@blocknote/react";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { themeColorScheme } from "@/lib/themes";
import { t, useLanguage } from "@/lib/client-language";
import type { Language } from "@/lib/language";
import { DOCUMENT_IMAGE_ACCEPT, DOCUMENT_IMAGE_MAX_BYTES, type DocumentImageTarget } from "@/lib/document-images";

const editorDictionaries: Partial<Record<Language, typeof ko>> = { ko };
const editorRequests: Partial<Record<Language, Promise<typeof ko>>> = {};
const editorLoaders = {
  en: () => import("@/lib/locales/editor-en"),
  ja: () => import("@/lib/locales/editor-ja"),
  zh: () => import("@/lib/locales/editor-zh"),
  es: () => import("@/lib/locales/editor-es"),
};
function loadEditorDictionary(language: Language) {
  if (editorDictionaries[language]) return Promise.resolve(editorDictionaries[language]!);
  return editorRequests[language] ??= editorLoaders[language as Exclude<Language, "ko">]().then(({ default: dictionary }) => {
    editorDictionaries[language] = dictionary;
    return dictionary;
  }).finally(() => { delete editorRequests[language]; });
}

const projectDocumentSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    quote: defaultBlockSpecs.quote,
    codeBlock: defaultBlockSpecs.codeBlock,
    divider: defaultBlockSpecs.divider,
    table: defaultBlockSpecs.table,
    image: defaultBlockSpecs.image,
  },
});

export type ProjectBlockEditorChange = {
  content: string;
  plainText: string;
};

export type ProjectBlockEditorProps = {
  initialContent: string;
  editable?: boolean;
  onChange?: (change: ProjectBlockEditorChange) => void;
  imageTarget?: DocumentImageTarget;
  onUploadBusyChange?: (busy: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
};

export default function ProjectBlockEditor(props: ProjectBlockEditorProps) {
  const { language } = useLanguage();
  const [dictionary, setDictionary] = useState(() => editorDictionaries[language]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void loadEditorDictionary(language).then((value) => {
      if (active) { setDictionary(value); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [language, attempt]);
  return <>
    {failed && <p role="alert">{t("일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.")} <button className="secondary" onClick={() => setAttempt((value) => value + 1)}>{t("재시도")}</button></p>}
    {dictionary ? <ProjectBlockEditorBody {...props} dictionary={dictionary} /> : !failed && <p role="status">{t("불러오는 중")}</p>}
  </>;
}

function ProjectBlockEditorBody({ initialContent, editable = true, onChange, dictionary, imageTarget, onUploadBusyChange, onPendingChange }: ProjectBlockEditorProps & { dictionary: typeof ko }) {
  const initialBlocks = parseInitialContent(initialContent);
  const changeTimer = useRef<number | null>(null);
  const changeCallback = useRef(onChange);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadCount, setUploadCount] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [viewTheme, setViewTheme] = useState<"light" | "dark">(() => currentEditorTheme());
  const editor = useCreateBlockNote({
    schema: projectDocumentSchema,
    // Own dictionary, never mutate the library's shared locale object.
    dictionary: { ...dictionary },
    initialContent: initialBlocks as never,
    uploadFile: imageTarget ? uploadImage : undefined,
  });
  useLayoutEffect(() => { changeCallback.current = onChange; }, [onChange]);
  useEffect(() => { onUploadBusyChange?.(uploadCount > 0); }, [uploadCount, onUploadBusyChange]);
  const [appliedDictionary, setAppliedDictionary] = useState(dictionary);
  useLayoutEffect(() => {
    if (appliedDictionary === dictionary) return;
    Object.assign(editor.dictionary, dictionary);
    // Refresh menu context before paint, without replacing the editor, selection or undo history.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAppliedDictionary(dictionary);
  }, [editor, dictionary, appliedDictionary]);
  const context = useMemo(() => ({ colorSchemePreference: viewTheme, languageDictionary: appliedDictionary }), [viewTheme, appliedDictionary]);
  const placeholderStyle = Object.fromEntries(Object.entries(dictionary.placeholders).map(([key, value]) =>
    [`--editor-placeholder-${key}`, JSON.stringify(value)])) as CSSProperties;

  useEffect(() => () => {
    if (changeTimer.current !== null) {
      window.clearTimeout(changeTimer.current);
      changeCallback.current?.({ content: JSON.stringify(editor.document), plainText: blocksToPlainText(editor.document) });
    }
  }, [editor]);

  useEffect(() => {
    if (!editable && changeTimer.current !== null) {
      window.clearTimeout(changeTimer.current);
      changeTimer.current = null;
      changeCallback.current?.({ content: JSON.stringify(editor.document), plainText: blocksToPlainText(editor.document) });
      onPendingChange?.(false);
    }
  }, [editable, editor, onPendingChange]);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setViewTheme(currentEditorTheme());
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  function changed() {
    if (!onChange) return;
    onPendingChange?.(true);
    if (changeTimer.current !== null) window.clearTimeout(changeTimer.current);
    changeTimer.current = window.setTimeout(() => {
      changeTimer.current = null;
      onPendingChange?.(false);
      const document = editor.document;
      changeCallback.current?.({
        content: JSON.stringify(document),
        plainText: blocksToPlainText(document),
      });
    }, 450);
  }

  async function uploadImage(file: File) {
    if (!imageTarget || !editor.isEditable) throw new Error("Read-only document");
    if (!file.size || file.size > DOCUMENT_IMAGE_MAX_BYTES || !DOCUMENT_IMAGE_ACCEPT.split(",").includes(file.type)) {
      setUploadError(t("PNG·JPG·WebP·GIF 이미지를 5MB 이하로 첨부해 주세요."));
      throw new Error("Invalid image");
    }
    setUploadError("");
    setUploadCount(count => count + 1);
    try {
      const query = new URLSearchParams({ ...imageTarget, name: file.name });
      const response = await fetch(`/api/document-images?${query}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const result = await response.json() as { url?: string; code?: string };
      if (!response.ok || !result.url?.startsWith("/api/document-images?")) throw new Error("Upload failed");
      return result.url;
    } catch (error) {
      setUploadError(t("이미지를 저장하지 못했습니다."));
      throw error;
    } finally { setUploadCount(count => count - 1); }
  }

  async function attachImage(file: File) {
    const anchor = editor.getTextCursorPosition().block;
    try {
      const url = await uploadImage(file);
      const block = editor.getBlock(anchor.id) ?? editor.document[editor.document.length - 1];
      const [, paragraph] = editor.insertBlocks([{ type: "image", props: { url, name: file.name, previewWidth: 640 } }, { type: "paragraph" }], block, "after");
      editor.setTextCursorPosition(paragraph.id, "end");
      editor.focus();
    } catch { /* Keep the document and the inline upload error intact. */ }
  }

  return (
    <div className="project-block-editor" style={placeholderStyle}>
      <BlockNoteContext.Provider value={context}>
        <BlockNoteView editor={editor} editable={editable} onChange={changed} theme={viewTheme} renderEditor={false} formattingToolbar={false}>
          {editable && <div className="document-format-toolbar" role="group" aria-label={t("문서 서식")}>
            <BlockTypeSelect />
            <BasicTextStyleButton basicTextStyle="bold" />
            <BasicTextStyleButton basicTextStyle="italic" />
            <BasicTextStyleButton basicTextStyle="underline" />
            <CreateLinkButton />
            <FileCaptionButton />
            <FileDeleteButton />
            {imageTarget && <FileReplaceButton />}
            {imageTarget && <>
              <input ref={fileInput} type="file" accept={DOCUMENT_IMAGE_ACCEPT} hidden aria-label={t("이미지 첨부")} onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void attachImage(file);
              }} />
              <button type="button" className="document-image-button secondary" disabled={uploadCount > 0} aria-busy={uploadCount > 0} onClick={() => fileInput.current?.click()}>
                {uploadCount > 0 ? <LoaderCircle size={16} className="spinning" /> : <ImagePlus size={16} />}{t("이미지 첨부")}
              </button>
            </>}
          </div>}
          {editable && uploadError && <p className="document-upload-error" role="alert">{uploadError}</p>}
          <BlockNoteViewEditor />
        </BlockNoteView>
      </BlockNoteContext.Provider>
    </div>
  );
}

function currentEditorTheme(): "light" | "dark" {
  return themeColorScheme(typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined);
}

function parseInitialContent(value: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
      return parsed as Record<string, unknown>[];
    }
  } catch {
    // The API validates persisted content; this keeps a damaged local draft editable.
  }
  return [{ type: "paragraph", content: "" }];
}

function blocksToPlainText(blocks: readonly unknown[]): string {
  const lines: string[] = [];
  for (const block of blocks) collectBlockText(block, lines);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function collectBlockText(value: unknown, lines: string[]) {
  if (!value || typeof value !== "object") return;
  const block = value as Record<string, unknown>;
  const content = block.content;
  if (block.type === "image" && block.props && typeof block.props === "object") {
    const props = block.props as Record<string, unknown>;
    const label = typeof props.caption === "string" && props.caption.trim() ? props.caption : props.name;
    if (typeof label === "string" && label.trim()) lines.push(label.trim());
  }
  if (typeof content === "string") lines.push(content);
  else if (Array.isArray(content)) {
    const line = content.map((entry) => inlineText(entry)).join("");
    if (line || block.type !== "table") lines.push(line);
    for (const entry of content) if (entry && typeof entry === "object" && "content" in entry) collectBlockText(entry, lines);
  }
  if (Array.isArray(block.children)) for (const child of block.children) collectBlockText(child, lines);
}

function inlineText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const inline = value as Record<string, unknown>;
  if (typeof inline.text === "string") return inline.text;
  if (Array.isArray(inline.content)) return inline.content.map(inlineText).join("");
  return "";
}
