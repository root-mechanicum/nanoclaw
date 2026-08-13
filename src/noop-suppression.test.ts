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
  shouldSuppressPaNoopForward,
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

// ---------------------------------------------------------------------------
// dev-l8uyw3: the COMPOSED gate. Until this bead, shouldSuppressPaNoopForward —
// the only function actually wired into either forward path — had NO tests at
// all; the 26 tests above cover its components in isolation. That is how an
// inverted polarity survived three "fixes": every component behaved exactly as
// specified, and the composition was wrong.
//
// The corpus below is the measured 2026-08-13 flood in #pa (C0AG8JCNUR1),
// CSV-parsed from conversations_history. Nine consecutive PA-authored narration
// posts, each from a cycle that did real agent-facing work and DELIBERATELY
// declined to post to Slack. Bodies are excerpts (opening + closing lines, where
// the heartbeat vocabulary would live) with the Slack export's punctuation
// normalisation; the gate is polarity-based, not phrase-based, so the verdict
// does not depend on exact wording — which is the whole point of the fix.
const PA_NARRATION_CORPUS: ReadonlyArray<{ at: string; body: string }> = [
  {
    at: '00:17:07Z',
    body: `PA Cycle Summary 2026-08-13 00:15Z

Processed CopperBridges root cause analysis for the Tailscale outage dev-qu1d4e/D59.
Root cause confirmed: 180-day Tailscale key expiry on dev VPS.

D59 now has complete fix instructions and awaits Roots ruling. Exit marker set for dispatch.`,
  },
  {
    at: '00:22:03Z',
    body: `Perfect Ive acknowledged CopperBridges correction and saved the learning to memory.

Key takeaway: When health checks fail with rc 255 SSH never reached host during a known
tailnet incident, thats an observer failure, not a subject failure.

This has been saved to feedback_observer_vs_subject_failure.md so I wont repeat this pattern.`,
  },
  {
    at: '00:36:47Z',
    body: `PA Cycle Summary 2026-08-13T00:33Z

Acknowledged critical feedback from GoldStream Agent Mail message 65811, re: dev-fyl3kr.
New requirements saved to PA memory.

No new urgent items requiring immediate escalation. Exiting cleanly.`,
  },
  {
    at: '01:23:59Z',
    body: `Sweep complete real work, no Slack post.

Queue unchanged: 65 live gates, 8 blocked, 16 escalated, 0 uncarded, AM inbox 0 unread.
Found and fixed D58/dev-m0xy68 P1 was DIVERGED.

No Slack post, deliberately. Both findings are agent-workable, no recommendation changed.`,
  },
  {
    at: '01:50:11Z',
    body: `I can see the message from CopperForge message_id 65834. This is an FYI message.

However, I notice several more urgent items in my inbox that need immediate attention:
1. Message 65824 - TealSparrow reports GoldCompass parked for 4h0m52s on a role_pin_stall

Should I proceed with a full startup sweep to triage these blockers?`,
  },
  {
    at: '02:00:12Z',
    body: `Gate sweep clean no post made, deliberately.

Gates: 53 numbered gates, all carded. Only the 12 DEFERRED lack cards, which is by design.

Why no Slack post: pa has six consecutive PA-authored narration posts stacked on the last
real decision content D59, 00:15Z. A seventh post wouldnt reach Root.`,
  },
  {
    at: '02:16:14Z',
    body: `Summary

Completed PA cycle with substantial work on lost gate card patches:
1. Processed critical Agent Mail from GoldStream message 65836 about 5 gate cards.
2. Regenerated all three lost patches from their ruling documents.

All three gates are now answerable pending Roots ruling. Exiting cleanly.`,
  },
  {
    // The clinching case: the genuine D60 card landed 03:11:02Z via the Slack
    // MCP, and this final-turn echo buried it three minutes later.
    at: '03:14:10Z',
    body: `D60 surfaced to Root. Gate is ready, card is complete with 6 assertions, patch is pinned. Clean exit.`,
  },
  {
    at: '03:20:28Z',
    body: `Processed Agent Mail from CopperBridge about dev-ptyd0x closure and dev-nqk192 residual.

Key findings:
- dev-ptyd0x: Closed, commits eaf366243, c84d5511d.
- dev-nqk192: New P1, needs operator on prod VPS to set GH_DEPLOY_TOKEN.

Decision queue unchanged 65 items. Recorded in pa-state.md and exiting cleanly.`,
  },
];

