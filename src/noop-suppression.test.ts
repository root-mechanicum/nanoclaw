import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _paNoopMarkedSince } from './index.js';

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
