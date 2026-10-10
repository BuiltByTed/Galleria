import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyticsTimeRange,
  OPENOBSERVE_TIMESTAMP_SQL,
  timestampAnalyticsEvent,
} from './analytics-timestamp.js';

test('ingested analytics timestamps match the metrics query microsecond contract', () => {
  const occurredAt = '2026-07-29T12:00:00.000Z';
  const occurredAtMilliseconds = Date.parse(occurredAt);
  const queryEndMilliseconds = occurredAtMilliseconds + 5_000;

  const event = timestampAnalyticsEvent(
    { event_type: 'pageview', timestamp: occurredAt },
    queryEndMilliseconds,
  );
  const { startTime, endTime } = analyticsTimeRange(30, queryEndMilliseconds);

  assert.equal(event._timestamp, occurredAtMilliseconds * 1_000);
  assert.ok(event._timestamp >= startTime);
  assert.ok(event._timestamp <= endTime);
  assert.equal(OPENOBSERVE_TIMESTAMP_SQL, 'to_timestamp_micros(_timestamp)');
});

test('ingestion uses a microsecond fallback for events without a valid occurrence time', () => {
  const ingestionMilliseconds = Date.parse('2026-07-29T12:00:05.000Z');

  const event = timestampAnalyticsEvent(
    { event_type: 'pageview', timestamp: 'invalid' },
    ingestionMilliseconds,
  );

  assert.equal(event._timestamp, ingestionMilliseconds * 1_000);
});
