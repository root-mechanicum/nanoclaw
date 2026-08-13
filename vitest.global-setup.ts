import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Suite-level negative control for dev-2h43mx.
 *
 * On 2026-08-13 a full `npx vitest run` in this repo destroyed the live git
 * index entry for a tracked, staged file (`src/index.ts` went `D `+`??`) and
 * the run still exited 0. The cause was skills-engine shelling out to git with
 * an inherited `process.cwd()` while the tests "isolated" via the
 * process-global `process.chdir()`.
 *
 * The library fix makes the directory an argument. This is the check that the
 * fix stays true: snapshot THIS repository's index before the suite and again
 * after it, and fail the run if any test moved it. It keys on the property
 * ("the suite must not write this repo's index"), not on the files that were
 * broken once, so a new test file that reintroduces the hazard fails here.
 */

const ROOT = path.dirname(fileURLToPath(import.meta.url));

type Snapshot = { taken: true; entries: string } | { taken: false; why: string };

function snapshotIndex(): Snapshot {
  let repoRoot: string;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return { taken: false, why: 'not inside a git repository' };
  }

  try {
    // `git ls-files -s` prints mode/object/stage/path for every index entry.
    // Unlike the raw .git/index bytes it is stable across git's stat-cache
    // refreshes, so it only moves when the index really changes.
    const entries = execFileSync('git', ['ls-files', '-s'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { taken: true, entries };
  } catch (err: any) {
    return { taken: false, why: `git ls-files failed: ${err.message}` };
  }
}

let before: Snapshot;

export function setup(): void {
  before = snapshotIndex();
  if (!before.taken) {
    // An unmeasurable guard is UNKNOWN, not a pass. Say so out loud rather
    // than letting a silent skip read as green.
    console.warn(
      `[index-guard] SKIPPED — ${before.why}. The suite is NOT protected ` +
        `against mutating a live git index in this run.`,
    );
  }
}

export function teardown(): void {
  if (!before?.taken) return;

  const after = snapshotIndex();
  if (!after.taken) {
    throw new Error(
      `[index-guard] could not re-read the index after the run (${after.why}) — ` +
        `treat this as UNKNOWN, not as clean.`,
    );
  }

  if (after.entries === before.entries) return;

  const parse = (s: string) =>
    new Map(
      s
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [meta, file] = line.split('\t');
          return [file, meta] as const;
        }),
    );

  const a = parse(before.entries);
  const b = parse(after.entries);
  const removed = [...a.keys()].filter((f) => !b.has(f));
  const added = [...b.keys()].filter((f) => !a.has(f));
  const changed = [...a.keys()].filter((f) => b.has(f) && b.get(f) !== a.get(f));

  throw new Error(
    [
      '[index-guard] THE TEST SUITE MUTATED THIS REPOSITORY\'S GIT INDEX.',
      '',
      'This is the dev-2h43mx failure mode: a tracked, staged path can be',
      'evicted from the index by a test, after which a scoped `git add` of a',
      'DIFFERENT file plus `git commit` silently drops it with rc 0.',
      '',
      `  entries removed from index (${removed.length}): ${removed.join(', ') || '-'}`,
      `  entries added to index     (${added.length}): ${added.join(', ') || '-'}`,
      `  entries changed in index   (${changed.length}): ${changed.join(', ') || '-'}`,
      '',
      'Recover with: git reset && git add -A <the paths you meant to stage>',
      'Then find the test that shells out to git without an explicit cwd.',
    ].join('\n'),
  );
}
