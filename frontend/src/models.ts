// Current Claude API lineup. https://platform.claude.com/docs/en/about-claude/models/overview
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ALL_EFFORTS, defaultEffort: "high", thinking: "adaptive" },
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ALL_EFFORTS, defaultEffort: "medium", thinking: "adaptive" },
  { id: "claude-fable-5-1", label: "Fable 5.1", efforts: ALL_EFFORTS, defaultEffort: "high", thinking: "adaptive" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [], defaultEffort: null, thinking: "extended" },
] as const satisfies readonly {
  id: string;
  label: string;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  thinking: "adaptive" | "extended";
}[];

export type ModelId = (typeof MODELS)[number]["id"];

const STORAGE_KEY = "tangents-model";
const EFFORT_KEY = "tangents-effort";
const EXTENDED_KEY = "tangents-extended-thinking";
const DEFAULT_MODEL: ModelId = "claude-sonnet-5-5";

export function modelInfo(id: ModelId) {
  const found = MODELS.find((model) => model.id === id);
  if (!found) return MODELS[0];
  return found;
}

export function loadModel(): ModelId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && MODELS.some((model) => model.id === stored)) return stored as ModelId;
  return DEFAULT_MODEL;
}

export function saveModel(model: ModelId) {
  localStorage.setItem(STORAGE_KEY, model);
}

function readEffortMap(): Partial<Record<ModelId, Effort>> {
  const raw = localStorage.getItem(EFFORT_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Partial<Record<ModelId, Effort>>;
  } catch {
    return {};
  }
}

export function loadEffort(id: ModelId): Effort | null {
  const info = modelInfo(id);
  const stored = readEffortMap()[id];
  if (stored && (info.efforts as readonly Effort[]).includes(stored)) return stored;
  return info.defaultEffort;
}

export function saveEffort(id: ModelId, level: Effort) {
  const map = readEffortMap();
  map[id] = level;
  localStorage.setItem(EFFORT_KEY, JSON.stringify(map));
}

export function loadExtendedThinking(): boolean {
  return localStorage.getItem(EXTENDED_KEY) === "1";
}

export function saveExtendedThinking(value: boolean) {
  localStorage.setItem(EXTENDED_KEY, value ? "1" : "0");
}
