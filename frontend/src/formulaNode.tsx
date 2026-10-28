import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { editFormula } from "./api";
import { FormulaChip } from "./FormulaChip";
import { useFormulaEnv } from "./formulaContext";
import { useDictation } from "./useDictation";

/** Position of the formula node with this id, looked up at the moment of the change. */
function findFormula(editor: Editor, id: string): { pos: number; size: number } | null {
  // Asserted rather than annotated so TypeScript doesn't narrow it to null across the callback.
  let found = null as { pos: number; size: number } | null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "formula" && node.attrs.id === id) {
      found = { pos, size: node.nodeSize };
      return false;
    }
    return true;
  });
  return found;
}

export function setFormulaLatex(editor: Editor, id: string, latex: string): boolean {
  if (editor.isDestroyed) return false;
  const found = findFormula(editor, id);
  if (!found) return false;
  const node = editor.state.doc.nodeAt(found.pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(found.pos, undefined, { ...node.attrs, latex }));
  return true;
}

/** Undo math: the formula goes back to the words that were spoken. */
export function revertFormula(editor: Editor, id: string, spoken: string): boolean {
  if (editor.isDestroyed) return false;
  const found = findFormula(editor, id);
  if (!found) return false;
  const { state } = editor;
  const tr = spoken
    ? state.tr.replaceWith(found.pos, found.pos + found.size, state.schema.text(spoken))
    : state.tr.delete(found.pos, found.pos + found.size);
  editor.view.dispatch(tr);
  editor.commands.focus();
  return true;
}

function FormulaNodeView({ node, editor, selected }: NodeViewProps) {
  const env = useFormulaEnv();
  const id = String(node.attrs.id ?? "");
  const latex = String(node.attrs.latex ?? "");
  const spoken = String(node.attrs.spoken ?? "");
  const latexRef = useRef(latex);
  latexRef.current = latex;

  const { phase, toggle, abort } = useDictation({
    disabled: env.disabled,
    process: (said) => editFormula(latexRef.current, said),
    onResult: (next) => {
      setFormulaLatex(editor, id, next);
    },
    onError: env.onError,
    onPhase: (next) =>
      env.setMicOwner((owner) => (next === "idle" ? (owner === id ? null : owner) : id)),
  });

  const { setMicOwner } = env;
  useEffect(() => () => setMicOwner((owner) => (owner === id ? null : owner)), [id, setMicOwner]);

  const otherMicBusy = env.mainMicBusy || (env.micOwner !== null && env.micOwner !== id);

  return (
    <NodeViewWrapper as="span" className="formula-node" data-formula="">
      <FormulaChip
        latex={latex}
        selected={selected}
        editable={!env.disabled}
        voice={{
          phase,
          disabled: env.disabled || otherMicBusy,
          onToggle: toggle,
          onCancel: abort,
        }}
        onEditText={(next) => {
          setFormulaLatex(editor, id, next);
          editor.commands.focus();
        }}
        onUndo={() => revertFormula(editor, id, spoken)}
      />
    </NodeViewWrapper>
  );
}

/**
 * An atomic inline formula. The id is minted on every parse (paste included), so
 * a copied box never shares an id with its original; drafts set through JSON keep theirs.
 */
export const FormulaNode = Node.create({
  name: "formula",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: () => crypto.randomUUID(),
        renderHTML: () => ({}),
      },
      latex: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-latex") ?? "",
        renderHTML: (attributes) => ({ "data-latex": attributes.latex }),
      },
      spoken: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-spoken") ?? "",
        renderHTML: (attributes) => ({ "data-spoken": attributes.spoken }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-formula]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-formula": "" }), `$${node.attrs.latex}$`];
  },

  renderText({ node }) {
    return `$${node.attrs.latex}$`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(FormulaNodeView, { as: "span" });
  },
});
