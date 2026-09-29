import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { Thread } from "./types";

const NODE_W = 200;
const NODE_H = 72;
const GAP_X = 36;
const GAP_Y = 64;

type ThreadNodeData = {
  title: string;
  kind: string;
  forkSnippet: string | null;
  active: boolean;
  hasChildren: boolean;
  isCenter: boolean;
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

function layout(threads: Thread[], activeThreadId: string | null): { nodes: Node<ThreadNodeData>[]; edges: Edge[] } {
  const root = threads.find((thread) => thread.parent_thread_id === null);
  if (!root) return { nodes: [], edges: [] };

  const widths = new Map<string, number>();
  function measure(id: string): number {
    const kids = childrenOf(threads, id);
    if (kids.length === 0) {
      widths.set(id, NODE_W);
      return NODE_W;
    }
    const total = kids.reduce((sum, kid, index) => sum + measure(kid.id) + (index ? GAP_X : 0), 0);
    const width = Math.max(NODE_W, total);
    widths.set(id, width);
    return width;
  }
  measure(root.id);

  const nodes: Node<ThreadNodeData>[] = [];
  const edges: Edge[] = [];

  function place(thread: Thread, left: number, top: number) {
    const kids = childrenOf(threads, thread.id);
    const subtree = widths.get(thread.id) ?? NODE_W;
    nodes.push({
      id: thread.id,
      type: "thread",
      position: { x: left + subtree / 2 - NODE_W / 2, y: top },
      draggable: false,
      connectable: false,
      className: "hover:!z-50",
      style: { width: NODE_W, overflow: "visible" },
      data: {
        title: thread.title,
        kind: thread.parent_thread_id ? "Side node" : "Center",
        forkSnippet: thread.fork_snippet ?? null,
        active: thread.id === activeThreadId,
        hasChildren: kids.length > 0,
        isCenter: thread.parent_thread_id === null,
      },
    });
    const kidsWidth = kids.reduce((sum, kid, index) => sum + (widths.get(kid.id) ?? NODE_W) + (index ? GAP_X : 0), 0);
    let cursor = left + (subtree - kidsWidth) / 2;
    for (const kid of kids) {
      edges.push({
        id: `${thread.id}-${kid.id}`,
        source: thread.id,
        target: kid.id,
        type: "smoothstep",
      });
      place(kid, cursor, top + NODE_H + GAP_Y);
      cursor += (widths.get(kid.id) ?? NODE_W) + GAP_X;
    }
  }

  place(root, 0, 0);
  return { nodes, edges };
}

function ThreadNode({ data }: NodeProps<Node<ThreadNodeData>>) {
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
      <div className="text-[10px] uppercase tracking-wide text-muted">{data.kind}</div>
      <div className="truncate text-sm font-medium">{data.title}</div>
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
  disabled,
  colorMode,
}: {
  threads: Thread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  disabled: boolean;
  colorMode: "light" | "dark";
}) {
  const { fitView } = useReactFlow();
  const graph = useMemo(() => layout(threads, activeThreadId), [threads, activeThreadId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.25, maxZoom: 1, duration: 200 });
    });
    return () => cancelAnimationFrame(frame);
  }, [threads, fitView]);

  return (
    <ReactFlow
      nodes={graph.nodes}
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
