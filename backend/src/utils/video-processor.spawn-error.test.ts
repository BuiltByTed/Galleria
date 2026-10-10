/**
 * Ensures ffmpeg spawn failures reject instead of hanging the Promise.
 * Trigger: empty PATH so spawn emits ENOENT (same class as missing ffmpeg).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { extractThumbnail, generateHLS, rotateVideo } from './video-processor.js';

async function withEmptyPath<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prev;
    }
  }
}

test('extractThumbnail rejects when ffmpeg spawn fails', async () => {
  await withEmptyPath(async () => {
    await assert.rejects(
      () => extractThumbnail('/tmp/galleria-missing.mp4', '/tmp/galleria-thumb.jpg', 200),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /ffmpeg spawn failed/i);
        return true;
      }
    );
  });
});

test('rotateVideo rejects when ffmpeg spawn fails', async () => {
  await withEmptyPath(async () => {
    await assert.rejects(
      () =>
        rotateVideo(
          '/tmp/galleria-missing.mp4',
          '/tmp/galleria-rotated.mp4',
          { width: 1920, height: 1080, duration: 10, rotation: 90 }
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /ffmpeg spawn failed/i);
        return true;
      }
    );
  });
});

test('generateHLS rejects when ffmpeg spawn fails', async () => {
  await withEmptyPath(async () => {
    const outDir = path.join('/tmp', `galleria-hls-${process.pid}`);
    await assert.rejects(
      () =>
        generateHLS(
          '/tmp/galleria-missing.mp4',
          outDir,
          { name: '720p', height: 720, videoBitrate: '2500k', audioBitrate: '128k' },
          4,
          false
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /ffmpeg spawn failed/i);
        return true;
      }
    );
  });
});
