/** Shared product contract. Runtime, browser and VS Code are authored in TypeScript. */
export type { RouteAvailability, RouteDecision } from './routing-types.ts';
export type { ConnectionInput, ConnectionResult, ConnectionOptions, ConnectionDetection, ConnectionPreset } from './connection-types.ts';
export type { ProviderLoadObservation } from './load-types.ts';
export type RequestedMode = 'auto' | 'chat' | 'mission';
export interface RoutingPreferences {
    strategy: 'auto' | 'pinned';
    fallbackRouteIds: string[];
    maxWaitMs?: number;
}
export type Role = 'admin' | 'operator' | 'member' | 'viewer';
export interface Appearance {
    theme?: 'dark' | 'light' | 'system';
    motion?: 'on' | 'off';
}
export interface User {
    appearance?: Appearance;
    id: string;
    name: string;
    role: Role;
    createdAt: string;
}
export interface NodeConfig {
    id: string;
    label: string;
    kind: 'strix' | 'cuda' | 'server' | 'cloud';
    host?: string;
    capabilities: string[];
    telemetry?: {
        url?: string;
        kind: 'node-agent' | 'gateway' | 'native';
        secretEnv?: string;
        targetId?: string;
        key?: string;
    };
}
export interface NetworkLink {
    id: string;
    from: string;
    to: string;
    label: string;
    address?: string;
    status: 'configured' | 'observed' | 'unknown';
}
export interface ResourceGroup {
    id: string;
    label: string;
    nodeIds: string[];
    capacity: number;
}
export interface Telemetry {
    nodeId: string;
    status: 'online' | 'offline' | 'stale' | 'unknown';
    observedAt?: string;
    quality: 'measured' | 'legacy-unverified' | 'unknown';
    cpuPercent?: number;
    cpuTempC?: number;
    ramUsedBytes?: number;
    ramTotalBytes?: number;
    gpuPercent?: number;
    gpuTempC?: number;
    gpuPowerW?: number;
    gpuMemoryUsedBytes?: number;
    gpuMemoryTotalBytes?: number;
    details?: Record<string, unknown>;
    error?: string;
}
export type ProviderKind = 'openai-compatible' | 'openai-responses' | 'ollama' | 'gemini' | 'codex' | 'antigravity';
export interface Provider {
    id: string;
    label: string;
    kind: ProviderKind;
    baseUrl?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    nodeIds: string[];
    resourceGroupIds: string[];
    enabled: boolean;
    maxConcurrent?: number;
    tag?: 'gemrouter' | 'cluster' | 'cloud' | 'local';
    ownerId: string;
    createdAt: string;
}
export interface Quota {
    observedAt: string;
    remainingRequests?: number;
    remainingTokens?: number;
    resetAt?: string;
    cooldownUntil?: string;
    windows?: Array<{
        label: string;
        bucketId?: string;
        windowName?: string;
        windowMinutes?: number;
        usedPercent?: number;
        resetAt?: string;
    }>;
    source: 'provider' | 'rate-limit';
    observationSource?: 'provider-headers' | 'official-runtime';
}
export interface Account {
    grantedUserIds?: string[];
    id: string;
    providerId: string;
    ownerId: string;
    label: string;
    shared: boolean;
    status: 'unknown' | 'ready' | 'cooldown' | 'error';
    quota?: Quota;
    /** Explicit operator mapping. A label only groups accounts under the same owner. */
    quotaDomain?: string;
    hasSecret: boolean;
    nativeProfile?: 'isolated' | 'service';
}
export interface ModelRoute {
    capabilitiesOverridden?: boolean;
    archived?: boolean;
    id: string;
    providerId: string;
    accountId: string;
    label: string;
    model: string;
    nodeIds: string[];
    resourceGroupIds: string[];
    contextWindow?: number;
    maxOutputTokens?: number;
    capabilities: string[];
    capabilitySource?: 'provider' | 'operator' | 'unknown';
    discoveryStatus?: 'present' | 'missing' | 'unverified';
    enabled: boolean;
}
export interface Project {
    id: string;
    ownerId: string;
    memberIds: string[];
    name: string;
    description: string;
    targetId?: string;
    workspace?: string;
    workspaceIsolation?: 'shared' | 'git-worktree';
    routes: {
        primary?: string;
        coder?: string;
        reviewer?: string;
        researcher?: string;
        embedding?: string;
    };
    verifyRecipeIds: string[];
    deploymentRecipeId?: string;
    routing?: RoutingPreferences;
    createdAt: string;
    updatedAt: string;
}
export interface Metrics {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    ttftMs?: number;
    durationMs?: number;
    queueMs?: number;
    contextMs?: number;
    loadMs?: number;
    decodeTokensPerSecond?: number;
    prefillMs?: number;
    prefillTokensPerSecond?: number;
    contextWindow?: number;
    contextUsed?: number;
    contextSource?: 'provider' | 'estimated';
    thinkingMs?: number;
    source: string;
}
export interface ChatMessageAction {
    title: string;
    kind?: 'command' | 'tool' | 'file' | 'status';
    detail?: string;
    status?: string;
}
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    text: string;
    createdAt: string;
    routeId?: string;
    runId?: string;
    status?: 'streaming' | 'complete' | 'error' | 'cancelled';
    metrics?: Metrics;
    attachmentIds?: string[];
    source?: 'model' | 'service';
    thinking?: string;
    thinkingMs?: number;
    actions?: ChatMessageAction[];
}
export interface Conversation {
    branch?: { conversationId: string; messageId: string; createdAt: string };
    id: string;
    projectId: string;
    ownerId: string;
    title: string;
    routeId?: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
}
export type RunStatus = 'queued' | 'planning' | 'executing' | 'reviewing' | 'verifying' | 'awaiting_release' | 'deploying' | 'succeeded' | 'failed' | 'paused' | 'cancelled' | 'interrupted' | 'blocked';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export interface TaskAttempt {
    id: string;
    number: number;
    status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
    requestedRouteId: string;
    routeId?: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    evidenceIds?: string[];
}
export interface RunOperation {
    id: string;
    taskId: string;
    attemptId?: string;
    kind: 'write' | 'command' | 'verify' | 'deploy' | 'native' | 'promotion' | 'cleanup';
    label: string;
    digest: string;
    state: 'dispatched' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'uncertain' | 'reconciled';
    workspaceDigest?: string;
    startedAt: string;
    finishedAt?: string;
    approvalIds?: string[];
    evidenceId?: string;
    reconciliation?: { outcome: 'applied' | 'not_applied' | 'rolled_back'; note: string; actorId: string; decidedAt: string };
}
export interface RunSpec {
    capturedAt: string;
    targetId?: string;
    workspace?: string;
    workspaceIsolation?: Project['workspaceIsolation'];
    routes: Project['routes'];
    verifyRecipeIds: string[];
    deploymentRecipeId?: string;
    definitionDigest?: string;
}
export interface VerificationReceipt {
    digest: string;
    workspaceDigest: string;
    definitionDigest: string;
    gitCommit?: string;
    candidateCommit?: string;
    verifiedAt: string;
    evidenceIds: string[];
    artifactId?: string;
}
export interface RunCheckpoint {
    iteration: number;
    plannerTaskId?: string;
    taskIds?: string[];
    reviewTaskId?: string;
    verifyTaskId?: string;
    verificationWorkspaceDigest?: string;
}
export interface RunWorktree {
    workspace: string;
    baseCommit: string;
    sourceRef?: string;
    sourceRepository: string;
    state: 'preparing' | 'active' | 'verified' | 'promoted' | 'removed';
    createdAt: string;
    candidateCommit?: string;
    candidateRef?: string;
    changedFiles?: string[];
    reviewArtifactId?: string;
    promotedRef?: string;
    promotedDigest?: string;
    promotedAt?: string;
    promotedBy?: string;
    removedAt?: string;
}
export interface AgentTask {
    id: string;
    runId: string;
    label: string;
    role: 'primary' | 'researcher' | 'coder' | 'reviewer' | 'tester' | 'release';
    instruction: string;
    dependencies: string[];
    routeId: string;
    status: TaskStatus;
    control?: 'paused';
    attempt: number;
    attempts?: TaskAttempt[];
    output?: string;
    error?: string;
    startedAt?: string;
    endedAt?: string;
    metrics?: Metrics;
    thinking?: string;
    thinkingMs?: number;
    actions?: ChatMessageAction[];
    context?: ContextReport;
    evidenceIds: string[];
    routing?: { requestedRouteId: string; chosenRouteId: string; switched: boolean; waitMs: number; reason: string };
}
export interface Run {
    id: string;
    projectId: string;
    conversationId: string;
    ownerId: string;
    goal: string;
    sourceMessageId?: string;
    parentRunId?: string;
    spec?: RunSpec;
    checkpoint?: RunCheckpoint;
    operations?: RunOperation[];
    verification?: VerificationReceipt;
    worktree?: RunWorktree;
    mode: 'chat' | 'mission';
    requestedMode?: RequestedMode;
    intent?: 'conversation' | 'work' | 'service';
    routing?: RoutingPreferences;
    status: RunStatus;
    phase: string;
    routeId: string;
    tasks: AgentTask[];
    iteration: number;
    maxIterations: number;
    maxParallel: number;
    budget: {
        maxModelCalls: number;
        maxOutputTokens: number;
        callsUsed: number;
        outputTokensUsed: number;
    };
    permissions: {
        write: boolean;
        commands: boolean;
        deploy: boolean;
    };
    createdAt: string;
    updatedAt: string;
    error?: string;
    summary?: string;
    releasedAt?: string;
    verificationPassed?: boolean;
}
export interface RunEvent {
    id: number;
    ownerId: string;
    projectId?: string;
    runId?: string;
    taskId?: string;
    type: string;
    text?: string;
    data?: Record<string, unknown>;
    createdAt: string;
}
export interface Approval {
    id: string;
    ownerId: string;
    projectId: string;
    runId: string;
    taskId?: string;
    kind: 'write' | 'command' | 'release' | 'native' | 'memory' | 'promotion' | 'cleanup';
    title: string;
    detail: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    createdAt: string;
    expiresAt: string;
    operationId?: string;
    digest?: string;
    decidedAt?: string;
    decidedBy?: string;
}
export interface Artifact {
    id: string;
    projectId: string;
    ownerId: string;
    name: string;
    mime: string;
    bytes: number;
    sha256: string;
    createdAt: string;
    runId?: string;
    kind: 'attachment' | 'evidence' | 'deliverable';
}
export interface Memory {
    id: string;
    projectId: string;
    ownerId: string;
    scope: 'private' | 'project';
    kind: 'method' | 'decision' | 'brief' | 'document';
    title: string;
    content: string;
    status: 'candidate' | 'approved' | 'retired';
    revision: number;
    sourceIds: string[];
    createdAt: string;
    updatedAt: string;
    indexed?: boolean;
}
export interface KnowledgeSource {
    id: string;
    title: string;
    kind: 'memory' | 'attachment';
    scope: 'private' | 'project';
    revision?: number;
    sourceHash: string;
}
export interface KnowledgeCitation {
    sourceId: string;
    passageId: string;
    revision?: number;
    sourceHash: string;
    excerptHash: string;
    scope: KnowledgeSource['scope'];
    start: number;
    end: number;
}
export interface KnowledgePassage {
    id: string;
    title: string;
    text: string;
    kind: KnowledgeSource['kind'];
    score: number;
    method: 'lexical' | 'hybrid' | 'vector' | 'related';
    citation: KnowledgeCitation;
    signals: {
        matchingTerms: string[];
        semanticSimilarity?: number;
        semanticAlignment?: number;
        slots?: Array<{ slot: number; weight: number }>;
        relatedTo?: string;
    };
}
export interface KnowledgeSearchResult {
    results: KnowledgePassage[];
    report: {
        mode: 'lexical' | 'hybrid';
        scannedPassages: number;
        scannedSources: number;
        consideredPassages: number;
        usedChars: number;
        maxChars: number;
        truncated: boolean;
        embeddingStatus: 'not-configured' | 'not-indexed' | 'unavailable' | 'incompatible' | 'used';
    };
}
export interface ContextSource {
    id: string;
    kind: 'instruction' | 'history' | 'memory' | 'attachment' | 'task';
    title: string;
    estimatedTokens: number;
    included: boolean;
    reason: string;
    revision?: number;
    sha256?: string;
    citation?: KnowledgeCitation;
}
export interface ContextReport {
    budgetTokens: number;
    estimatedTokens: number;
    reservedOutputTokens: number;
    estimator: string;
    sources: ContextSource[];
    truncated: boolean;
}
export interface Evidence {
    id: string;
    projectId: string;
    runId: string;
    taskId?: string;
    kind: 'test' | 'review' | 'deployment' | 'tool';
    title: string;
    ok: boolean;
    output: string;
    createdAt: string;
    details?: Record<string, unknown>;
}
export interface TargetSummary {
    id: string;
    label: string;
    nodeId: string;
    kind: 'local' | 'ssh';
    commands: Array<{
        id: string;
        label: string;
    }>;
    deployments: Array<{
        id: string;
        label: string;
    }>;
}
export interface Bootstrap {
    version: string;
    user: User;
    projects: Project[];
    conversations: Conversation[];
    providers: Provider[];
    accounts: Account[];
    models: ModelRoute[];
    nodes: NodeConfig[];
    links: NetworkLink[];
    resourceGroups: ResourceGroup[];
    telemetry: Telemetry[];
    runs: Run[];
    approvals: Approval[];
    memories: Memory[];
    artifacts: Artifact[];
    evidence: Evidence[];
    targets: TargetSummary[];
    resourceUsage: Record<string, number>;
    routeAvailability?: import('./routing-types.ts').RouteAvailability[];
    providerLoads?: import('./load-types.ts').ProviderLoadObservation[];
    demo: boolean;
}
export interface ApiError {
    error: string;
    code: string;
}
