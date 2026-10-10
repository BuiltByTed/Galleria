import fs from "fs";
import path from "path";

export interface PublishedUpload {
  filename: string;
  destPath: string;
}

function filenameForAttempt(
  preferredFilename: string,
  attempt: number
): string {
  if (attempt === 0) {
    return preferredFilename;
  }

  const { name, ext } = path.parse(preferredFilename);
  return `${name} ${attempt + 1}${ext}`;
}

/**
 * Publish a completed staging file without replacing existing album media.
 *
 * The staging file must be on the same filesystem as albumPath. link() creates
 * the destination atomically and fails with EEXIST if another upload claimed
 * the same filename first.
 */
export async function publishUploadWithoutOverwrite(
  stagedPath: string,
  albumPath: string,
  preferredFilename: string
): Promise<PublishedUpload> {
  if (
    path.basename(preferredFilename) !== preferredFilename ||
    !path.extname(preferredFilename)
  ) {
    throw new Error("Upload filename must be a basename with an extension");
  }

  for (let attempt = 0; ; attempt += 1) {
    const filename = filenameForAttempt(preferredFilename, attempt);
    const destPath = path.join(albumPath, filename);

    try {
      await fs.promises.link(stagedPath, destPath);
      return { filename, destPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
}
