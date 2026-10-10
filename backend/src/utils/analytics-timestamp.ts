declare const epochMicrosecondsBrand: unique symbol;

export type EpochMicroseconds = number & {
  readonly [epochMicrosecondsBrand]: 'EpochMicroseconds';
};

export const OPENOBSERVE_TIMESTAMP_SQL = 'to_timestamp_micros(_timestamp)';

const MICROSECONDS_PER_MILLISECOND = 1_000;
const MICROSECONDS_PER_DAY = 24 * 60 * 60 * 1_000 * MICROSECONDS_PER_MILLISECOND;

export interface AnalyticsTimeRange {
  startTime: EpochMicroseconds;
  endTime: EpochMicroseconds;
}

export function millisecondsToMicroseconds(epochMilliseconds: number): EpochMicroseconds {
  return (epochMilliseconds * MICROSECONDS_PER_MILLISECOND) as EpochMicroseconds;
}

export function timestampAnalyticsEvent(
  event: unknown,
  fallbackEpochMilliseconds = Date.now(),
): Record<string, unknown> & { _timestamp: EpochMicroseconds } {
  const normalizedEvent =
    event !== null && typeof event === 'object' && !Array.isArray(event)
      ? event as Record<string, unknown>
      : {};
  const parsedTimestamp =
    typeof normalizedEvent.timestamp === 'string'
      ? Date.parse(normalizedEvent.timestamp)
      : Number.NaN;
  const epochMilliseconds = Number.isFinite(parsedTimestamp)
    ? parsedTimestamp
    : fallbackEpochMilliseconds;

  return {
    ...normalizedEvent,
    _timestamp: millisecondsToMicroseconds(epochMilliseconds),
  };
}

export function analyticsTimeRange(
  days: number,
  endEpochMilliseconds = Date.now(),
): AnalyticsTimeRange {
  const endTime = millisecondsToMicroseconds(endEpochMilliseconds);
  const startTime = (endTime - days * MICROSECONDS_PER_DAY) as EpochMicroseconds;

  return { startTime, endTime };
}
