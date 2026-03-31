/**
 * Bootstrap module — Cold-start orchestration for new organizations.
 *
 * Provides the BootstrapOrchestrator that wires together the codebase
 * scanner, PM adapter, and mapping engine to generate initial terminology
 * mappings for a new organization.
 */

export {
  BootstrapOrchestrator,
  type BootstrapOptions,
  type BootstrapSummary,
  type BootstrapTermPreview,
} from "./bootstrap-orchestrator.js";
