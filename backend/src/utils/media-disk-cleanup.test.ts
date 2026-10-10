import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isVideoFilename,
  removeMediaDiskAssets,
  videoPosterFilename,
} from "./media-disk-cleanup.js";

function touch(filePath: string, contents = "x"): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

test("isVideoFilename and videoPosterFilename", () => {
  assert.equal(isVideoFilename("clip.mp4"), true);
  assert.equal(isVideoFilename("clip.MOV"), true);
  assert.equal(isVideoFilename("shot.jpg"), false);
  assert.equal(videoPosterFilename("clip.mp4"), "clip.jpg");
  assert.equal(videoPosterFilename("my.video.webm"), "my.video.jpg");
});

test("removeMediaDiskAssets deletes photo original and same-name optimized only", () => {
  const root = mkdtempSync(path.join(tmpdir(), "galleria-media-cleanup-photo-"));
  try {
    const photosDir = path.join(root, "photos");
    const optimizedDir = path.join(root, "optimized");
    const videoDir = path.join(root, "video");
    const album = "Trip";
    const filename = "sunset.jpg";

    touch(path.join(photosDir, album, filename));
    for (const dir of ["thumbnail", "modal", "download"]) {
      touch(path.join(optimizedDir, dir, album, filename));
    }
    // unrelated video tree must not be touched
    touch(path.join(videoDir, album, "other.mp4", "master.m3u8"));

    const result = removeMediaDiskAssets({
      photosDir,
      optimizedDir,
      videoDir,
      album,
      filename,
    });

    assert.equal(result.originalDeleted, true);
    assert.equal(result.hlsRemoved, false);
    assert.equal(result.posterRemoved.length, 0);
    assert.equal(existsSync(path.join(photosDir, album, filename)), false);
    for (const dir of ["thumbnail", "modal", "download"]) {
      assert.equal(existsSync(path.join(optimizedDir, dir, album, filename)), false);
    }
    assert.equal(
      existsSync(path.join(videoDir, album, "other.mp4", "master.m3u8")),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeMediaDiskAssets deletes video HLS tree and .jpg posters", () => {
  const root = mkdtempSync(path.join(tmpdir(), "galleria-media-cleanup-video-"));
  try {
    const photosDir = path.join(root, "photos");
    const optimizedDir = path.join(root, "optimized");
    const videoDir = path.join(root, "video");
    const album = "Trip";
    const filename = "clip.mp4";
    const poster = "clip.jpg";

    touch(path.join(photosDir, album, filename), "mp4");
    // processVideo writes posters as basename.jpg, not .mp4
    touch(path.join(optimizedDir, "thumbnail", album, poster));
    touch(path.join(optimizedDir, "modal", album, poster));
    touch(path.join(optimizedDir, "download", album, poster));
    // HLS tree under videoDir/<album>/<filename>/
    touch(path.join(videoDir, album, filename, "master.m3u8"), "#EXTM3U");
    touch(path.join(videoDir, album, filename, "720p", "seg0.ts"), "ts");
    // sibling video must remain
    touch(path.join(videoDir, album, "keep.mp4", "master.m3u8"), "#EXTM3U");
    touch(path.join(photosDir, album, "keep.mp4"), "mp4");

    const result = removeMediaDiskAssets({
      photosDir,
      optimizedDir,
      videoDir,
      album,
      filename,
    });

    assert.equal(result.originalDeleted, true);
    assert.equal(result.hlsRemoved, true);
    assert.deepEqual(
      new Set(result.posterRemoved),
      new Set([
        "thumbnail/clip.jpg",
        "modal/clip.jpg",
        "download/clip.jpg",
      ])
    );

    assert.equal(existsSync(path.join(photosDir, album, filename)), false);
    assert.equal(existsSync(path.join(videoDir, album, filename)), false);
    for (const dir of ["thumbnail", "modal", "download"]) {
      assert.equal(existsSync(path.join(optimizedDir, dir, album, poster)), false);
    }
    // sibling preserved
    assert.equal(existsSync(path.join(videoDir, album, "keep.mp4", "master.m3u8")), true);
    assert.equal(existsSync(path.join(photosDir, album, "keep.mp4")), true);
    assert.equal(
      readFileSync(path.join(videoDir, album, "keep.mp4", "master.m3u8"), "utf8"),
      "#EXTM3U"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeMediaDiskAssets is no-op for missing optimized/HLS paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "galleria-media-cleanup-missing-"));
  try {
    const photosDir = path.join(root, "photos");
    const optimizedDir = path.join(root, "optimized");
    const videoDir = path.join(root, "video");
    const album = "Empty";
    const filename = "gone.mp4";
    touch(path.join(photosDir, album, filename));

    const result = removeMediaDiskAssets({
      photosDir,
      optimizedDir,
      videoDir,
      album,
      filename,
    });

    assert.equal(result.originalDeleted, true);
    assert.equal(result.hlsRemoved, false);
    assert.equal(result.posterRemoved.length, 0);
    assert.equal(existsSync(path.join(photosDir, album, filename)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
