import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishUploadWithoutOverwrite } from "./publish-upload.js";

test("publishUploadWithoutOverwrite preserves an existing normalized filename", async () => {
  const albumPath = mkdtempSync(path.join(tmpdir(), "galleria-publish-upload-"));

  try {
    const stagedPath = path.join(albumPath, ".upload-staged.jpg");
    const existingPath = path.join(albumPath, "Foo Bar.jpg");
    writeFileSync(existingPath, "existing");
    writeFileSync(stagedPath, "new");

    const published = await publishUploadWithoutOverwrite(
      stagedPath,
      albumPath,
      "Foo Bar.jpg"
    );

    assert.equal(published.filename, "Foo Bar 2.jpg");
    assert.equal(readFileSync(existingPath, "utf8"), "existing");
    assert.equal(readFileSync(published.destPath, "utf8"), "new");
  } finally {
    rmSync(albumPath, { recursive: true, force: true });
  }
});

test("publishUploadWithoutOverwrite assigns unique names to concurrent uploads", async () => {
  const albumPath = mkdtempSync(
    path.join(tmpdir(), "galleria-publish-upload-concurrent-")
  );

  try {
    const stagedPaths = Array.from({ length: 12 }, (_, index) => {
      const stagedPath = path.join(albumPath, `.upload-${index}.jpg`);
      writeFileSync(stagedPath, `upload-${index}`);
      return stagedPath;
    });

    const published = await Promise.all(
      stagedPaths.map((stagedPath) =>
        publishUploadWithoutOverwrite(stagedPath, albumPath, "Same Photo.jpg")
      )
    );

    const filenames = published.map(({ filename }) => filename);
    assert.equal(new Set(filenames).size, stagedPaths.length);
    assert.deepEqual(
      filenames.sort(),
      [
        "Same Photo 10.jpg",
        "Same Photo 11.jpg",
        "Same Photo 12.jpg",
        "Same Photo 2.jpg",
        "Same Photo 3.jpg",
        "Same Photo 4.jpg",
        "Same Photo 5.jpg",
        "Same Photo 6.jpg",
        "Same Photo 7.jpg",
        "Same Photo 8.jpg",
        "Same Photo 9.jpg",
        "Same Photo.jpg",
      ].sort()
    );

    assert.deepEqual(
      new Set(published.map(({ destPath }) => readFileSync(destPath, "utf8"))),
      new Set(stagedPaths.map((_, index) => `upload-${index}`))
    );
  } finally {
    rmSync(albumPath, { recursive: true, force: true });
  }
});
