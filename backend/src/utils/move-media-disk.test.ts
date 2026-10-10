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
import { moveMediaDiskAssets } from "./move-media-disk.js";

function touch(filePath: string, contents = "x"): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

test("moveMediaDiskAssets moves photo original and same-name optimized", () => {
  const root = mkdtempSync(path.join(tmpdir(), "galleria-move-media-photo-"));
  try {
    const photosDir = path.join(root, "photos");
    const optimizedDir = path.join(root, "optimized");
    const videoDir = path.join(root, "video");
    const fromAlbum = "Source";
    const toAlbum = "Dest";
    const filename = "sunset.jpg";

    touch(path.join(photosDir, fromAlbum, filename), "orig");
    for (const dir of ["thumbnail", "modal", "download"]) {
      touch(path.join(optimizedDir, dir, fromAlbum, filename), dir);
    }
    // unrelated video in source must stay
    touch(path.join(videoDir, fromAlbum, "other.mp4", "master.m3u8"));

    const result = moveMediaDiskAssets({
      photosDir,
      optimizedDir,
      videoDir,
      fromAlbum,
      toAlbum,
      filename,
    });

    assert.equal(result.originalMoved, true);
    assert.equal(result.hlsMoved, false);
    assert.equal(result.posterMoved.length, 0);
    assert.equal(result.optimizedMoved.length, 3);

    assert.equal(existsSync(path.join(photosDir, fromAlbum, filename)), false);
    assert.equal(existsSync(path.join(photosDir, toAlbum, filename)), true);
    assert.equal(
      readFileSync(path.join(photosDir, toAlbum, filename), "utf8"),
      "orig"
    );

    for (const dir of ["thumbnail", "modal", "download"]) {
      assert.equal(
        existsSync(path.join(optimizedDir, dir, fromAlbum, filename)),
        false
      );
      assert.equal(
        existsSync(path.join(optimizedDir, dir, toAlbum, filename)),
        true
      );
    }
    assert.equal(
      existsSync(path.join(videoDir, fromAlbum, "other.mp4", "master.m3u8")),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moveMediaDiskAssets moves video HLS tree and posters", () => {
  const root = mkdtempSync(path.join(tmpdir(), "galleria-move-media-video-"));
  try {
    const photosDir = path.join(root, "photos");
    const optimizedDir = path.join(root, "optimized");
    const videoDir = path.join(root, "video");
    const fromAlbum = "Source";
    const toAlbum = "Dest";
    const filename = "clip.mp4";
    const poster = "clip.jpg";

    touch(path.join(photosDir, fromAlbum, filename), "vid");
    touch(path.join(videoDir, fromAlbum, filename, "master.m3u8"), "hls");
    for (const dir of ["thumbnail", "modal", "download"]) {
      touch(path.join(optimizedDir, dir, fromAlbum, poster), "poster");
    }

    const result = moveMediaDiskAssets({
      photosDir,
      optimizedDir,
      videoDir,
      fromAlbum,
      toAlbum,
      filename,
    });

    assert.equal(result.originalMoved, true);
    assert.equal(result.hlsMoved, true);
    assert.equal(result.posterMoved.length, 3);

    assert.equal(existsSync(path.join(photosDir, fromAlbum, filename)), false);
    assert.equal(existsSync(path.join(photosDir, toAlbum, filename)), true);
    assert.equal(
      existsSync(path.join(videoDir, fromAlbum, filename, "master.m3u8")),
      false
    );
    assert.equal(
      existsSync(path.join(videoDir, toAlbum, filename, "master.m3u8")),
      true
    );
    for (const dir of ["thumbnail", "modal", "download"]) {
      assert.equal(
        existsSync(path.join(optimizedDir, dir, fromAlbum, poster)),
        false
      );
      assert.equal(
        existsSync(path.join(optimizedDir, dir, toAlbum, poster)),
        true
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moveMediaDiskAssets throws and rolls back if destination original exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "galleria-move-media-collision-"));
  try {
    const photosDir = path.join(root, "photos");
    const optimizedDir = path.join(root, "optimized");
    const fromAlbum = "Source";
    const toAlbum = "Dest";
    const filename = "dup.jpg";

    touch(path.join(photosDir, fromAlbum, filename), "src");
    touch(path.join(photosDir, toAlbum, filename), "dst");
    touch(path.join(optimizedDir, "thumbnail", fromAlbum, filename), "thumb");

    assert.throws(() =>
      moveMediaDiskAssets({
        photosDir,
        optimizedDir,
        fromAlbum,
        toAlbum,
        filename,
      })
    );

    // Source untouched
    assert.equal(
      readFileSync(path.join(photosDir, fromAlbum, filename), "utf8"),
      "src"
    );
    assert.equal(
      existsSync(path.join(optimizedDir, "thumbnail", fromAlbum, filename)),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
