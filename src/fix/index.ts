export {
  confidenceOf,
  type Fix,
  type FixAction,
  type FixCandidate,
  type FixConfidence,
  type FixKind,
} from './types.js';
export { editDistance, nearMatches, type NearMatch } from './similar.js';
export { XsdIndex, loadXsdIndex, type ValueConstraint } from './xsd-index.js';
export { suggestSchemaFixes, type SchemaFixOptions } from './schema.js';
export { suggestBrexFixes, type BrexFixOptions } from './brex.js';
export { suggestReferenceFixes, type ReferenceFixOptions } from './refs.js';
export {
  findUndeterminedApplicability,
  suggestApplicabilityFixes,
  type ApplicFinding,
  type ApplicFixOptions,
  type FindApplicOptions,
} from './applic.js';
export { suggestFixes, type SuggestFixesOptions } from './suggest.js';
