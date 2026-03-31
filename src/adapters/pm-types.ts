/**
 * PM Domain Data Models — Re-export barrel
 *
 * Re-exports the PM domain types from the canonical `types.ts` module.
 * This file exists so that modules importing from `pm-types.js` continue
 * to work. All types are defined in `types.ts`.
 */

export type {
  ExternalId,
  PMProject,
  PMItem,
  PMItemKind,
  PMItemType,
  PMItemStatus,
  PMStatusCategory,
  PMFieldValue,
  PMItemFilterOptions,
  PMTermCandidate,
  PMTermExtractionOptions,
  PMAdapterConfig,
  PMAdapterErrorCode,
  PaginationOptions,
  PaginatedResult,
  NormalizedTerm,
  ConnectionStatus,
} from "./types.js";

export { PMAdapterError } from "./types.js";
