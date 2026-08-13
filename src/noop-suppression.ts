import fs from 'fs';

import { PA_NOOP_MARKER } from './config.js';

/**
 * PA #pa flood suppression
 * (dev-4ipl3 / dev-vbyy3 / dev-1f82i / dev-64rwo / dev-v0qm6 / dev-g1q83r).
 *
 * The PA final-turn forward is DENY-BY-DEFAULT (dev-l8uyw3). Genuine decision
 * cards are posted via the Slack MCP DURING the cycle (decision-formatter /
 * conversations_add_message), never through a final-result forward — so for the
 * PA group every body arriving on this path is narration by construction, and
 * dropping it can never suppress a real decision card. The single exception is a
 * dead-session harness error (the "PA is down" pager), which PA could not have
 * posted itself; see shouldSuppressPaNoopForward for the full argument.
 *
 * History matters here, because this file is the third attempt. The gate began as
 * ALLOW-by-default with blocklists — a marker gate (dev-vbyy3), a content regex
 * (dev-1f82i), and a repeat-body cooldown (dev-v0qm6, made trigger-agnostic by
 * dev-g1q83r). Each widening covered only the phrasings already observed, and the
 * flood returned in new wording every time. The marker and content gates are kept
 * below as LOG FIELDS ONLY; do not restore them as forwarding logic.
 *
 * IMPORTANT: this gate must be applied on EVERY path that forwards PA's final
 * result to the channel — both the interactive `processGroupMessages` path
 * (index.ts) AND the scheduled escalated-sweep path (task-scheduler.ts). The
 * dev-1f82i fix only wired it into the interactive path, so the ~30min
 * escalated-sweep flood kept reaching #pa for 4 more days (dev-64rwo). Keep both
 * call sites gated.
 */

/**
 * OBSERVABILITY ONLY since dev-l8uyw3 — this no longer gates the forward, because
 * the forward is now deny-by-default and a real-work cycle (which never touches
 * the marker) must be dropped just the same. Both call sites still log it so an
 * operator reading a dropped record can tell a TRUE NO-OP from a real-work cycle.
 * Kept exported for that and for its tests; do not re-wire it into the decision.
 *
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
 * OBSERVABILITY ONLY since dev-l8uyw3 — this no longer gates the forward. It is
 * the regex whose three widenings never converged: the six phrasings measured in
 * the 2026-08-13 flood all passed it. Deny-by-default replaced it. Kept as a log
 * field (it still usefully labels a dropped body as heartbeat-shaped) and for its
 * tests. Do NOT add phrasings to it expecting them to suppress anything, and do
 * not re-wire it into the decision.
 *
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
 * dev-v0qm6 → generalised by dev-g1q83r: repeat-final-turn flood gate.
 *
 * The two NO-OP gates above only catch heartbeat *narration*. They miss the
 * other observed flood class: dead-session final-turns. When PA's `claude -p`
 * cannot do any work at all — credential expiry → 401, rate limit → 429,
 * Overloaded → 529/5xx, an unrefreshable OAuth session, an exhausted weekly
 * usage allowance — the harness's own error text becomes the final-turn body
 * and is forwarded to #pa once per escalated-sweep.
 *
 * WHY THIS GATE IS SIGNATURE-BASED AND NOT STRING-BASED (dev-g1q83r). dev-v0qm6
 * shipped a regex over the ONE trigger observed at the time ("API Error: 401 …")
 * and the flood recurred twice through the same sink with different text:
 *
 *   275 sessions  "Failed to authenticate: OAuth session expired and could not
 *                  be refreshed"                        (2026-07-24 → 07-28)
 *   121 sessions  "You've hit your weekly limit · resets Aug 5, 3am (UTC)"
 *                                                       (2026-07-31 → 08-05)
 *     4 sessions  "API Error: 529 Overloaded …"         (matched the old regex)
 *
 * (Counts measured over the Claude Code transcripts on disk; all agent_type=
 * pa-agent, all zero tool calls, all exiting within ~2s — the session never
 * reached the point of doing work. The 08-05 burst buried the ENTIRE live
 * decision queue, D0–D25 including 8 P1s, for 4+ days.)
 *
 * The lesson: the flood's defining property is REPETITION, not any particular
 * error string. So the cooldown arm is now trigger-agnostic — EVERY final-turn
 * body gets a signature, and a repeat of that signature inside the window is
 * dropped. Known failure classes get a coarse class key so spelling variants of
 * the same outage collapse to one post ("resets 3am (UTC)" and "resets Aug 5,
 * 3am (UTC)" are one usage-limit outage, not two); everything else falls back
 * to a normalised hash of the body itself, which needs no foreknowledge of the
 * next trigger. Adding a class is an optimisation, never a prerequisite.
 *
 * Suppressing the FLOOD is safe because real content never travels this path:
 * decision cards (decision-formatter) and briefings (briefing.ts) are posted by
 * PA via the Slack MCP send_message tool DURING the cycle — see module note. We
 * deliberately do NOT drop unconditionally: the FIRST occurrence of a signature
 * is operator-relevant signal ("PA is down on auth"). One signal, no flood.
 */

