/**
 * Single contract for "empty upstream output" detection.
 *
 * EMPTY_OUTPUT means exclusively:
 * - zero useful assistant content,
 * - zero useful reasoning,
 * - zero valid tool calls,
 * - upstream finished,
 * - no more-specific upstream error pending (that error must win).
 *
 * Precedence (mandatory):
 *   1. explicit/specific upstream error
 *   2. valid tool call
 *   3. valid reasoning/content
 *   4. empty-upstream guard
 *
 * The guard must never mask: quota_limit, internal_error, invalid_input,
 * explicit timeouts, RateLimited, CAPTCHA, or any already-classified error.
 */

/** Stable machine-readable code for the empty-upstream signal. */
export const EMPTY_UPSTREAM_CODE = 'empty_upstream_response';

/** Upper bound for "extremely short content" in short_then_error classification. */
export const SHORT_CONTENT_MAX = 16;

export function isBlankText(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

export interface EmptyOutputInput {
  content: unknown;
  reasoning: unknown;
  toolCallCount: number;
}

/**
 * True only when there is no usable content, reasoning, or tool call.
 * Callers must check upstream-error precedence BEFORE invoking this.
 */
export function isEmptyOutput(input: EmptyOutputInput): boolean {
  if (input.toolCallCount > 0) return false;
  if (!isBlankText(input.reasoning)) return false;
  if (!isBlankText(input.content)) return false;
  return true;
}

/**
 * True when the final assistant text is exactly "yes"
 * (case-insensitive, surrounding whitespace ignored).
 */
export function isYesOnly(text: unknown): boolean {
  return typeof text === 'string' && text.trim().toLowerCase() === 'yes';
}

/**
 * True for extremely short (but non-empty) content worth correlating
 * with a post-content upstream error.
 */
export function isShortContent(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const len = text.trim().length;
  return len > 0 && len <= SHORT_CONTENT_MAX;
}
