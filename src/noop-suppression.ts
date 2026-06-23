import fs from 'fs';

import { PA_NOOP_MARKER } from './config.js';

/**
 * PA #pa flood suppression (dev-4ipl3 / dev-vbyy3 / dev-1f82i / dev-64rwo / dev-v0qm6).
 *
 * Independent, OR'd gates decide whether PA's final-turn summary text should be
 * dropped instead of forwarded to #pa: two NO-OP-narration gates (marker +
 * content) and a transient-error cooldown gate (dev-v0qm6). Genuine decision
 * cards are posted via
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
export function _paNoopMarkedSince(
  sinceMs: number,
  markerPath = PA_NOOP_MARKER,
): boolean {
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
 * dev-v0qm6: transient-error final-turn flood gate.
 *
 * The two NO-OP gates above only catch heartbeat *narration*. They miss the
 * other observed flood class: genuine ERROR final-turns. When PA's `claude -p`
 * dies on a transient API failure (credential expiry → 401, rate limit → 429,
 * Overloaded → 529/5xx), the raw error text becomes the final-turn body and is
 * forwarded to #pa once per escalated-sweep. Observed 2026-06-20→21: ~50
 * identical "API Error: 401 Invalid authentication credentials" posts at ~31min
 * cadence, re-burying real decision bundles — the same harm dev-4ipl3
 * documented, different trigger.
 *
 * These are not NO-OP narration, so the content-regex gate does not match them.
 * They also carry no decision value (real decision cards travel via the Slack
 * MCP DURING the cycle, never this forward — see module note), so suppressing
 * the FLOOD is safe. We deliberately do NOT drop the error unconditionally: the
 * FIRST occurrence of a given failure class is operator-relevant signal ("PA is
 * down on auth"). So we forward the first, then suppress repeats of the same
 * signature within a cooldown window. One signal, no flood.
 */
const PA_TRANSIENT_ERROR_RE =
  /API Error:\s*(?:401|429|529|5\d\d)\b|Invalid authentication credentials|\bOverloaded\b/i;

export function _isPaTransientError(text: string): boolean {
  return PA_TRANSIENT_ERROR_RE.test(text);
}

/**
 * Reduce a transient-error body to a coarse signature so repeats of the same
 * failure class collapse to one key (e.g. every "API Error: 401 …" burst shares
 * the signature "api error: 401"). Returns null when the body is not a
 * transient error. The match starts at the earliest position, so a
 * "Failed to authenticate. API Error: 401 Invalid authentication credentials"
 * body keys on "api error: 401", not the trailing credentials phrase.
 */
export function _paTransientErrorSignature(text: string): string | null {
  const m = text.match(PA_TRANSIENT_ERROR_RE);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
}

// Default cooldown: forward at most one post per failure signature per 6h.
export const PA_ERROR_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Module-level cooldown state, keyed by failure signature. Persists across
// cycles within the long-lived nanoclaw daemon process; a daemon restart resets
// it (which is fine — a restart is itself a new operator-relevant boundary).
const _paErrorLastForward = new Map<string, number>();

/**
 * Returns true when this transient-error body should be SUPPRESSED because the
 * same signature was already forwarded within the cooldown window. The first
 * occurrence per window returns false (forward it) and records `nowMs`. Bodies
 * that are not transient errors always return false. `state` is injectable for
 * testing; production callers use the module-level map.
 */
export function _paErrorWithinCooldown(
  text: string,
  nowMs: number,
  cooldownMs = PA_ERROR_COOLDOWN_MS,
  state: Map<string, number> = _paErrorLastForward,
): boolean {
  const sig = _paTransientErrorSignature(text);
  if (sig === null) return false;
  const last = state.get(sig);
  if (last !== undefined && nowMs - last < cooldownMs) {
    return true; // repeat within cooldown → suppress
  }
  state.set(sig, nowMs); // first in window → record and forward
  return false;
}

/**
 * Combined gate: true when PA's final-turn summary for THIS cycle should be
 * dropped rather than forwarded to the channel. Apply only for the PA main
 * group (isMain). cycleStartMs scopes the marker check to the current cycle and
 * doubles as "now" for the transient-error cooldown.
 */
export function shouldSuppressPaNoopForward(
  isMain: boolean,
  text: string,
  cycleStartMs: number,
): boolean {
  if (!isMain) return false;
  if (_paNoopMarkedSince(cycleStartMs) || _isPaNoopNarration(text)) return true;
  // dev-v0qm6: forward the first transient error of each class, drop the flood.
  return _paErrorWithinCooldown(text, cycleStartMs);
}
