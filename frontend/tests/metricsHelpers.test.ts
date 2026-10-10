import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { formatLocalDate } from '../src/utils/metricsHelpers.ts';

const withTimezone = (timezone: string, run: () => void): void => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;

  try {
    run();
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
};

test('keeps the local calendar date east of UTC', () => {
  withTimezone('Asia/Tokyo', () => {
    const localMidnight = new Date(2026, 6, 29);

    assert.equal(localMidnight.toISOString().split('T')[0], '2026-07-28');
    assert.equal(formatLocalDate(localMidnight), '2026-07-29');
  });
});

test('keeps the local calendar date west of UTC', () => {
  withTimezone('America/New_York', () => {
    const localMidnight = new Date(2026, 6, 29);

    assert.equal(formatLocalDate(localMidnight), '2026-07-29');
  });
});
