import type { Message, ToolDefinition, ToolCall, Usage, ProviderMetadata, RuntimeEvent, ApprovalRequest } from './vendor/core/types.ts';

export type { Message, ToolDefinition, ToolCall, Usage, ProviderMetadata, RuntimeEvent, ApprovalRequest };
export type AdapterKind = 'cluster' | 'openai-compatible' | 'gemrouter' | 'ollama' | 'openai-responses' | 'gemini' | 'codex' | 'antigravity';

/** Trusted server configuration. Secrets are supplied separately, never returned in catalog data. */
export interface AdapterConnection {
  id: string;
  label: string;
  kind: AdapterKind;
  baseUrl?: string;
  accountId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Service-managed native profile directory, never supplied by a client. */
  isolatedProfilePath?: string;
}
export interface ModelSelection { id: string; contextWindow?: number; maxOutputTokens?: number; temperature?: number; }
export interface DiscoveredModel {
  id: string;
  label: string;
  contextWindow?: number;
  capabilities: Array<'chat' | 'tools' | 'embedding' | 'vision'>;
  capabilitySource: 'provider' | 'unknown';
}
export interface QuotaObservation {
  state: 'known' | 'unknown' | 'limited';
  observedAt: string;
  source: 'provider-headers' | 'official-runtime' | 'unknown';
  remainingRequests?: number;
  retryAfterMs?: number;
  buckets?: Array<{ id: string; label: string; windows: Array<{ name: string; usedPercent: number; remainingPercent: number; windowMinutes?: number; resetsAt?: number }> }>;
}
export interface DiscoveryResult { models: DiscoveredModel[]; quota: QuotaObservation; warnings: string[]; }
export interface InferenceMetrics {
  totalMs: number;
  ttftMs?: number;
  prefillMs?: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  contextLimit?: number;
  contextUsed?: number;
  contextRemaining?: number;
  sources: { usage: 'provider' | 'engine' | 'unknown'; ttft: 'gateway'; prefill: 'engine' | 'unknown'; decode: 'engine' | 'unknown'; context: 'configured' | 'unknown' };
}
export interface InferenceResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  metrics: InferenceMetrics;
  finishReason?: string;
  providerMetadata?: ProviderMetadata;
  quota: QuotaObservation;
}
export interface InferenceRequest {
  connection: AdapterConnection;
  model: ModelSelection;
  secret?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  signal: AbortSignal;
  onText: (text: string) => void;
  timeoutMs?: number;
}
export interface EmbedRequest {
  connection: AdapterConnection;
  model: string;
  secret?: string;
  texts: string[];
  signal: AbortSignal;
  maxEmbeddingChars?: number;
}
export interface EmbeddingResult { model: string; dimensions: number; vectors: number[][]; inputTokens?: number; }
export interface NativeRequest {
  connection: AdapterConnection;
  model: ModelSelection;
  cwd: string;
  prompt: string;
  readOnly: boolean;
  workspaceTools?: import('./vendor/core/types.ts').ExternalWorkspaceTools;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: RuntimeEvent) => void;
  resumeId?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}
export interface NativeResult {
  text: string;
  sessionId: string;
  usage?: Usage;
  quota: QuotaObservation;
  thinking?: string;
  thinkingMs?: number;
  actions?: Array<{ title: string; kind?: 'command' | 'tool' | 'file' | 'status'; detail?: string; status?: string }>;
}
