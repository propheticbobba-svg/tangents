import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { Thread } from "./types";

const NODE_H = 72;
const GAP_X = 36;
const GAP_Y = 64;
// Keep these in sync with ThreadNode: px-3 padding, a 1px border, text-sm font-medium title,
// and the .label kind line (Geist Mono, 0.65625rem = 10.5px, letter-spacing 0.14em).
// The extra 6px keeps subpixel rounding from clipping the last letter.
const CARD_CHROME = 12 * 2 + 2 + 6;
const TITLE_FONT = '500 14px "Geist", ui-sans-serif, system-ui, sans-serif';
const KIND_FONT = '400 10.5px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const KIND_TRACKING = 10.5 * 0.14;

let measureCanvas: HTMLCanvasElement | null = null;

function labelWidth(text: string, font: string, trackingPx = 0): number {
  if (typeof document === "undefined" || text.length === 0) return text.length * 8;
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) return text.length * 8;
  context.font = font;
  const width = context.measureText(text).width;
  // CSS letter-spacing is also added after the last character.
  return width + trackingPx * text.length;
}

function cardWidth(title: string, kind: string): number {
  const titleWidth = labelWidth(title, TITLE_FONT);
  // The kind line is the uppercase .label style.
  const kindWidth = labelWidth(kind.toUpperCase(), KIND_FONT, KIND_TRACKING);
  return Math.ceil(Math.max(titleWidth, kindWidth) + CARD_CHROME);
}

type ThreadCard = {
  title: string;
  kind: string;
  forkSnippet: string | null;
  sketch: string | null;
  active: boolean;
  hasChildren: boolean;
  isCenter: boolean;
};

type ThreadNodeData = ThreadCard & {
  onDelete: (threadId: string) => void;
};

function childrenOf(threads: Thread[], parentId: string | null): Thread[] {
  return threads
    .filter((thread) => thread.parent_thread_id === parentId)
    .sort((a, b) => {
      const position = (a.fork_position ?? -1) - (b.fork_position ?? -1);
      if (position !== 0) return position;
      return a.created_at.localeCompare(b.created_at);
    });
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const EDGE_STYLE = { stroke: "var(--line)", strokeWidth: 1 };
const ACTIVE_EDGE_STYLE = {
  stroke: "color-mix(in srgb, var(--ink) 55%, transparent)",
  strokeWidth: 1.25,
  filter: "drop-shadow(0 0 3px var(--glow))",
};

function layout(
  threads: Thread[],
  activeThreadId: string | null,
  reducedMotion: boolean,
): { nodes: Node<ThreadCard>[]; edges: Edge[] } {
  const root = threads.find((thread) => thread.parent_thread_id === null);
  if (!root) return { nodes: [], edges: [] };

  const cards = new Map<string, number>();
  for (const thread of threads) {
    const kind = thread.parent_thread_id ? "Side node" : "Center";
    cards.set(thread.id, cardWidth(thread.title, kind));
  }

  const widths = new Map<string, number>();
  function measure(id: string): number {
    const own = cards.get(id) ?? cardWidth("", "Center");
    const kids = childrenOf(threads, id);
    if (kids.length === 0) {
      widths.set(id, own);
      return own;
    }
    const total = kids.reduce((sum, kid, index) => sum + measure(kid.id) + (index ? GAP_X : 0), 0);
    const width = Math.max(own, total);
    widths.set(id, width);
    return width;
  }
  measure(root.id);

  const nodes: Node<ThreadCard>[] = [];
  const edges: Edge[] = [];

  function place(thread: Thread, left: number, top: number) {
    const kids = childrenOf(threads, thread.id);
    const subtree = widths.get(thread.id) ?? cards.get(thread.id) ?? 0;
    const card = cards.get(thread.id) ?? subtree;
    nodes.push({
      id: thread.id,
      type: "thread",
      position: { x: left + subtree / 2 - card / 2, y: top },
      draggable: false,
      connectable: false,
      className: "hover:!z-50",
      style: { width: card, overflow: "visible" },
      data: {
        title: thread.title,
        kind: thread.parent_thread_id ? "Side node" : "Center",
        forkSnippet: thread.fork_snippet ?? null,
        sketch: thread.sketch ?? null,
        active: thread.id === activeThreadId,
        hasChildren: kids.length > 0,
        isCenter: thread.parent_thread_id === null,
      },
    });
    const kidsWidth = kids.reduce((sum, kid, index) => sum + (widths.get(kid.id) ?? 0) + (index ? GAP_X : 0), 0);
    let cursor = left + (subtree - kidsWidth) / 2;
    for (const kid of kids) {
      const intoActive = kid.id === activeThreadId;
      edges.push({
        id: `${thread.id}-${kid.id}`,
        source: thread.id,
        target: kid.id,
        type: "smoothstep",
        animated: intoActive && !reducedMotion,
        style: intoActive ? ACTIVE_EDGE_STYLE : EDGE_STYLE,
      });
      place(kid, cursor, top + NODE_H + GAP_Y);
      cursor += (widths.get(kid.id) ?? 0) + GAP_X;
    }
  }

  place(root, 0, 0);
  return { nodes, edges };
}

function handleClass(active: boolean): string {
  return `!h-[5px] !w-[5px] !min-h-0 !min-w-0 !border-0 ${active ? "!bg-ink" : "!bg-muted"}`;
}

function ThreadNode({ id, data }: NodeProps<Node<ThreadNodeData>>) {
  const hover = [data.forkSnippet, data.sketch].filter(Boolean).join("\n\n");
  return (
    <div
      title={hover || undefined}
      className={`glass group relative w-full rounded-xl px-3 py-2 transition-[border-color,box-shadow] ${
        data.active ? "glow-ring is-active !border-accent/80" : "hover:!border-muted/60"
      }`}
    >
      {!data.isCenter && <Handle type="target" position={Position.Top} className={handleClass(data.active)} />}
      {!data.isCenter && (
        <button
          type="button"
          aria-label={`Delete ${data.title}`}
          className="nodrag nopan absolute -top-2.5 right-2 hidden rounded-full border border-line bg-paper px-1.5 py-0.5 font-mono text-[9px] uppercase leading-none tracking-[0.1em] text-muted transition-colors hover:border-danger/50 hover:text-danger group-hover:block"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onDelete(id);
          }}
        >
          Delete
        </button>
      )}
      <div className="label whitespace-nowrap">{data.kind}</div>
      <div className="whitespace-nowrap text-sm font-medium text-ink">{data.title}</div>
      {data.forkSnippet && (
        <div className="glass fade-in pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-[200px] rounded-xl !bg-[color-mix(in_srgb,var(--paper)_90%,transparent)] p-2.5 text-xs leading-snug text-muted shadow-lg group-hover:block">
          {data.forkSnippet}
        </div>
      )}
      {data.hasChildren && <Handle type="source" position={Position.Bottom} className={handleClass(data.active)} />}
    </div>
  );
}

