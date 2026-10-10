/**
 * On-disk cleanup for album media deleted via the management API.
 * Videos leave HLS under videoDir and .jpg posters under optimized — not
 * the same filename as the original .mp4.
 */

import fs from "fs";
import path from "path";

const OPTIMIZED_SUBDIRS = ["thumbnail", "modal", "download"] as const;

export function isVideoFilename(filename: string): boolean {
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(filename);
}

export function videoPosterFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, ".jpg");
}

export interface MediaDiskCleanupOptions {
  photosDir: string;
  optimizedDir: string;
  /** When set, removes HLS tree videoDir/<album>/<filename>/ for videos */
  videoDir?: string | null;
  album: string;
  filename: string;
}

export interface MediaDiskCleanupResult {
  originalDeleted: boolean;
  optimizedRemoved: string[];
  hlsRemoved: boolean;
  posterRemoved: string[];
}

/**
 * Unlink the original file, same-name optimized variants, and (for videos)
 * the HLS directory tree plus basename.jpg poster files.
 * Throws if the original is missing (caller should 404 first) only when
 * deleteOriginal is true and the path does not exist — callers may pass
 * deleteOriginal: false after they already unlinked.
 */
export function removeMediaDiskAssets(
  options: MediaDiskCleanupOptions & { deleteOriginal?: boolean }
): MediaDiskCleanupResult {
  const {
    photosDir,
    optimizedDir,
    videoDir,
    album,
    filename,
    deleteOriginal = true,
  } = options;

  const result: MediaDiskCleanupResult = {
    originalDeleted: false,
    optimizedRemoved: [],
    hlsRemoved: false,
    posterRemoved: [],
  };

  if (deleteOriginal) {
    const photoPath = path.join(photosDir, album, filename);
    if (fs.existsSync(photoPath)) {
      fs.unlinkSync(photoPath);
      result.originalDeleted = true;
    }
  }

  for (const dir of OPTIMIZED_SUBDIRS) {
    const optimizedPath = path.join(optimizedDir, dir, album, filename);
    if (fs.existsSync(optimizedPath)) {
      fs.unlinkSync(optimizedPath);
      result.optimizedRemoved.push(path.join(dir, filename));
    }
  }

  if (!isVideoFilename(filename)) {
    return result;
  }

  if (videoDir) {
    const hlsPath = path.join(videoDir, album, filename);
    if (fs.existsSync(hlsPath)) {
      fs.rmSync(hlsPath, { recursive: true, force: true });
      result.hlsRemoved = true;
    }
  }

  const posterName = videoPosterFilename(filename);
  for (const dir of OPTIMIZED_SUBDIRS) {
    const posterPath = path.join(optimizedDir, dir, album, posterName);
    if (fs.existsSync(posterPath)) {
      fs.unlinkSync(posterPath);
      result.posterRemoved.push(path.join(dir, posterName));
    }
  }

  return result;
}
