// Current Claude API lineup. https://platform.claude.com/docs/en/about-claude/models/overview
export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

const STORAGE_KEY = "tangents-model";
const DEFAULT_MODEL: ModelId = "claude-sonnet-5-5";

export function loadModel(): ModelId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && MODELS.some((model) => model.id === stored)) return stored as ModelId;
  return DEFAULT_MODEL;
}

export function saveModel(model: ModelId) {
  localStorage.setItem(STORAGE_KEY, model);
}
