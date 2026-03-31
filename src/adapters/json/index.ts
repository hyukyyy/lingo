export {
  JsonAdapter,
  resetItemCounter,
  type JsonAdapterConfig,
  type JsonPMData,
  type JsonProject,
  type JsonItem,
} from "./json-adapter.js";

// Factory for registry-based creation
export {
  createJsonAdapter,
  jsonFactoryRegistration,
} from "./factory.js";
