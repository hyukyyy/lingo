// SCM Adapter interface & shared types
export type {
  SCMAdapter,
  SCMConnectionStatus,
  SCMAdapterConfig,
  SCMAdapterErrorCode,
  PullRequestRef,
  PRInfo,
  PRFileChange,
} from "./types.js";

export { SCMAdapterError } from "./types.js";

// SCM Adapter registry & factory types
export {
  SCMAdapterRegistry,
  SCMAdapterRegistryError,
  type SCMAdapterFactory,
  type SCMAdapterFactoryRegistration,
  type SCMAdapterInfo,
  type SCMAdapterRegistryErrorCode,
} from "./registry.js";

// GitHub SCM adapter
export {
  GitHubSCMAdapter,
  createGitHubSCMAdapter,
  type GitHubSCMAdapterConfig,
} from "./github-scm-adapter.js";

// GitHub SCM adapter factory registration
export { githubSCMFactoryRegistration } from "./factory.js";

// Built-in SCM adapter discovery
export {
  registerBuiltinSCMAdapters,
  getBuiltinSCMAdapterNames,
  BUILTIN_SCM_ADAPTER_FACTORIES,
} from "./builtin-scm-adapters.js";
