import { execFileSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  isCustomizeActive,
  startCustomize,
  commitCustomize,
  abortCustomize,
} from '../customize.js';
import { CUSTOM_DIR } from '../constants.js';
import {
  createTempDir,
  setupNanoclawDir,
  createMinimalState,
  cleanup,
  writeState,
} from './test-helpers.js';
import { readState, recordSkillApplication, computeFileHash } from '../state.js';

describe('customize', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    createMinimalState(tmpDir);
    fs.mkdirSync(path.join(tmpDir, CUSTOM_DIR), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('startCustomize creates pending.yaml and isCustomizeActive returns true', () => {
    // Need at least one applied skill with file_hashes for snapshot
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    expect(isCustomizeActive()).toBe(false);
    startCustomize('test customization');
    expect(isCustomizeActive()).toBe(true);

    const pendingPath = path.join(tmpDir, CUSTOM_DIR, 'pending.yaml');
    expect(fs.existsSync(pendingPath)).toBe(true);
  });

  it('abortCustomize removes pending.yaml', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('test');
    expect(isCustomizeActive()).toBe(true);

    abortCustomize();
    expect(isCustomizeActive()).toBe(false);
  });

  it('commitCustomize with no changes clears pending', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('no-op');
    commitCustomize();

    expect(isCustomizeActive()).toBe(false);
  });

  it('commitCustomize with changes creates patch and records in state', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('add feature');

    // Modify the tracked file
    fs.writeFileSync(trackedFile, 'export const x = 2;\nexport const y = 3;');

    commitCustomize();

    expect(isCustomizeActive()).toBe(false);
    const state = readState();
    expect(state.custom_modifications).toBeDefined();
    expect(state.custom_modifications!.length).toBeGreaterThan(0);
    expect(state.custom_modifications![0].description).toBe('add feature');
  });

  it('commitCustomize throws descriptive error on diff failure', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('diff-error test');

    // Modify the tracked file
    fs.writeFileSync(trackedFile, 'export const x = 2;');

    // Force `diff` to exit 2 (a real error, not "files differ").
    //
    // The base path must satisfy TWO conditions at once, which rules out most
    // of the obvious arrangements:
    //   1. fs.existsSync(basePath) must be true, or commitCustomize
    //      substitutes /dev/null and diff never sees it at all.
    //   2. `diff -ruN` must then fail to READ it.
    // A directory (the original arrangement) fails (2): with -r diff descends
    // looking for app.ts/app.ts and -N treats the missing side as empty, so
    // it exits 1 = "files differ". Missing paths, dangling symlinks and
    // symlink loops all fail (1) — existsSync stats them and returns false.
    // chmod 000 fails when the suite runs as root, which it does here.
    // /proc/self/mem stats fine and returns EIO on read for any privilege
    // level, so it satisfies both. Linux-only, which this service is.
    const baseFilePath = path.join(tmpDir, '.nanoclaw', 'base', 'src', 'app.ts');
    fs.symlinkSync('/proc/self/mem', baseFilePath);

    // Precondition: prove the arrangement still produces exit 2 BEFORE
    // asserting on the code. Without this, an arrangement that quietly stops
    // working (as the directory one did) reads as "the code failed to throw"
    // and sends the next reader after the wrong defect.
    expect(fs.existsSync(baseFilePath)).toBe(true);
    let diffStatus: number | undefined;
    try {
      execFileSync('diff', ['-ruN', baseFilePath, trackedFile], {
        encoding: 'utf-8',
      });
      diffStatus = 0;
    } catch (err: any) {
      diffStatus = err.status;
    }
    expect(diffStatus, 'test arrangement no longer makes diff exit 2').toBe(2);

    expect(() => commitCustomize()).toThrow(/diff error/i);
  });

  it('startCustomize while active throws', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('first');
    expect(() => startCustomize('second')).toThrow();
  });
});
