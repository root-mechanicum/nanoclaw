import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _paNoopMarkedSince, _isPaNoopNarration } from './noop-suppression.js';

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
