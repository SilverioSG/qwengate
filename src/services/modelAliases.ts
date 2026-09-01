import type { ThinkingMode } from './qwen.ts';

interface ModelAlias {
  baseModel: string;
  thinkingMode: ThinkingMode;
}

const MODEL_ALIASES: Record<string, ModelAlias> = {
  'qwen3.8-max-fast': { baseModel: 'qwen3.8-max', thinkingMode: 'fast' },
  'qwen3.8-max-auto': { baseModel: 'qwen3.8-max', thinkingMode: 'auto' },
  'qwen3.8-max-thinking': { baseModel: 'qwen3.8-max', thinkingMode: 'thinking' },
};

export function resolveModelAlias(modelId: string): { baseModel: string; thinkingMode?: ThinkingMode } {
  const alias = MODEL_ALIASES[modelId];
  return alias
    ? { baseModel: alias.baseModel, thinkingMode: alias.thinkingMode }
    : { baseModel: modelId };
}

export function getModelAliases(): Readonly<Record<string, ModelAlias>> {
  return MODEL_ALIASES;
}