/**
 * Ordered failure-class table. First match wins, so more specific classes come
 * first: "Failed to authenticate. API Error: 401 …" keys on api-error-401, not
 * on the generic auth class, keeping the whole 401 burst on one key.
 */
const PA_FAILURE_CLASSES: ReadonlyArray<{ key: string; re: RegExp }> = [
  {
    key: 'api-error-401',
    re: /API Error:\s*401\b|Invalid authentication credentials/i,
  },
  { key: 'api-error-429', re: /API Error:\s*429\b/i },
  { key: 'api-error-5xx', re: /API Error:\s*5\d\d\b|\bOverloaded\b/i },
  {
    key: 'usage-limit',
    re: /\b(?:weekly|daily|hourly|monthly|5-hour|usage|rate) limit\b|\blimit\b[^.\n]{0,40}\bresets\b/i,
  },
  {
    key: 'auth-session',
    re: /OAuth\s+(?:session|token)\b|\bcould not be refreshed\b|\bFailed to authenticate\b|\bsession (?:expired|revoked)\b/i,
  },
  { key: 'credit-balance', re: /Credit balance is too low/i },
  {
    key: 'login-required',
    re: /Please run \/login|\/login to (?:re-?)?authenticate/i,
  },
];

/**
 * Return the coarse failure class for a body, or null when it matches no known
 * class. Null is NOT "safe to forward repeatedly" — see _paFloodSignature, which
 * falls back to a body hash so unknown triggers are still deduped.
 */
export function _paFailureClass(text: string): string | null {
  for (const { key, re } of PA_FAILURE_CLASSES) {
    if (re.test(text)) return key;
  }
  return null;
}

export function _isPaKnownFailure(text: string): boolean {
  return _paFailureClass(text) !== null;
}

/**
 * Normalise a body for hashing: case-folded, whitespace-collapsed, and with
 * digit runs replaced by '#' so embedded clocks, dates and counters do not split
 * one repeating message into many signatures.
 */
