export interface CommandRecipe {
  id: string;
  label: string;
  /** Operator-owned argv, never interpolated with model output. No shell is used. */
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Only explicitly marked verification recipes can satisfy a delivery check. */
  verification?: boolean;
  /** Infrastructure/release controllers may run this recipe; model tools cannot. */
  controllerOnly?: boolean;
}
export interface DeploymentRecipe {
  id: string;
  label: string;
  /** Verification recipes run before the approval boundary. */
  verify: string[];
  steps: string[];
  health: { url: string; expectedStatus?: number; expectedText?: string; timeoutMs?: number; attempts?: number };
  rollback?: string[];
}
export interface ExecutionTarget {
  id: string;
  nodeId: string;
  kind: 'local' | 'ssh';
  /** Absolute path on the execution machine; configured by its operator. */
  workspaceRoot: string;
  sshHost?: string;
  sshPort?: number;
  remoteNode?: string;
  remoteRunner?: string;
  remoteConfig?: string;
  commands: CommandRecipe[];
  deployments?: DeploymentRecipe[];
}
export interface WorkspaceRevision {
  digest: string;
  gitCommit?: string;
}
export type Operation =
  | { kind: 'prepare' }
  | { kind: 'snapshot' }
  | { kind: 'list'; directory?: string }
  | { kind: 'read'; path: string; startLine?: number; endLine?: number }
  | { kind: 'search'; query: string; directory?: string }
  | { kind: 'write'; path: string; content: string; expectedSha256?: string }
  | { kind: 'command'; recipeId: string }
  | { kind: 'verify'; recipeId: string; expectedRecipeDigest?: string }
  | { kind: 'deploy'; recipeId: string; expectedWorkspaceDigest?: string; expectedRecipeDigest?: string }
  | { kind: 'telemetry' };
export interface ExecutionApproval {
  kind: 'write' | 'command' | 'deployment';
  title: string;
  detail: string;
  targetId: string;
  workspace: string;
  digest: string;
}
export interface ExecutionEvidence {
  kind: string;
  targetId: string;
  workspace: string;
  startedAt: string;
  finishedAt: string;
  recipeId?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  outputSha256?: string;
  healthStatus?: number;
  /** Health is observed from the execution machine, not globally. */
  healthUrl?: string;
  rollback?: 'not-configured' | 'not-needed' | 'succeeded' | 'failed';
}
export interface ExecutionResult {
  ok: boolean;
  output: string;
  exitCode?: number | null;
  changedFiles?: string[];
  evidence: ExecutionEvidence[];
  data?: unknown;
  denied?: boolean;
}
export interface ExecutionRequest {
  target: ExecutionTarget;
  workspace?: string;
  operation: Operation;
  signal: AbortSignal;
  approve: (request: ExecutionApproval) => Promise<boolean>;
  onEvent?: (event: { type: 'execution'; targetId: string; kind: string; message: string }) => void;
}
export interface ToolCall { name: string; arguments: string | Record<string, unknown>; }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
