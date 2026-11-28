import { guard } from "./common";
import { sanitizeSvgPure, type SanitizedSvgResult } from "./svg-sanitizer-pure";

export type { SanitizedSvgResult };

/**
 * Server-side wrapper around the single authoritative SVG sanitizer (`svg-sanitizer-pure.ts`).
 * Rejects unsafe SVGs with structured 422 UNSAFE_SVG_CONTENT Problem errors.
 */
export function validateAndSanitizeSvg(rawInput: string): SanitizedSvgResult {
  const outcome = sanitizeSvgPure(rawInput);
  guard(outcome.ok, "UNSAFE_SVG_CONTENT", outcome.ok ? "" : outcome.message, 422);
  return outcome.value;
}
