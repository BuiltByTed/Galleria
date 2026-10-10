import path from "path";

const OPTIMIZED_SUBDIRECTORIES = ["thumbnail", "modal", "download"] as const;

export interface FolderAlbum {
  name: string;
}

export interface FolderAlbumDirectories {
  photosDir: string;
  optimizedDir: string;
  videoDir?: string | null;
}

export interface FolderAlbumDeletionDependencies {
  pathExists(targetPath: string): boolean;
  removeDirectory(targetPath: string): void;
  cancelShareLinkTimers(albumName: string): Promise<void>;
  deleteAlbumMetadata(albumName: string): void;
  deleteAlbumState(albumName: string): boolean;
  onVideoDirectoryDeleted?(albumName: string): void;
  onAlbumDeleted?(albumName: string): void;
}

export class FolderAlbumDeletionError extends Error {
  readonly failedAlbums: string[];
  readonly cause: unknown;

  constructor(albumName: string, cause: unknown) {
    super(`Failed to delete album "${albumName}"`);
    this.name = "FolderAlbumDeletionError";
    this.failedAlbums = [albumName];
    this.cause = cause;
  }
}

/**
 * Deletes each album completely, stopping at the first failure so the caller
 * can preserve the containing folder and return a non-success response.
 */
export async function deleteAlbumsFromFolder(
  albums: FolderAlbum[],
  directories: FolderAlbumDirectories,
  dependencies: FolderAlbumDeletionDependencies
): Promise<void> {
  const {
    photosDir,
    optimizedDir,
    videoDir,
  } = directories;

  for (const album of albums) {
    try {
      const albumPath = path.join(photosDir, album.name);
      if (dependencies.pathExists(albumPath)) {
        dependencies.removeDirectory(albumPath);
      }

      for (const subdirectory of OPTIMIZED_SUBDIRECTORIES) {
        const optimizedPath = path.join(
          optimizedDir,
          subdirectory,
          album.name
        );
        if (dependencies.pathExists(optimizedPath)) {
          dependencies.removeDirectory(optimizedPath);
        }
      }

      if (videoDir) {
        const videoPath = path.join(videoDir, album.name);
        if (dependencies.pathExists(videoPath)) {
          dependencies.removeDirectory(videoPath);
          dependencies.onVideoDirectoryDeleted?.(album.name);
        }
      }

      await dependencies.cancelShareLinkTimers(album.name);
      dependencies.deleteAlbumMetadata(album.name);

      if (!dependencies.deleteAlbumState(album.name)) {
        throw new Error("Album state was not deleted");
      }

      dependencies.onAlbumDeleted?.(album.name);
    } catch (cause) {
      throw new FolderAlbumDeletionError(album.name, cause);
    }
  }
}
