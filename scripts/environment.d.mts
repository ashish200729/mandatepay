export const repositoryRoot: string;
export const DATABASE_ENV_KEYS: string[];
export const WEB_ENV_KEYS: string[];
export const ADMIN_ENV_KEYS: string[];
export const API_ENV_KEYS: string[];
interface EnvironmentOptions {
  workspaceDirectory?: string;
  rootDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  mode?: string;
  keys?: readonly string[];
}
export function readWorkspaceEnvironment(options?: EnvironmentOptions): Record<string, string>;
export function loadWorkspaceEnvironment(options?: EnvironmentOptions): Record<string, string>;
