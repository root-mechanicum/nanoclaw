import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _paNoopMarkedSince,
  _isPaNoopNarration,
  _isPaTransientError,
  _paTransientErrorSignature,
  _paErrorWithinCooldown,
  PA_ERROR_COOLDOWN_MS,
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

// dev-v0qm6: transient-error final-turn flood gate. Real error final-turns
// (credential expiry → 401, rate limit → 429, Overloaded → 529/5xx) flooded #pa
// one post per ~31min escalated-sweep; they are not NO-OP narration so the
// content gate missed them.
describe('_isPaTransientError', () => {
  // Real flood bodies observed 2026-06-20→22 (dev-v0qm6).
  const errorBodies = [
    'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    'API Error: 429 rate_limit_error',
    'API Error: 529 Overloaded',
    'Request failed: Overloaded',
    'API Error: 500 internal server error',
    'API Error: 503 service unavailable',
  ];
  for (const body of errorBodies) {
    it(`flags transient error: ${body.slice(0, 40)}…`, () => {
      expect(_isPaTransientError(body)).toBe(true);
    });
  }

  // Genuine posts and non-transient signals must pass through (NOT match).
  const passBodies = [
    'DECISIONS NEEDED — 3 items: D1 scn-47, D2 scn-09, D3 metabolism auth.',
    'Deploy to prod succeeded — app.gluon.me/health is green.',
    'API Error: 400 bad request', // client error, not transient
    'Blocker surfaced: dev-p1vwd awaiting human gate.',
  ];
  for (const body of passBodies) {
    it(`passes through non-transient: ${body.slice(0, 40)}…`, () => {
      expect(_isPaTransientError(body)).toBe(false);
    });
  }
});

describe('_paTransientErrorSignature', () => {
  it('keys a 401 burst on the API-error code, not the trailing phrase', () => {
    expect(
      _paTransientErrorSignature(
        'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      ),
    ).toBe('api error: 401');
  });

  it('returns null for a non-transient body', () => {
    expect(
      _paTransientErrorSignature('Morning briefing: 4 beads closed.'),
    ).toBeNull();
  });

  it('collapses the whole 401 burst to one signature', () => {
    const a = _paTransientErrorSignature(
      'API Error: 401 Invalid authentication credentials',
    );
    const b = _paTransientErrorSignature(
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    );
    expect(a).toBe(b);
  });
});

describe('_paErrorWithinCooldown', () => {
  it('forwards the first error of a class, then suppresses repeats in-window', () => {
    const state = new Map<string, number>();
    const body = 'API Error: 401 Invalid authentication credentials';
    const t0 = 1_000_000;
    // First occurrence → forward (not suppressed), records the timestamp.
    expect(_paErrorWithinCooldown(body, t0, PA_ERROR_COOLDOWN_MS, state)).toBe(
      false,
    );
    // Repeat ~31min later (one escalated-sweep) → suppress the flood.
    expect(
      _paErrorWithinCooldown(
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
    expect(_paErrorWithinCooldown(body, t0, PA_ERROR_COOLDOWN_MS, state)).toBe(
      false,
    );
    expect(
      _paErrorWithinCooldown(
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
      _paErrorWithinCooldown(
        'API Error: 401 x',
        t0,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
    expect(
      _paErrorWithinCooldown(
        'API Error: 529 Overloaded',
        t0,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
    // But a second 401 in-window is suppressed.
    expect(
      _paErrorWithinCooldown(
        'API Error: 401 y',
        t0 + 1000,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(true);
  });

  it('never suppresses a non-transient body', () => {
    const state = new Map<string, number>();
    const t0 = 4_000_000;
    expect(
      _paErrorWithinCooldown(
        'Morning briefing: all green.',
        t0,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
    expect(
      _paErrorWithinCooldown(
        'Morning briefing: all green.',
        t0 + 1000,
        PA_ERROR_COOLDOWN_MS,
        state,
      ),
    ).toBe(false);
  });
});
