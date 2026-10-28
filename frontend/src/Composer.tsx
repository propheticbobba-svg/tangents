import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorContent, Extension, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { docToDraft, draftToDoc, isDraftEmpty, textNodes, type Draft } from "./draft";
import { FormulaContext, type FormulaEnv } from "./formulaContext";
import { FormulaNode } from "./formulaNode";
import type { DictationPhase } from "./MicButton";

/**
 * The message box. Plain text plus formula boxes; Enter sends, Shift+Enter is a
 * new line. Paste is plain text, except formula boxes copied from this composer.
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  prefillKey,
  controls,
  mic,
  dictationPhase = "idle",
  formulaMic = null,
  onFormulaMic = () => {},
  onError = () => {},
}: {
  value: Draft;
  onChange: (value: Draft) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  prefillKey: number;
  controls?: ReactNode;
  mic?: ReactNode;
  dictationPhase?: DictationPhase;
  formulaMic?: string | null;
  onFormulaMic?: (update: (current: string | null) => string | null) => void;
  onError?: (message: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const empty = isDraftEmpty(value);
  // The draft the editor is showing right now, so a value change from outside
  // (clear, restore, prefill, dictation) is applied once and an edit is not echoed back.
  const appliedRef = useRef<Draft>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const submitRef = useRef(() => {});
  submitRef.current = () => {
    if (!disabled && !empty) onSend();
  };
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  const keys = useMemo(
    () =>
      Extension.create({
        name: "composerKeys",
        // Above the built-in keymap, whose Enter would split the paragraph.
        priority: 1000,
        addKeyboardShortcuts() {
          return {
            Enter: ({ editor }) => {
              if (editor.view.composing) return false;
              submitRef.current();
              return true;
            },
          };
        },
      }),
    [],
  );

  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      // Shown while disabled too, like the old textarea placeholder.
      Placeholder.configure({ placeholder: () => placeholderRef.current, showOnlyWhenEditable: false }),
      FormulaNode,
      keys,
    ],
    content: draftToDoc(value),
    editable: !disabled,
    editorProps: {
      attributes: {
        id: "composer",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        class:
          "composer-editor min-h-[4.25rem] max-h-48 w-full overflow-y-auto border-0 bg-transparent px-2 py-1 text-sm outline-none",
      },
      handlePaste(view, event) {
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (html.includes("data-formula")) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text) return false;
        event.preventDefault();
        const { schema } = view.state;
        const nodes = textNodes(text.replace(/\r\n?/g, "\n")).map((node) =>
          node.type === "hardBreak" ? schema.nodes.hardBreak!.create() : schema.text(node.text ?? ""),
        );
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView());
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const next = docToDraft(current.getJSON());
      appliedRef.current = next;
      onChangeRef.current(next);
    },
  });

  useEffect(() => {
    if (value === appliedRef.current || editor.isDestroyed) return;
    appliedRef.current = value;
    editor.commands.setContent(draftToDoc(value), { emitUpdate: false });
    editor.commands.setTextSelection(editor.state.doc.content.size);
  }, [value, editor]);

  useEffect(() => {
    if (editor.isEditable !== !disabled) editor.setEditable(!disabled, false);
  }, [disabled, editor]);

  useEffect(() => {
    if (prefillKey > 0) editor.commands.focus("end");
  }, [prefillKey, editor]);

  useEffect(() => {
    // Placeholder text is read through a ref; an empty transaction repaints it.
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [placeholder, editor]);

  const env = useMemo<FormulaEnv>(
    () => ({
      disabled,
      mainMicBusy: dictationPhase !== "idle",
      micOwner: formulaMic,
      setMicOwner: onFormulaMic,
      onError,
    }),
    [disabled, dictationPhase, formulaMic, onFormulaMic, onError],
  );

  return (
    <form
      className="px-4 pb-4 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        submitRef.current();
      }}
    >
      <div
        className={`glass glow-ring mx-auto w-full max-w-3xl rounded-3xl p-3 ${
          focused ? "is-active" : ""
        } ${disabled ? "opacity-60" : ""}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
      <FormulaContext.Provider value={env}>
        <EditorContent editor={editor} />
      </FormulaContext.Provider>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className={`label ${
            dictationPhase === "listening" ? "animate-pulse motion-reduce:animate-none" : ""
          }`}
        >
          {dictationPhase === "listening"
            ? "Listening…"
            : dictationPhase === "transcribing"
              ? "Transcribing…"
              : "Enter to send · Shift+Enter for a new line"}
        </span>
        <div className="flex items-center gap-2">
          {controls}
          {mic}
          <button
            type="submit"
            disabled={disabled || empty}
            className="btn-primary"
          >
            Send
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
      </div>
    </form>
  );
}
