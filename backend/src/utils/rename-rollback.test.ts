import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rollbackRenamedPaths, type RenamedPath } from './rename-rollback.js';

test('rollbackRenamedPaths reverses renames LIFO', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'galleria-rename-rollback-'));
  try {
    const photosOld = path.join(root, 'photos', 'old-album');
    const photosNew = path.join(root, 'photos', 'new-album');
    const thumbOld = path.join(root, 'optimized', 'thumbnail', 'old-album');
    const thumbNew = path.join(root, 'optimized', 'thumbnail', 'new-album');
    const videoOld = path.join(root, 'video', 'old-album');
    const videoNew = path.join(root, 'video', 'new-album');

    mkdirSync(photosNew, { recursive: true });
    writeFileSync(path.join(photosNew, 'a.jpg'), 'x');
    mkdirSync(thumbNew, { recursive: true });
    writeFileSync(path.join(thumbNew, 'a.jpg'), 't');
    mkdirSync(videoNew, { recursive: true });
    writeFileSync(path.join(videoNew, 'a.mp4'), 'v');

    const renamed: RenamedPath[] = [
      { from: photosOld, to: photosNew },
      { from: thumbOld, to: thumbNew },
      { from: videoOld, to: videoNew },
    ];

    rollbackRenamedPaths(renamed);

    assert.equal(existsSync(photosOld), true);
    assert.equal(existsSync(photosNew), false);
    assert.equal(existsSync(thumbOld), true);
    assert.equal(existsSync(thumbNew), false);
    assert.equal(existsSync(videoOld), true);
    assert.equal(existsSync(videoNew), false);
    assert.equal(existsSync(path.join(photosOld, 'a.jpg')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackRenamedPaths is a no-op for empty list', () => {
  rollbackRenamedPaths([]);
});

test('rollbackRenamedPaths skips missing destinations', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'galleria-rename-rollback-missing-'));
  try {
    const from = path.join(root, 'old');
    const to = path.join(root, 'new');
    // Neither path exists — must not throw
    rollbackRenamedPaths([{ from, to }]);
    assert.equal(existsSync(from), false);
    assert.equal(existsSync(to), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackRenamedPaths restores photos when optimized rename would have failed mid-sequence', () => {
  // Simulates ticket #3337: photos/ already at new name; optimized half-done;
  // catch rolls everything tracked back to old names.
  const root = mkdtempSync(path.join(tmpdir(), 'galleria-rename-mid-fail-'));
  try {
    const photosOld = path.join(root, 'photos', 'summer');
    const photosNew = path.join(root, 'photos', 'summer-2024');
    const thumbOld = path.join(root, 'optimized', 'thumbnail', 'summer');
    const thumbNew = path.join(root, 'optimized', 'thumbnail', 'summer-2024');
    // modal never renamed (failure before it) — not in list
    const modalOld = path.join(root, 'optimized', 'modal', 'summer');

    mkdirSync(photosNew, { recursive: true });
    writeFileSync(path.join(photosNew, '1.jpg'), 'photo');
    mkdirSync(thumbNew, { recursive: true });
    writeFileSync(path.join(thumbNew, '1.jpg'), 'thumb');
    mkdirSync(modalOld, { recursive: true });
    writeFileSync(path.join(modalOld, '1.jpg'), 'modal');

    const renamed: RenamedPath[] = [
      { from: photosOld, to: photosNew },
      { from: thumbOld, to: thumbNew },
      // modal rename never succeeded — not tracked
    ];

    rollbackRenamedPaths(renamed);

    assert.equal(existsSync(photosOld), true, 'photos restored to old name');
    assert.equal(existsSync(photosNew), false);
    assert.equal(existsSync(thumbOld), true, 'thumbnail restored to old name');
    assert.equal(existsSync(thumbNew), false);
    assert.equal(existsSync(modalOld), true, 'unmoved modal stays under old name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
