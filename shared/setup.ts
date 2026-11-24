import type { Backend } from './types';

export type SetupAction = 'install' | 'login' | 'native';
export interface AgentSetupInfo {
  id: Backend;
  executable: string | null;
  configPath: string;
  /** Path of the native credential file, when the backend separates it from config. */
  credentialPath?: string;
  credentialPresent: boolean;
  baseUrl: string;
  model: string;
  installCommand: string;
  loginCommand: string;
  nativeCommand: string;
  docsUrl: string;
  note: string;
  error?: string;
}
export interface AgentConfigInput { apiKey?: string; baseUrl?: string; model?: string }
export interface StartupStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  wsl: boolean;
  linger: boolean;
  unitPath: string;
  conflict: boolean;
  /** Auto-start still runs through the pre-rename sessiondeck.service. */
  legacy: boolean;
  note: string;
}
