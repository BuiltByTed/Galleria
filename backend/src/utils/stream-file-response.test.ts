import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { streamFileToResponse } from "./stream-file-response.js";

for (const range of [undefined, { start: 0, end: 1 }]) {
  const requestType = range ? "range" : "whole-file";

  test(`${requestType} stream closes the response when the file is deleted after stat`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "galleria-video-stream-"));
    const videoPath = path.join(root, "album", "video.mp4", "original.mp4");
    mkdirSync(path.dirname(videoPath), { recursive: true });
    writeFileSync(videoPath, "video");

    try {
      statSync(videoPath);
      unlinkSync(videoPath);

      const response = new PassThrough();
      await assert.rejects(
        () => streamFileToResponse(videoPath, response, range),
        (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, "ENOENT");
          return true;
        }
      );

      assert.equal(response.destroyed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
