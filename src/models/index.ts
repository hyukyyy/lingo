export {
  type CodeLocation,
  type CodeRelationship,
  type ConfidenceLevel,
  type TermSource,
  type GlossaryTerm,
  type GlossaryStore,
  GLOSSARY_SCHEMA_VERSION,
  createEmptyStore,
  createTerm,
} from "./glossary.js";

export {
  // Enums / Zod schemas
  PmItemTypeSchema,
  PmStatusSchema,
  PmPrioritySchema,
  PmItemSourceSchema,
  PersonRefSchema,
  PmItemRefSchema,
  PmItemSchema,
  CreatePmItemInputSchema,
  PmItemCollectionSchema,

  // TypeScript types
  type PmItemType,
  type PmStatus,
  type PmPriority,
  type PmItemSource,
  type PersonRef,
  type PmItemRef,
  type PmItem,
  type CreatePmItemInput,
  type PmItemCollection,

  // Adapter mapping types
  type ItemTypeMapping,
  type StatusMapping,
  type PriorityMapping,
  type AdapterMappingConfig,

  // Constants (enum value arrays)
  PM_ITEM_TYPES,
  PM_STATUSES,
  PM_PRIORITIES,

  // Factory & utilities
  createPmItem,
  isPmItemType,
  isPmStatus,
  isPmPriority,
  validatePmItem,
} from "./pm-items.js";
