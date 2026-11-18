export type ProviderKind = 'openai-compatible' | 'openai-responses' | 'gemini' | 'codex' | 'antigravity';

export interface Profile {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  accountId: string;
  baseUrl?: string;
  command?: string;
  args?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  /** Non-secret environment overrides for CLI processes. */
  env?: Record<string, string>;
}

export interface ToolCall { id: string; name: string; arguments: string; }
export interface ProviderMetadata {
  kind: ProviderKind;
  model: string;
  profileId: string;
  accountId: string;
  endpoint: string;
  items: Record<string, unknown>[];
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  providerMetadata?: ProviderMetadata;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; }
export interface CompletionRequest {
  profile: Profile;
  apiKey?: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  onText: (text: string) => void;
}
export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
  providerMetadata?: ProviderMetadata;
  remainingRequests?: number;
  engineTiming?: { prefillMs?: number; prefillTokensPerSecond?: number; decodeTokensPerSecond?: number };
}
export interface HttpCompleter { complete(request: CompletionRequest): Promise<CompletionResult>; }

export interface RuntimeEvent {
  type: 'text' | 'tool' | 'status' | 'usage' | 'quota' | 'thinking';
  text?: string;
  name?: string;
  detail?: string;
  usage?: Usage;
  quota?: Record<string, unknown>;
}
export interface ApprovalRequest {
  title: string;
  detail: string;
  kind: 'command' | 'write' | 'network' | 'other';
}
export interface ExternalWorkspaceTools {
  definitions: ToolDefinition[];
  execute: (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{ ok: boolean; output: string }>;
}
export interface ExternalRequest {
  profile: Profile;
  cwd: string;
  /** Complete instruction plus any context not yet seen by the saved runtime session. */
  prompt: string;
  resumeId?: string;
  readOnly: boolean;
  workspaceTools?: ExternalWorkspaceTools;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
  approve: (request: ApprovalRequest) => Promise<boolean>;
}
export interface ExternalResult {
  text: string;
  sessionId: string;
  usage?: Usage;
  thinking?: string;
  thinkingMs?: number;
  actions?: Array<{ title: string; kind?: 'command' | 'tool' | 'file' | 'status'; detail?: string; status?: string }>;
}
export interface ExternalBackend { run(request: ExternalRequest): Promise<ExternalResult>; }

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt: string;
  profileId?: string;
  model?: string;
  status?: 'streaming' | 'complete' | 'cancelled' | 'error';
  label?: string;
}
export interface RemoteSession { id: string; historyCursor: number; fingerprint: string; }
export interface Session {
  id: string;
  title: string;
  workspaceKey: string;
  createdAt: string;
  updatedAt: string;
  entries: ChatEntry[];
  messages: Message[];
  remoteSessions: Record<string, RemoteSession>;
}
export interface AccountUsage {
  accountId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported quota only. Absence means unknown, never unlimited. */
  remainingRequests?: number;
  cooldownUntil?: number;
  lastError?: string;
  updatedAt: string;
}
export interface TeamTask {
  id: string;
  role: string;
  profileId: string;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  output?: string;
}
export interface UiState {
  workspaceName: string;
  trusted: boolean;
  profiles: Array<Pick<Profile, 'id' | 'name' | 'kind' | 'model' | 'accountId'>>;
  activeProfileId?: string;
  sessions: Array<Pick<Session, 'id' | 'title' | 'updatedAt'>>;
  activeSession?: Session;
  running: boolean;
  usage: AccountUsage[];
  teamTasks: TeamTask[];
  error?: string;
}

export type UiCommand =
  | { type: 'ready' }
  | { type: 'send'; text: string; mode?: 'agent' | 'plan' }
  | { type: 'cancel' }
  | { type: 'selectProfile'; profileId: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'addProfile' }
  | { type: 'manageProfiles' }
  | { type: 'setCredential' }
  | { type: 'login' }
  | { type: 'openMemory' }
  | { type: 'exportSession' }
  | { type: 'addSelection' }
  | { type: 'runTeam'; text: string };
