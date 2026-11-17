import type { Account, ModelRoute, Provider, ProviderKind } from './contracts.ts';

export type ConnectionPresetId = 'codex' | 'antigravity' | 'openai' | 'gemini' | 'ollama' | 'lmstudio' | 'gemrouter' | 'custom';
export interface ConnectionPreset {
  id: ConnectionPresetId;
  label: string;
  kind: ProviderKind;
  authentication: 'device-login' | 'runtime-login' | 'api-key' | 'optional-key';
  defaultUrl?: string;
  docsUrl?: string;
  description: string;
}
export type PublicConnectionProvider = Omit<Provider, 'command' | 'args' | 'env'>;
export interface ConnectionOptions {
  presets: ConnectionPreset[];
  configured: Array<{
    provider: PublicConnectionProvider;
    accounts: Account[];
    modelCount: number;
  }>;
  detectionScope: string;
}
export interface ConnectionInput {
  preset?: ConnectionPresetId | 'openai-compatible' | 'openai-responses';
  providerId?: string;
  accountId?: string;
  label?: string;
  accountLabel?: string;
  baseUrl?: string;
  secret?: string;
  shared?: boolean;
  requestId?: string;
  nodeIds?: string[];
  resourceGroupIds?: string[];
  /** Explicit operator declarations for endpoints without model discovery. */
  modelIds?: string[];
}
export type ConnectionStatus = 'ready' | 'standby' | 'login-required' | 'setup-required' | 'unverified' | 'unavailable';
export interface ConnectionResult {
  provider: PublicConnectionProvider;
  account: Account;
  models: ModelRoute[];
  status: ConnectionStatus;
  message: string;
  warnings: string[];
  reused: { provider: boolean; account: boolean };
  nextAction?: {
    kind: 'login' | 'retry' | 'configure-runtime';
    label: string;
    accountId?: string;
    command?: string;
    docsUrl?: string;
  };
}
export interface ConnectionDetection {
  candidates: Array<{
    preset: ConnectionPresetId;
    label: string;
    baseUrl: string;
    providerId?: string;
    modelCount: number;
    status: 'available' | 'standby' | 'unavailable';
    message: string;
  }>;
  scope: string;
}