const nodeTypes = { thread: ThreadNode };

function Canvas({
  threads,
  activeThreadId,
  onSelect,
  onDelete,
  disabled,
  colorMode,
}: {
  threads: Thread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  disabled: boolean;
  colorMode: "light" | "dark";
}) {
  const { fitView } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const [fontsReady, setFontsReady] = useState(() => document.fonts?.status === "loaded");
  const reducedMotion = usePrefersReducedMotion();
  const graph = useMemo(
    () => layout(threads, activeThreadId, reducedMotion),
    [threads, activeThreadId, reducedMotion, fontsReady],
  );
  // onDelete stays out of this memo. A new function each render would replace the
  // nodes prop, and React Flow then forgets the measured size of every card.
  const nodes = useMemo(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onDelete: (threadId: string) => onDeleteRef.current(threadId),
        },
      })),
    [graph],
  );

  useEffect(() => {
    const ready = document.fonts?.ready;
    if (!ready) return;
    let active = true;
    void ready.then(() => {
      if (active) setFontsReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // React Flow hides a node until it has measured it, and replaces of the
    // nodes prop clear that measurement. A card whose size did not change never
    // gets another ResizeObserver callback, so the center stays invisible after
    // a fork. Measure here, then fit the view once those sizes are stored.
    updateNodeInternals(graph.nodes.map((node) => node.id));
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        void fitView({ padding: 0.25, maxZoom: 1, duration: 200 });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [graph, fitView, updateNodeInternals]);

  const paneWidth = useStore((state) => state.width);

  useEffect(() => {
    if (paneWidth === 0) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.25, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [paneWidth, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      colorMode={colorMode}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      onNodeClick={(_, node) => {
        if (!disabled) onSelect(node.id);
      }}
      proOptions={{ hideAttribution: false }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--line)" bgColor="transparent" className="opacity-70" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function TreeView(props: {
  threads: Thread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  disabled: boolean;
  colorMode: "light" | "dark";
}) {
  return (
    <div className={`h-full ${props.disabled ? "pointer-events-none opacity-60" : ""}`}>
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
