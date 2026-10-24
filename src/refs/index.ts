export {
  collectReferences,
  readEntityDeclarations,
  type ApplicReference,
  type CollectedReferences,
  type DmReference,
  type EntityDeclaration,
  type IcnReference,
  type InternalReference,
  type PmReference,
  type Reference,
  type ReferenceKind,
} from './collect.js';
export {
  resolveReferences,
  type ReferenceReport,
  type ResolveOptions,
  type ResolvedReference,
  type UnresolvedReason,
  type UnresolvedReference,
} from './resolve.js';
