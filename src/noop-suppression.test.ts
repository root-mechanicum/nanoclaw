import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _paNoopMarkedSince,
  _isPaNoopNarration,
  _isPaKnownFailure,
  _paFailureClass,
  _paFloodSignature,
  _paRepeatWithinCooldown,
  PA_ERROR_COOLDOWN_MS,
  PA_FLOOD_STATE_MAX,
} from './noop-suppression.js';

// dev-vbyy3: the runtime suppresses forwarding PA's final summary to #pa when
// the NO-OP marker was touched DURING the current cycle. These tests pin the
// mtime-vs-cycle-start comparison that gates that suppression.

let markerPath: string;

beforeEach(() => {
  markerPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'noop-test-')),
    'dispatch-noop-pa-agent',
  );
});

afterEach(() => {
  try {
    fs.rmSync(path.dirname(markerPath), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('_paNoopMarkedSince', () => {
  it('returns false when the marker does not exist (real-work cycle)', () => {
    const cycleStart = Date.now();
    expect(_paNoopMarkedSince(cycleStart, markerPath)).toBe(false);
  });

  it('returns true when the marker was touched after cycle start (TRUE NO-OP)', () => {
    const cycleStart = Date.now();
    // Simulate PA touching the marker near the end of the cycle.
    fs.writeFileSync(markerPath, '');
    const future = new Date(cycleStart + 5_000);
    fs.utimesSync(markerPath, future, future);
    expect(_paNoopMarkedSince(cycleStart, markerPath)).toBe(true);
  });

  it('returns false when the marker is stale from a prior cycle', () => {
    // Marker left over from an earlier NO-OP exit, mtime well before this cycle.
    fs.writeFileSync(markerPath, '');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(markerPath, past, past);
    const cycleStart = Date.now();
    expect(_paNoopMarkedSince(cycleStart, markerPath)).toBe(false);
  });

  it('uses an inclusive (>=) comparison against the stored mtime', () => {
    // Compare against the mtime the filesystem actually stored (avoids
    // Date->FS rounding flakiness). sinceMs == mtimeMs must count as marked;
    // one ms later must not — confirms the safe bias (forward when uncertain).
    fs.writeFileSync(markerPath, '');
    const storedMtimeMs = fs.statSync(markerPath).mtimeMs;
    expect(_paNoopMarkedSince(storedMtimeMs, markerPath)).toBe(true);
    expect(_paNoopMarkedSince(storedMtimeMs + 1, markerPath)).toBe(false);
  });
});

// dev-1f82i: content-based fallback gate. Drops PA's final-turn summary when it
// reads like NO-OP heartbeat narration, even if PA never touched the marker
// (the observed failure mode that kept flooding #pa).
describe('_isPaNoopNarration', () => {
  // Real flood-post bodies observed on #pa (2026-06-14, dev-4ipl3) must match.
  const floodBodies = [
    'Escalated sweep complete. TRUE NO-OP — exited silently, zero Slack posts.',
    'PA Cycle complete. Nothing to surface.',
    'TRUE NO-OP cycle: all gate KVs unchanged, silent exit.',
    'Exited silently — no decisions to surface this cycle.',
    'NO-OP cycle, nothing changed.',
    'NOOP cycle — silent exit.',
    // dev-64rwo: terser variants observed in the LIVE flood (2026-06-17/18)
    // that travelled the ungated scheduled-task path. These must also match.
    'No-op.',
    'No decision gates to process exiting silently.',
    'No decision gates to process. Exiting silently per protocol.',
    'No actionable work this cycle.',
    'No decision gates to process TRUE NO-OP. Exiting silently per protocol.',
    'No actionable decision gates this cycle. TRUE NO-OP markers touched, exiting silent.',
  ];
  for (const body of floodBodies) {
    it(`flags NO-OP narration: ${body.slice(0, 40)}…`, () => {
      expect(_isPaNoopNarration(body)).toBe(true);
    });
  }

  // Genuine, human-relevant posts must pass through (NOT match).
  const realBodies = [
    'DECISIONS NEEDED — 3 items: D1 scn-47, D2 scn-09, D3 metabolism auth.',
    'Morning briefing: 4 beads closed overnight, staging green, 1 blocker.',
    'Blocker surfaced: dev-p1vwd awaiting human gate on metabolism auth.',
    'Deploy to prod succeeded — app.gluon.me/health is green.',
  ];
  for (const body of realBodies) {
    it(`passes through genuine post: ${body.slice(0, 40)}…`, () => {
      expect(_isPaNoopNarration(body)).toBe(false);
    });
  }
});

// dev-v0qm6: error final-turn flood gate. Real error final-turns (credential
// expiry → 401, rate limit → 429, Overloaded → 529/5xx) flooded #pa one post per
// ~31min escalated-sweep; they are not NO-OP narration so the content gate
// missed them.
//
// dev-g1q83r: the REAL pre-fix flood corpus. Every string below is verbatim
// from a Claude Code transcript on this box (agent_type=pa-agent, zero tool
// calls, session dead in <2s), with the measured occurrence count. dev-v0qm6's
// regex matched only the last row — the other 396 sessions flooded #pa
// unsuppressed for two multi-day incidents. Any change to the gate must keep
// replaying this corpus.
const FLOOD_CORPUS = [
  {
    // 2026-07-24 → 07-28, 275 sessions. Emitted by Claude Code itself when
    // pre-spawn credential resolution fails — no PA code contains this string.
    body: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    count: 275,
    cls: 'auth-session',
  },
  {
    // 2026-07-31 → 08-05, 112 sessions. Buried decision queue D0–D25 (8 P1s).
    body: "You've hit your weekly limit · resets Aug 5, 3am (UTC)",
    count: 112,
    cls: 'usage-limit',
  },
  {
    // Same outage, 9 sessions, different spelling of the reset time. Must share
    // the signature above or the outage costs two posts instead of one.
    body: "You've hit your weekly limit · resets 3am (UTC)",
    count: 9,
    cls: 'usage-limit',
  },
  {
    // The only class dev-v0qm6 already caught, 4 sessions.
    body: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
    count: 4,
    cls: 'api-error-5xx',
  },
] as const;

describe('_isPaKnownFailure / _paFailureClass', () => {
  for (const { body, cls } of FLOOD_CORPUS) {
    it(`classifies live flood body as ${cls}: ${body.slice(0, 36)}…`, () => {
      expect(_paFailureClass(body)).toBe(cls);
      expect(_isPaKnownFailure(body)).toBe(true);
    });
  }

  // Classes carried over from dev-v0qm6.
  const errorBodies: Array<[string, string]> = [
    [
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      'api-error-401',
    ],
    ['API Error: 429 rate_limit_error', 'api-error-429'],
    ['Request failed: Overloaded', 'api-error-5xx'],
    ['API Error: 500 internal server error', 'api-error-5xx'],
    ['API Error: 503 service unavailable', 'api-error-5xx'],
    ['Credit balance is too low to continue.', 'credit-balance'],
    ['Please run /login to continue.', 'login-required'],
  ];
  for (const [body, cls] of errorBodies) {
    it(`classifies ${cls}: ${body.slice(0, 36)}…`, () => {
      expect(_paFailureClass(body)).toBe(cls);
    });
  }

  // Genuine posts must not be CLASSIFIED as failures. (They are still deduped
  // by body hash if repeated — see _paRepeatWithinCooldown — but classification
  // is what decides whether variants collapse together, so keep it clean.)
  const passBodies = [
    'DECISIONS NEEDED — 3 items: D1 scn-47, D2 scn-09, D3 metabolism auth.',
    'Deploy to prod succeeded — app.gluon.me/health is green.',
    'API Error: 400 bad request', // client error, not transient
    'Blocker surfaced: dev-p1vwd awaiting human gate.',
    'Rate limiting shipped on the signup endpoint.', // 'rate limit' only as prose
  ];
  for (const body of passBodies) {
    it(`does not classify genuine post: ${body.slice(0, 40)}…`, () => {
      expect(_paFailureClass(body)).toBeNull();
    });
  }
});

describe('_paFloodSignature', () => {
  it('keys a 401 burst on the API-error class, not the auth class', () => {
    // Ordering matters: the 401 rule is checked before the generic auth rule so
    // 'Failed to authenticate. API Error: 401 …' stays on the 401 key.
    expect(
      _paFloodSignature(
        'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      ),
    ).toBe('api-error-401');
    expect(
      _paFloodSignature('API Error: 401 Invalid authentication credentials'),
    ).toBe('api-error-401');
  });

  it('collapses both spellings of the weekly-limit outage to one key', () => {
    expect(_paFloodSignature(FLOOD_CORPUS[1].body)).toBe(
      _paFloodSignature(FLOOD_CORPUS[2].body),
    );
  });

  it('never returns null — unknown bodies fall back to a body hash', () => {
    // THE point of dev-g1q83r: a trigger nobody has seen yet is still deduped.
    const sig = _paFloodSignature(
      'Some brand new harness failure nobody wrote a regex for',
    );
    expect(sig).toMatch(/^body:/);
  });

  it('ignores embedded clocks/counters when hashing an unknown body', () => {
    expect(_paFloodSignature('Unrecognised stall at 03:14, attempt 7')).toBe(
      _paFloodSignature('Unrecognised stall at 22:57, attempt 41'),
    );
  });

  it('gives genuinely different bodies different keys', () => {
    expect(_paFloodSignature('Morning briefing: staging green.')).not.toBe(
      _paFloodSignature('Evening briefing: one blocker open.'),
    );
  });
});

describe('_paRepeatWithinCooldown', () => {
  it('forwards the first error of a class, then suppresses repeats in-window', () => {
    const state = new Map<string, number>();
    const body = 'API Error: 401 Invalid authentication credentials';
    const t0 = 1_000_000;
    // First occurrence → forward (not suppressed), records the timestamp.
    expect(_paRepeatWithinCooldown(body, t0, PA_ERROR_COOLDOWN_MS, state)).toBe(
      false,
    );
    // Repeat ~31min later (one escalated-sweep) → suppress the flood.
    expect(
      _paRepeatWithinCooldown(
        body,
        t0 + 31 * 60 * 1000,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(true);
  });

  it('forwards again once the cooldown window elapses', () => {
    const state = new Map<string, number>();
    const body = 'API Error: 529 Overloaded';
    const t0 = 2_000_000;
    expect(_paRepeatWithinCooldown(body, t0, PA_ERROR_COOLDOWN_MS, state)).toBe(
      false,
    );
    expect(
      _paRepeatWithinCooldown(
        body,
        t0 + PA_ERROR_COOLDOWN_MS + 1,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
  });

  it('tracks distinct failure classes independently', () => {
    const state = new Map<string, number>();
    const t0 = 3_000_000;
    // A 401 forwards; a 529 in the same window is a different class → also forwards.
    expect(
      _paRepeatWithinCooldown(
        'API Error: 401 x',
        t0,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
    expect(
      _paRepeatWithinCooldown(
        'API Error: 529 Overloaded',
        t0,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
    // But a second 401 in-window is suppressed.
    expect(
      _paRepeatWithinCooldown(
        'API Error: 401 y',
        t0 + 1000,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(true);
  });

  // POLICY CHANGE (dev-g1q83r) — this test previously asserted the OPPOSITE
  // ("never suppresses a non-transient body"). That narrow policy is exactly
  // what let two unrecognised floods through, so it is inverted deliberately.
  // It is safe because this forward path carries only PA's final-turn
  // narration: decision cards and briefings are posted by PA via the Slack MCP
  // send_message tool DURING the cycle (see the module note and briefing.ts),
  // never through this forward. A byte-identical repeat inside 6h therefore has
  // no marginal value to a human even if it is not a recognised error.
  it('dedupes an UNRECOGNISED repeated body too (first forwards, repeat drops)', () => {
    const state = new Map<string, number>();
    const t0 = 4_000_000;
    const body = 'Harness died in a way no regex here has seen.';
    expect(_paRepeatWithinCooldown(body, t0, PA_ERROR_COOLDOWN_MS, state)).toBe(
      false,
    );
    expect(
      _paRepeatWithinCooldown(body, t0 + 1000, PA_ERROR_COOLDOWN_MS, state),
    ).toBe(true);
  });

  it('bounds its state map so the long-lived daemon cannot leak keys', () => {
    const state = new Map<string, number>();
    for (let i = 0; i < PA_FLOOD_STATE_MAX + 50; i++) {
      // Letters, not digits — digits normalise to '#' and would collide.
      _paRepeatWithinCooldown(
        `distinct body ${'a'.repeat(i + 1)}`,
        i,
        PA_ERROR_COOLDOWN_MS,
        state,
      );
    }
    expect(state.size).toBeLessThanOrEqual(PA_FLOOD_STATE_MAX);
  });

  // Replay the measured pre-fix corpus: each multi-day flood must cost exactly
  // ONE post per 6h window instead of one per ~30min sweep.
  for (const { body, count } of FLOOD_CORPUS) {
    it(`collapses the ${count}-session flood to one forward per window`, () => {
      const state = new Map<string, number>();
      let forwarded = 0;
      for (let i = 0; i < count; i++) {
        // ~30min escalated-sweep cadence.
        const now = 5_000_000 + i * 30 * 60 * 1000;
        if (!_paRepeatWithinCooldown(body, now, PA_ERROR_COOLDOWN_MS, state)) {
          forwarded++;
        }
      }
      // count sweeps at 30min = count/12 six-hour windows, +1 for the first.
      const windows =
        Math.floor((count * 30 * 60 * 1000) / PA_ERROR_COOLDOWN_MS) + 1;
      expect(forwarded).toBeLessThanOrEqual(windows);
      expect(forwarded).toBeLessThan(count);
    });
  }

  it('costs the weekly-limit outage ONE post total across both spellings', () => {
    const state = new Map<string, number>();
    let forwarded = 0;
    // Interleave the two observed spellings within a single 6h window.
    for (let i = 0; i < 12; i++) {
      const body = i % 2 === 0 ? FLOOD_CORPUS[1].body : FLOOD_CORPUS[2].body;
      if (
        !_paRepeatWithinCooldown(
          body,
          6_000_000 + i * 30 * 60 * 1000,
          PA_ERROR_COOLDOWN_MS,
          state,
        )
      ) {
        forwarded++;
      }
    }
    expect(forwarded).toBe(1);
  });
});
