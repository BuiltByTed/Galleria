import assert from 'node:assert/strict';
import test from 'node:test';
import type { UploadingImage } from '../types.ts';
import { applyCompleteOptimizationUpdate } from './optimizationStreamState.ts';

const uploadingImage = {
  file: {} as File,
  filename: 'Lake.jpg',
  state: 'generating-title'
} satisfies UploadingImage;

test('preserves an AI title error from a complete SSE payload', () => {
  const result = applyCompleteOptimizationUpdate(uploadingImage, {
    state: 'complete',
    album: 'Summer',
    filename: 'Lake.jpg',
    error: 'AI error: title service unavailable'
  });

  assert.equal(result.state, 'complete');
  assert.equal(result.photo?.aiError, 'AI error: title service unavailable');
  assert.equal(result.photo?.title, '');
});

test('does not add an AI error to a successful complete SSE payload', () => {
  const result = applyCompleteOptimizationUpdate(uploadingImage, {
    state: 'complete',
    album: 'Summer',
    filename: 'Lake.jpg',
    title: 'Still Water'
  });

  assert.equal(result.photo?.title, 'Still Water');
  assert.equal(result.photo?.aiError, undefined);
});
