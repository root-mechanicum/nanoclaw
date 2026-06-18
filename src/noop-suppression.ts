import fs from 'fs';

import { PA_NOOP_MARKER } from './config.js';

/**
 * PA NO-OP flood suppression (dev-4ipl3 / dev-vbyy3 / dev-1f82i / dev-64rwo).
 *
 * Two independent, OR'd gates decide whether PA's final-turn summary text should
 * be dropped instead of forwarded to #pa. Genuine decision cards are posted via
 * the Slack MCP DURING the cycle (decision-formatter / conversations_add_message),
 * never through a final-result forward — so dropping a final-turn summary can
 * never suppress a real decision card. That asymmetry is what makes both gates
 * safe to apply on every PA final-turn forward.
 *
 * IMPORTANT: this gate must be applied on EVERY path that forwards PA's final
 * result to the channel — both the interactive `processGroupMessages` path
 * (index.ts) AND the scheduled escalated-sweep path (task-scheduler.ts). The
 * dev-1f82i fix only wired it into the interactive path, so the ~30min
 * escalated-sweep flood kept reaching #pa for 4 more days (dev-64rwo). Keep both
 * call sites gated.
 */

/**
 * dev-vbyy3: report whether the PA NO-OP marker was touched at or after the
 * given cycle-start time. PA's exit protocol touches PA_NOOP_MARKER right
 * before exit ONLY on a TRUE NO-OP cycle (nothing changed, no decision posted).
 * When that happens we must NOT forward PA's final `claude -p` summary text to
 * the channel — the marker is the contract that the cycle changed nothing, so
 * the summary is pure surface-burn that buries real decision cards.
 *
 * We read the marker's mtime rather than deleting it: dispatch also reads the
 * marker to suppress redundant re-wakes, so consuming it would break that.
 * Comparing mtime >= cycleStartMs scopes the signal to THIS cycle — a marker
 * left stale by a prior NO-OP (or a real-work cycle that never touches it) has
 * an older mtime and does not suppress the current forward.
 */
export function _paNoopMarkedSince(sinceMs: number, markerPath = PA_NOOP_MARKER): boolean {
  try {
    return fs.statSync(markerPath).mtimeMs >= sinceMs;
  } catch {
    return false; // no marker (or unreadable) → not a TRUE NO-OP
  }
}

/**
 * dev-1f82i + dev-64rwo: content-based fallback gate for the PA NO-OP flood
 * (P1 dev-4ipl3).
 *
 * The marker-based gate (_paNoopMarkedSince) only fires when PA touches
 * PA_NOOP_MARKER during the cycle. In practice PA's final-turn summary kept
 * reaching #pa anyway (each body literally saying "exited silently / zero Slack
 * posts") — the wake comes via the scheduled escalated-sweep task and/or PA
 * never touches the marker, so the marker gate misses. This is a SECOND,
 * mechanism-independent gate: if the final-turn summary text reads like NO-OP
 * heartbeat narration, drop it regardless of the marker.
 *
 * The pattern set is intentionally broad: it must catch terse variants observed
 * in the live flood ("No-op.", "No decision gates to process exiting silently.",
 * "No actionable work this cycle.") in addition to the verbose "TRUE NO-OP …
 * Escalated sweep complete" bodies. Broadening is safe because genuine decision
 * bundles never travel this forward path (see module note) and never contain
 * these phrases.
 */
const PA_NOOP_NARRATION_RE =
  /\bno-?op\b|Escalated sweep complete|Cycle complete|exit(?:ed|ing) silent|silent exit|No decision gates|No actionable|nothing to (?:surface|process)/i;

export function _isPaNoopNarration(text: string): boolean {
  return PA_NOOP_NARRATION_RE.test(text);
}

/**
 * Combined gate: true when PA's final-turn summary for THIS cycle should be
 * dropped rather than forwarded to the channel. Apply only for the PA main
 * group (isMain). cycleStartMs scopes the marker check to the current cycle.
 */
export function shouldSuppressPaNoopForward(
  isMain: boolean,
  text: string,
  cycleStartMs: number,
): boolean {
  return isMain && (_paNoopMarkedSince(cycleStartMs) || _isPaNoopNarration(text));
}