function _normalizeBody(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** djb2, base36 — short stable key, no crypto dependency needed. */
function _hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Signature for a final-turn body. Never null: a known failure class keys on
 * that class, anything else keys on a hash of the normalised body. That
 * fallback is what makes the gate trigger-agnostic — the NEXT unknown flood is
 * deduped without anyone having to add its string here first.
 */
export function _paFloodSignature(text: string): string {
  return _paFailureClass(text) ?? `body:${_hash(_normalizeBody(text))}`;
}

// Default cooldown: forward at most one post per signature per 6h.
export const PA_ERROR_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Cap on distinct signatures retained. Every forwarded body now creates a key
// (not just known errors), so the map is bounded and evicts oldest-first.
export const PA_FLOOD_STATE_MAX = 200;

// Module-level cooldown state, keyed by signature. Persists across cycles within
// the long-lived nanoclaw daemon process; a daemon restart resets it (which is
// fine — a restart is itself a new operator-relevant boundary).
const _paErrorLastForward = new Map<string, number>();

function _recordForward(
  state: Map<string, number>,
  sig: string,
  nowMs: number,
): void {
  state.set(sig, nowMs);
  // Map iteration is insertion-ordered, so the first key is the oldest insert.
  while (state.size > PA_FLOOD_STATE_MAX) {
    const oldest = state.keys().next();
    if (oldest.done) break;
    state.delete(oldest.value);
  }
}

/**
 * Returns true when this final-turn body should be SUPPRESSED because the same
 * signature was already forwarded within the cooldown window. The first
 * occurrence per window returns false (forward it) and records `nowMs`. `state`
 * is injectable for testing; production callers use the module-level map.
 */
export function _paRepeatWithinCooldown(
  text: string,
  nowMs: number,
  cooldownMs = PA_ERROR_COOLDOWN_MS,
  state: Map<string, number> = _paErrorLastForward,
): boolean {
  const sig = _paFloodSignature(text);
  const last = state.get(sig);
  if (last !== undefined && nowMs - last < cooldownMs) {
    return true; // repeat within cooldown → suppress
  }
  _recordForward(state, sig, nowMs); // first in window → record and forward
  return false;
}

/**
 * Combined gate: true when PA's final-turn summary for THIS cycle should be
 * dropped rather than forwarded to the channel. Apply only for the PA main
 * group (isMain). cycleStartMs doubles as "now" for the outage cooldown.
 *
 * DENY-BY-DEFAULT (dev-l8uyw3). This gate used to be ALLOW-by-default: forward
 * unless some blocklist matched. Three widenings later it still leaked, because
 * the leaking class is not a phrasing — it is a POLARITY error. A PA cycle that
 * does real agent-facing work (bead comment, Agent Mail reply, memory write) and
 * correctly declines to post to Slack must NOT touch PA_NOOP_MARKER (so the
 * marker gate misses) and phrases its summary in bespoke prose (so the content
 * regex misses). Measured 2026-08-13T02:03Z in #pa: SIX consecutive such posts
 * stacked on the last real decision content, in six distinct phrasings no regex
 * anticipated. Two of them said "no post made, deliberately" in their first line
 * and were forwarded anyway.
 *
 * The invariant that settles it: genuine human-facing content — decision cards
 * (decision-formatter) and briefings (briefing.ts) — is posted by PA via the
 * Slack MCP DURING the cycle, never through a final-result forward. So for the
 * PA group every body that travels THIS path is, by construction, narration. The
 * clinching observation: the genuine D60 card landed 03:11:02Z via Slack MCP and
 * was buried three minutes later by its own final-turn echo at 03:14:10Z ("D60
 * surfaced to Root … Clean exit."). Enumerating narration phrasings is unbounded;
 * denying the path is not.
 *
 * THE ONE EXCEPTION — and why it is not "just another allow-by-default hole".
 * When PA's `claude -p` dies before it can make any tool call (credential expiry
 * → 401, usage wall, unrefreshable OAuth session, 5xx), the harness's own error
 * text becomes the final-turn body. That is the ONLY class of body PA could not
 * possibly have posted itself, so this forward is the only channel by which "PA
 * is down" reaches Slack at all. Suppressing it unconditionally would convert a
 * surface-burn bug into a silent pager blackout — strictly worse, and invisible.
 * dev-v0qm6 / dev-g1q83r built that signal deliberately ("one signal, no flood")
 * and dev-l8uyw3 names only the marker gate and the content regex as the logic to
 * drop. So a RECOGNISED failure class is still forwarded, still at most once per
 * cooldown window. Everything else is dropped, no matter how it is phrased.
 *
 * Residual, accepted knowingly: a narration body that happens to contain outage
 * vocabulary ("weekly limit", "session expired") is classed as a failure and
 * leaks one post per 6h per class. That is bounded and self-healing, whereas any
 * length/position test tight enough to close it could also silence a real outage
 * whose error text is long or prefixed. Given the asymmetry — bounded surface
 * burn vs. a silent pager — this errs open. Close it only on measured evidence,
 * never on speculation; pre-emptive widening is what produced this bug.
 *
 * _paNoopMarkedSince and _isPaNoopNarration are RETAINED but are no longer
 * load-bearing: both call sites log them as observability fields so an operator
 * can still tell a true NO-OP from a real-work cycle in the dropped record.
 * _paFloodSignature likewise stays load-bearing FOR LOGGING (its body-hash
 * fallback names dropped narration in the logs) even though the forward decision
 * below only ever keys on a known class. Neither is dead code.
 */
export function shouldSuppressPaNoopForward(
  isMain: boolean,
  text: string,
  cycleStartMs: number,
  // Injectable for tests only (mirrors _paRepeatWithinCooldown). Production
  // callers omit it and share the module-level cooldown map. Before dev-l8uyw3
  // this composed gate had NO tests at all — only its components did — which is
  // how an inverted polarity survived three fixes. Keep it injectable so the
  // thing actually wired into both call sites stays the thing under test.
  state?: Map<string, number>,
): boolean {
  if (!isMain) return false;
  // Deny-by-default: no recognised failure class → narration → drop, whatever
  // the marker says and however the body is worded.
  if (_paFailureClass(text) === null) return true;
  // Recognised outage: this is the dead-session pager. Forward the first body of
  // the class, drop the repeats inside the window.
  return _paRepeatWithinCooldown(
    text,
    cycleStartMs,
    PA_ERROR_COOLDOWN_MS,
    state,
  );
}
