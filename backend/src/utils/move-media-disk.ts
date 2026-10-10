/**
 * On-disk move for album media (photo or video) between albums.
 * Mirrors removeMediaDiskAssets paths: original, optimized same-name,
 * and for videos HLS tree + basename.jpg posters.
 */

import fs from "fs";
import path from "path";
import {
  isVideoFilename,
  videoPosterFilename,
} from "./media-disk-cleanup.js";
import { rollbackRenamedPaths, type RenamedPath } from "./rename-rollback.js";
import { error } from "./logger.js";

const OPTIMIZED_SUBDIRS = ["thumbnail", "modal", "download"] as const;

export interface MoveMediaDiskOptions {
  photosDir: string;
  optimizedDir: string;
  videoDir?: string | null;
  fromAlbum: string;
  toAlbum: string;
  filename: string;
}

export interface MoveMediaDiskResult {
  movedPaths: RenamedPath[];
  originalMoved: boolean;
  optimizedMoved: string[];
  hlsMoved: boolean;
  posterMoved: string[];
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function renameTracked(
  from: string,
  to: string,
  moved: RenamedPath[]
): void {
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
  moved.push({ from, to });
}

/**
 * Move original + optimized (+ video HLS/posters) from one album folder to another.
 * Throws if the original is missing or the destination original already exists.
 * On mid-sequence failure, rolls back successful renames.
 */
export function moveMediaDiskAssets(
  options: MoveMediaDiskOptions
): MoveMediaDiskResult {
  const {
    photosDir,
    optimizedDir,
    videoDir,
    fromAlbum,
    toAlbum,
    filename,
  } = options;

  const movedPaths: RenamedPath[] = [];
  const result: MoveMediaDiskResult = {
    movedPaths,
    originalMoved: false,
    optimizedMoved: [],
    hlsMoved: false,
    posterMoved: [],
  };

  const sourceOriginal = path.join(photosDir, fromAlbum, filename);
  const destOriginal = path.join(photosDir, toAlbum, filename);

  if (!fs.existsSync(sourceOriginal)) {
    throw new Error(`Source media not found: ${fromAlbum}/${filename}`);
  }
  if (fs.existsSync(destOriginal)) {
    throw new Error(`Destination already has file: ${toAlbum}/${filename}`);
  }

  try {
    // Original
    renameTracked(sourceOriginal, destOriginal, movedPaths);
    result.originalMoved = true;

    // Same-name optimized variants
    for (const dir of OPTIMIZED_SUBDIRS) {
      const fromPath = path.join(optimizedDir, dir, fromAlbum, filename);
      if (!fs.existsSync(fromPath)) continue;
      const toPath = path.join(optimizedDir, dir, toAlbum, filename);
      if (fs.existsSync(toPath)) {
        throw new Error(
          `Destination optimized already exists: ${dir}/${toAlbum}/${filename}`
        );
      }
      renameTracked(fromPath, toPath, movedPaths);
      result.optimizedMoved.push(path.join(dir, filename));
    }

    if (!isVideoFilename(filename)) {
      return result;
    }

    // HLS tree: videoDir/<album>/<filename>/
    if (videoDir) {
      const fromHls = path.join(videoDir, fromAlbum, filename);
      if (fs.existsSync(fromHls)) {
        const toHls = path.join(videoDir, toAlbum, filename);
        if (fs.existsSync(toHls)) {
          throw new Error(
            `Destination HLS already exists: ${toAlbum}/${filename}`
          );
        }
        ensureDir(path.dirname(toHls));
        renameTracked(fromHls, toHls, movedPaths);
        result.hlsMoved = true;
      }
    }

    // Video posters: optimized/*/<album>/<basename>.jpg
    const posterName = videoPosterFilename(filename);
    for (const dir of OPTIMIZED_SUBDIRS) {
      const fromPoster = path.join(optimizedDir, dir, fromAlbum, posterName);
      if (!fs.existsSync(fromPoster)) continue;
      const toPoster = path.join(optimizedDir, dir, toAlbum, posterName);
      if (fs.existsSync(toPoster)) {
        throw new Error(
          `Destination poster already exists: ${dir}/${toAlbum}/${posterName}`
        );
      }
      renameTracked(fromPoster, toPoster, movedPaths);
      result.posterMoved.push(path.join(dir, posterName));
    }

    return result;
  } catch (err) {
    error(
      `[MoveMedia] Rolling back after failure moving ${fromAlbum}/${filename} → ${toAlbum}:`,
      err
    );
    rollbackRenamedPaths(movedPaths);
    throw err;
  }
}