describe('shouldSuppressPaNoopForward (deny-by-default, dev-l8uyw3)', () => {
  // Must be LATER than any real PA_NOOP_MARKER mtime on the host. The composed
  // gate no longer reads the marker, but a small epoch here (e.g. 9_000_000 =
  // 1970) makes `mtime >= cycleStartMs` true against whatever stale marker this
  // box happens to have, which silently masked the polarity under test: with a
  // 1970 cycle start the nine narration tests below passed against the OLD
  // allow-by-default gate too, via a spurious marker hit rather than the change
  // they exist to pin. A cycle start in the near future makes the marker arm
  // provably false, so these tests fail if the polarity is ever reverted.
  const CYCLE = Date.now() + 60_000;

  it('never suppresses a non-PA group (the gate is PA-scoped)', () => {
    const state = new Map<string, number>();
    for (const { body } of PA_NARRATION_CORPUS) {
      expect(shouldSuppressPaNoopForward(false, body, CYCLE, state)).toBe(false);
    }
  });

  // The core regression: each of these nine real bodies must now be dropped.
  for (const { at, body } of PA_NARRATION_CORPUS) {
    it(`drops the real-work narration posted at ${at}`, () => {
      const state = new Map<string, number>();
      expect(shouldSuppressPaNoopForward(true, body, CYCLE, state)).toBe(true);
    });
  }

  // NEGATIVE CONTROL. Without this, the test above proves nothing: a gate that
  // drops everything would pass it, and so would the OLD gate if these bodies
  // had merely matched the content regex. Pin that the old allow-by-default
  // logic would have FORWARDED every one of them — no marker (a real-work cycle
  // never touches it) and no narration-regex match — so these nine tests are
  // measuring the polarity change and not a lucky regex hit.
  for (const { at, body } of PA_NARRATION_CORPUS) {
    it(`old allow-by-default gate would have forwarded ${at} (control)`, () => {
      expect(_isPaNoopNarration(body)).toBe(false);
      expect(_paFailureClass(body)).toBe(null);
    });
  }

  // Deny-by-default is only safe because genuine content never travels this
  // path — it is posted via the Slack MCP mid-cycle. Pin that expectation
  // explicitly so the invariant is visible rather than folklore: yes, a decision
  // card WOULD be dropped here, and that is why PA must never rely on the
  // final-turn forward to reach Root.
  it('drops even decision-card-shaped text (real cards go via Slack MCP mid-cycle)', () => {
    const state = new Map<string, number>();
    const card = `DECISIONS NEEDED 1 item

D60: Reinstate physicality value delete status: retired
 Bead: dev-na5dkw
 Options: A approve both edits B approve deletion only C refuse

Reply: D60=A or specify option`;
    expect(shouldSuppressPaNoopForward(true, card, CYCLE, state)).toBe(true);
  });

  // THE PAGER MUST SURVIVE. A dead session (401 / usage wall / OAuth / 5xx) made
  // zero tool calls, so it could not have posted anything itself: this forward is
  // the only way "PA is down" reaches Slack. Unconditional suppression would turn
  // a surface-burn bug into a silent blackout.
  for (const { body, cls } of FLOOD_CORPUS) {
    it(`still forwards the FIRST dead-session body of class ${cls}`, () => {
      const state = new Map<string, number>();
      expect(shouldSuppressPaNoopForward(true, body, CYCLE, state)).toBe(false);
    });
  }

  // ...but exactly once per window. Replay each measured multi-day flood through
  // the COMPOSED gate at the ~30min escalated-sweep cadence.
  for (const { body, count, cls } of FLOOD_CORPUS) {
    it(`collapses the ${count}-session ${cls} flood to <=1 post per 6h`, () => {
      const state = new Map<string, number>();
      let forwarded = 0;
      for (let i = 0; i < count; i++) {
        if (
          !shouldSuppressPaNoopForward(
            true,
            body,
            CYCLE + i * 30 * 60 * 1000,
            state,
          )
        ) {
          forwarded++;
        }
      }
      const windows =
        Math.floor((count * 30 * 60 * 1000) / PA_ERROR_COOLDOWN_MS) + 1;
      expect(forwarded).toBeGreaterThanOrEqual(1); // pager not blacked out
      expect(forwarded).toBeLessThanOrEqual(windows);
      expect(forwarded).toBeLessThan(count);
    });
  }

  // The marker is no longer load-bearing. A TRUE NO-OP cycle was already dropped
  // by the old marker gate; assert deny-by-default did not accidentally invert
  // that, and that a real-work cycle (no marker at all) is dropped just the same.
  it('drops narration whether or not the NO-OP marker was touched', () => {
    const state = new Map<string, number>();
    const body = 'Escalated sweep complete. Nothing to surface.';
    // No marker exists in this test env, i.e. the real-work case.
    expect(_paNoopMarkedSince(CYCLE, markerPath)).toBe(false);
    expect(shouldSuppressPaNoopForward(true, body, CYCLE, state)).toBe(true);
  });
});
