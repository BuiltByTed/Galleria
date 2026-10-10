import fs from "node:fs";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface FileStreamRange {
  start: number;
  end: number;
}

/**
 * Stream a file into an HTTP response-compatible destination.
 *
 * Awaiting pipeline propagates asynchronous open/read failures to the route
 * handler and destroys the destination when either side fails.
 */
export async function streamFileToResponse(
  filePath: string,
  destination: Writable,
  range?: FileStreamRange
): Promise<void> {
  await pipeline(fs.createReadStream(filePath, range), destination);
}
