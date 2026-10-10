import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  deleteAlbumsFromFolder,
  FolderAlbumDeletionError,
  type FolderAlbumDeletionDependencies,
} from "./folder-album-deletion.js";

const directories = {
  photosDir: "/photos",
  optimizedDir: "/optimized",
  videoDir: "/video",
};

function createDependencies(
  overrides: Partial<FolderAlbumDeletionDependencies> = {}
): FolderAlbumDeletionDependencies {
  return {
    pathExists: () => true,
    removeDirectory: () => undefined,
    cancelShareLinkTimers: async () => undefined,
    deleteAlbumMetadata: () => undefined,
    deleteAlbumState: () => true,
    ...overrides,
  };
}

test("deleteAlbumsFromFolder deletes every album before resolving", async () => {
  const events: string[] = [];
  const dependencies = createDependencies({
    removeDirectory: targetPath => {
      events.push(`remove:${targetPath}`);
    },
    cancelShareLinkTimers: async albumName => {
      events.push(`cancel:${albumName}`);
    },
    deleteAlbumMetadata: albumName => {
      events.push(`metadata:${albumName}`);
    },
    deleteAlbumState: albumName => {
      events.push(`state:${albumName}`);
      return true;
    },
    onVideoDirectoryDeleted: albumName => {
      events.push(`video:${albumName}`);
    },
    onAlbumDeleted: albumName => {
      events.push(`deleted:${albumName}`);
    },
  });

  await deleteAlbumsFromFolder(
    [{ name: "First" }, { name: "Second" }],
    directories,
    dependencies
  );

  assert.deepEqual(events, [
    `remove:${path.join("/photos", "First")}`,
    `remove:${path.join("/optimized", "thumbnail", "First")}`,
    `remove:${path.join("/optimized", "modal", "First")}`,
    `remove:${path.join("/optimized", "download", "First")}`,
    `remove:${path.join("/video", "First")}`,
    "video:First",
    "cancel:First",
    "metadata:First",
    "state:First",
    "deleted:First",
    `remove:${path.join("/photos", "Second")}`,
    `remove:${path.join("/optimized", "thumbnail", "Second")}`,
    `remove:${path.join("/optimized", "modal", "Second")}`,
    `remove:${path.join("/optimized", "download", "Second")}`,
    `remove:${path.join("/video", "Second")}`,
    "video:Second",
    "cancel:Second",
    "metadata:Second",
    "state:Second",
    "deleted:Second",
  ]);
});

test("deleteAlbumsFromFolder aborts and reports a filesystem failure", async () => {
  const attemptedPaths: string[] = [];
  const deletedStates: string[] = [];
  const failure = new Error("permission denied");
  const failingPath = path.join("/optimized", "modal", "Broken");
  const dependencies = createDependencies({
    removeDirectory: targetPath => {
      attemptedPaths.push(targetPath);
      if (targetPath === failingPath) {
        throw failure;
      }
    },
    deleteAlbumState: albumName => {
      deletedStates.push(albumName);
      return true;
    },
  });

  await assert.rejects(
    deleteAlbumsFromFolder(
      [{ name: "Broken" }, { name: "Untouched" }],
      directories,
      dependencies
    ),
    err => {
      assert.ok(err instanceof FolderAlbumDeletionError);
      assert.deepEqual(err.failedAlbums, ["Broken"]);
      assert.equal(err.cause, failure);
      return true;
    }
  );

  assert.equal(attemptedPaths.includes(failingPath), true);
  assert.equal(
    attemptedPaths.some(targetPath => targetPath.includes("Untouched")),
    false
  );
  assert.deepEqual(deletedStates, []);
});

test("deleteAlbumsFromFolder treats a missing album-state delete as failure", async () => {
  const attemptedStates: string[] = [];
  const dependencies = createDependencies({
    deleteAlbumState: albumName => {
      attemptedStates.push(albumName);
      return false;
    },
  });

  await assert.rejects(
    deleteAlbumsFromFolder(
      [{ name: "Stale" }, { name: "Untouched" }],
      directories,
      dependencies
    ),
    err => {
      assert.ok(err instanceof FolderAlbumDeletionError);
      assert.deepEqual(err.failedAlbums, ["Stale"]);
      assert.match(String(err.cause), /Album state was not deleted/);
      return true;
    }
  );

  assert.deepEqual(attemptedStates, ["Stale"]);
});

test("deleteAlbumsFromFolder aborts and reports a database exception", async () => {
  const attemptedMetadata: string[] = [];
  const failure = new Error("database is locked");
  const dependencies = createDependencies({
    deleteAlbumMetadata: albumName => {
      attemptedMetadata.push(albumName);
      throw failure;
    },
  });

  await assert.rejects(
    deleteAlbumsFromFolder(
      [{ name: "Locked" }, { name: "Untouched" }],
      directories,
      dependencies
    ),
    err => {
      assert.ok(err instanceof FolderAlbumDeletionError);
      assert.deepEqual(err.failedAlbums, ["Locked"]);
      assert.equal(err.cause, failure);
      return true;
    }
  );

  assert.deepEqual(attemptedMetadata, ["Locked"]);
});
