import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
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
// Horizontal padding (px-3), the border, and a few pixels so subpixel rounding cannot clip the last letter.
const CARD_CHROME = 12 * 2 + 2 + 6;
const TITLE_FONT = '500 14px "Source Sans 3", ui-sans-serif, system-ui, sans-serif';
const KIND_FONT = '400 10px "Source Sans 3", ui-sans-serif, system-ui, sans-serif';

let measureCanvas: HTMLCanvasElement | null = null;

function labelWidth(text: string, font: string, trackingPx = 0): number {
  if (typeof document === "undefined" || text.length === 0) return text.length * 8;
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) return text.length * 8;
  context.font = font;
  const width = context.measureText(text).width;
  const tracking = text.length > 1 ? trackingPx * (text.length - 1) : 0;
  return width + tracking;
}

function cardWidth(title: string, kind: string): number {
  const titleWidth = labelWidth(title, TITLE_FONT);
  // The kind line is uppercase with tracking-wide (0.025em at 10px).
  const kindWidth = labelWidth(kind.toUpperCase(), KIND_FONT, 0.25);
  return Math.ceil(Math.max(titleWidth, kindWidth) + CARD_CHROME);
}

type ThreadCard = {
  title: string;
  kind: string;
  forkSnippet: string | null;
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

function layout(threads: Thread[], activeThreadId: string | null): { nodes: Node<ThreadCard>[]; edges: Edge[] } {
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
        active: thread.id === activeThreadId,
        hasChildren: kids.length > 0,
        isCenter: thread.parent_thread_id === null,
      },
    });
    const kidsWidth = kids.reduce((sum, kid, index) => sum + (widths.get(kid.id) ?? 0) + (index ? GAP_X : 0), 0);
    let cursor = left + (subtree - kidsWidth) / 2;
    for (const kid of kids) {
      edges.push({
        id: `${thread.id}-${kid.id}`,
        source: thread.id,
        target: kid.id,
        type: "smoothstep",
      });
      place(kid, cursor, top + NODE_H + GAP_Y);
      cursor += (widths.get(kid.id) ?? 0) + GAP_X;
    }
  }

  place(root, 0, 0);
  return { nodes, edges };
}

function ThreadNode({ id, data }: NodeProps<Node<ThreadNodeData>>) {
  return (
    <div
      title={data.forkSnippet ?? undefined}
      className={`group relative w-full rounded-lg border px-3 py-2 shadow-sm ${
        data.active ? "border-accent bg-user" : "border-line bg-panel"
      }`}
    >
      {!data.isCenter && (
        <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-accent" />
      )}
      {!data.isCenter && (
        <button
          type="button"
          aria-label={`Delete ${data.title}`}
          className="nodrag nopan absolute -top-2 right-1 hidden rounded border border-line bg-panel px-1 py-0.5 text-[10px] leading-none text-muted hover:text-rose-700 group-hover:block dark:hover:text-rose-300"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onDelete(id);
          }}
        >
          Delete
        </button>
      )}
      <div className="whitespace-nowrap text-[10px] uppercase tracking-wide text-muted">{data.kind}</div>
      <div className="whitespace-nowrap text-sm font-medium">{data.title}</div>
      {data.forkSnippet && (
        <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-[200px] rounded-md border border-line bg-panel p-2 text-xs leading-snug text-muted shadow-lg group-hover:block">
          {data.forkSnippet}
        </div>
      )}
      {data.hasChildren && (
        <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-accent" />
      )}
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
  const graph = useMemo(() => layout(threads, activeThreadId), [threads, activeThreadId, fontsReady]);
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
      <Background gap={18} color="var(--line)" />
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
