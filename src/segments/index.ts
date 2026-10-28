export { extractSegments } from './extract.js';
export { applySegments } from './apply.js';
export { SegmentsError, SkeletonMismatchError, type SegmentsErrorCode } from './errors.js';
export {
  SEGMENT_CATEGORIES,
  type ApplyOptions,
  type ApplyResult,
  type ExtractOptions,
  type ExtractResult,
  type Segment,
  type SegmentCategory,
  type SegmentCounts,
  type SegmentPlaceholder,
  type UnappliedReason,
  type UnappliedSegment,
} from './types.js';
