/**
 * SQLite Database Module
 * Manages image metadata including AI-generated titles and descriptions
 */

import { createRequire } from 'module';
import { DB_PATH } from './config.js';
import { info, warn, error } from './utils/logger.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let db: any = null;

/**
 * Initialize the database and create tables if they don't exist
 */
export function initializeDatabase(): any {
  if (db) {
    return db;
  }

  db = new Database(DB_PATH);
  
  // Performance optimizations
  db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
  db.pragma('synchronous = NORMAL'); // Faster writes, still safe
  db.pragma('cache_size = -64000'); // 64MB cache (negative = KB)
  db.pragma('temp_store = MEMORY'); // Store temp tables in memory
  db.pragma('mmap_size = 30000000000'); // 30GB memory-mapped I/O
  db.pragma('page_size = 4096'); // Optimize page size
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Create albums table
  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      published BOOLEAN NOT NULL DEFAULT 0,
      show_on_homepage BOOLEAN NOT NULL DEFAULT 0,
      downloads_enabled BOOLEAN NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Create album_folders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS album_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      published BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Create image_metadata table
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album TEXT NOT NULL,
      filename TEXT NOT NULL,
      title TEXT,
      description TEXT,
      media_type TEXT NOT NULL DEFAULT 'photo',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(album, filename)
    )
  `);
  
  // Create index for faster lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_album_filename 
    ON image_metadata(album, filename)
  `);
  
  // Add sort_order column if it doesn't exist (migration)
  try {
    const tableInfo = db.pragma('table_info(image_metadata)');
    const hasSortOrder = tableInfo.some((col: any) => col.name === 'sort_order');
    if (!hasSortOrder) {
      info('[Database] Adding sort_order column to image_metadata...');
      db.exec('ALTER TABLE image_metadata ADD COLUMN sort_order INTEGER');
    }
  } catch (err) {
    warn('[Database] Could not check/add sort_order column:', err);
  }

  // Add media_type column if it doesn't exist (migration)
  try {
    const tableInfo = db.pragma('table_info(image_metadata)');
    const hasMediaType = tableInfo.some((col: any) => col.name === 'media_type');
    if (!hasMediaType) {
      info('[Database] Adding media_type column to image_metadata...');
      db.exec("ALTER TABLE image_metadata ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo'");
      
      // Fix existing video records (detect by file extension)
      const videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv', '.wmv'];
      const allRecords = db.prepare('SELECT id, filename FROM image_metadata').all() as Array<{ id: number, filename: string }>;
      
      let videoCount = 0;
      const updateStmt = db.prepare('UPDATE image_metadata SET media_type = ? WHERE id = ?');
      
      for (const record of allRecords) {
        const ext = record.filename.substring(record.filename.lastIndexOf('.')).toLowerCase();
        if (videoExtensions.includes(ext)) {
          updateStmt.run('video', record.id);
          videoCount++;
        }
      }
      
      if (videoCount > 0) {
        info(`[Database] Updated ${videoCount} existing video records to media_type='video'`);
      }
      
      info('[Database] Successfully added media_type column');
    }
  } catch (err) {
    warn('[Database] Could not check/add media_type column:', err);
  }
  
  // Add sort_order column to albums if it doesn't exist (migration)
  try {
    const tableInfo = db.pragma('table_info(albums)');
    const hasSortOrder = tableInfo.some((col: any) => col.name === 'sort_order');
    if (!hasSortOrder) {
      info('[Database] Adding sort_order column to albums...');
      db.exec('ALTER TABLE albums ADD COLUMN sort_order INTEGER');
    }
  } catch (err) {
    warn('[Database] Could not check/add sort_order column to albums:', err);
  }

  // Add downloads_enabled column to albums if it doesn't exist (migration)
  try {
    const tableInfo = db.pragma('table_info(albums)');
    const hasDownloadsEnabled = tableInfo.some((col: any) => col.name === 'downloads_enabled');
    if (!hasDownloadsEnabled) {
      info('[Database] Adding downloads_enabled column to albums...');
      db.exec('ALTER TABLE albums ADD COLUMN downloads_enabled BOOLEAN NOT NULL DEFAULT 1');
    }
  } catch (err) {
    warn('[Database] Could not check/add downloads_enabled column to albums:', err);
  }
  
  // Add sort_order column to album_folders if it doesn't exist (migration)
  try {
    const tableInfo = db.pragma('table_info(album_folders)');
    const hasSortOrder = tableInfo.some((col: any) => col.name === 'sort_order');
    if (!hasSortOrder) {
      info('[Database] Adding sort_order column to album_folders...');
      db.exec('ALTER TABLE album_folders ADD COLUMN sort_order INTEGER');
    }
  } catch (err) {
    warn('[Database] Could not check/add sort_order column to album_folders:', err);
  }
  
  // Add folder_id column to albums if it doesn't exist (migration)
  try {
    const tableInfo = db.pragma('table_info(albums)');
    const hasFolderId = tableInfo.some((col: any) => col.name === 'folder_id');
    if (!hasFolderId) {
      info('[Database] Adding folder_id column to albums...');
      db.exec('ALTER TABLE albums ADD COLUMN folder_id INTEGER REFERENCES album_folders(id) ON DELETE SET NULL');
    }
  } catch (err) {
    warn('[Database] Could not check/add folder_id column to albums:', err);
  }
  
  // Create share_links table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album TEXT NOT NULL,
      secret_key TEXT NOT NULL UNIQUE,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notified INTEGER DEFAULT 0,
      FOREIGN KEY (album) REFERENCES albums(name) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  
  // Add notified column to share_links if it doesn't exist (migration)
  try {
    const shareLinksTableInfo = db.pragma('table_info(share_links)');
    const hasNotifiedColumn = shareLinksTableInfo.some((col: any) => col.name === 'notified');
    if (!hasNotifiedColumn) {
      info('[Database] Adding notified column to share_links...');
      db.exec('ALTER TABLE share_links ADD COLUMN notified INTEGER DEFAULT 0');
    }
  } catch (err) {
    warn('[Database] Could not check/add notified column to share_links:', err);
  }
  
  // Create album_view_counts table for milestone tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS album_view_counts (
      album TEXT PRIMARY KEY,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_milestone INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (album) REFERENCES albums(name) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  
  // Create index for share links
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_share_links_secret 
    ON share_links(secret_key)
  `);
  
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_share_links_album 
    ON share_links(album)
  `);
  
  info('[Database] SQLite database initialized at:', DB_PATH);
  info('[Database] WAL mode enabled for better performance');
  info('[Database] All tables and migrations applied');
  
  return db;
}

/**
 * Get the database instance
 */
export function getDatabase(): any {
  if (!db) {
    return initializeDatabase();
  }
  return db;
}

/**
 * Save or update image metadata
 */
export function saveImageMetadata(
  album: string,
  filename: string,
  title: string | null,
  description: string | null,
  mediaType: 'photo' | 'video' = 'photo'
): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO image_metadata (album, filename, title, description, media_type)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(album, filename) 
    DO UPDATE SET 
      title = excluded.title,
      description = excluded.description,
      media_type = excluded.media_type,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(album, filename, title, description, mediaType);
}

/**
 * Get image metadata by album and filename
 */
export function getImageMetadata(album: string, filename: string): {
  id: number;
  album: string;
  filename: string;
  title: string | null;
  description: string | null;
  media_type: 'photo' | 'video';
  created_at: string;
  updated_at: string;
} | undefined {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM image_metadata 
    WHERE album = ? AND filename = ?
  `);
  
  return stmt.get(album, filename) as any;
}

/**
 * Get all image metadata for an album
 */
export function getAlbumMetadata(album: string): Array<{
  id: number;
  album: string;
  filename: string;
  title: string | null;
  description: string | null;
  media_type: 'photo' | 'video';
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM image_metadata 
    WHERE album = ?
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      filename ASC
  `);
  
  return stmt.all(album) as any[];
}

/**
 * Get all image metadata
 */
export function getAllMetadata(): Array<{
  id: number;
  album: string;
  filename: string;
  title: string | null;
  description: string | null;
  media_type: 'photo' | 'video';
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM image_metadata 
    ORDER BY album, filename
  `);
  
  return stmt.all() as any[];
}

/**
 * Update image metadata
 */
export function updateImageMetadata(
  album: string,
  filename: string,
  title: string | null,
  description: string | null
): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE image_metadata 
    SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP
    WHERE album = ? AND filename = ?
  `);
  
  const result = stmt.run(title, description, album, filename);
  return result.changes > 0;
}

/**
 * Delete image metadata
 */
export function deleteImageMetadata(album: string, filename: string): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM image_metadata 
    WHERE album = ? AND filename = ?
  `);
  
  const result = stmt.run(album, filename);
  return result.changes > 0;
}

/**
 * Move image metadata from one album to another (keeps title/description/media_type).
 * Assigns sort_order at the end of the destination album when not provided.
 * Returns false if source row missing or destination already has the filename.
 */
export function moveImageMetadata(
  fromAlbum: string,
  toAlbum: string,
  filename: string,
  sortOrder?: number
): boolean {
  const db = getDatabase();

  try {
    const transaction = db.transaction(() => {
      const destExists = db
        .prepare(
          "SELECT id FROM image_metadata WHERE album = ? AND filename = ?"
        )
        .get(toAlbum, filename);
      if (destExists) {
        throw new Error("DESTINATION_EXISTS");
      }

      const source = db
        .prepare(
          "SELECT id FROM image_metadata WHERE album = ? AND filename = ?"
        )
        .get(fromAlbum, filename) as { id: number } | undefined;
      if (!source) {
        throw new Error("SOURCE_MISSING");
      }

      let nextSort = sortOrder;
      if (nextSort === undefined || nextSort === null) {
        const maxRow = db
          .prepare(
            "SELECT MAX(sort_order) as max_sort FROM image_metadata WHERE album = ?"
          )
          .get(toAlbum) as { max_sort: number | null };
        nextSort =
          maxRow?.max_sort !== null && maxRow?.max_sort !== undefined
            ? maxRow.max_sort + 1
            : 0;
      }

      const result = db
        .prepare(
          `UPDATE image_metadata
           SET album = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
           WHERE album = ? AND filename = ?`
        )
        .run(toAlbum, nextSort, fromAlbum, filename);

      if (result.changes === 0) {
        throw new Error("SOURCE_MISSING");
      }
    });

    transaction();
    return true;
  } catch (err: any) {
    if (err?.message === "DESTINATION_EXISTS" || err?.message === "SOURCE_MISSING") {
      return false;
    }
    error("[Database] Failed to move image metadata:", err);
    return false;
  }
}

/**
 * Delete all image metadata for an album
 */
export function deleteAlbumMetadata(album: string): number {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM image_metadata 
    WHERE album = ?
  `);
  
  const result = stmt.run(album);
  return result.changes;
}

/**
 * Create or update an album in the database
 */
export function saveAlbum(name: string, published: boolean = false): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO albums (name, published, show_on_homepage, downloads_enabled)
    VALUES (?, ?, 0, 1)
    ON CONFLICT(name) 
    DO UPDATE SET 
      published = excluded.published,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(name, published ? 1 : 0);
}

/**
 * Get album state by name
 */
export function getAlbumState(name: string): {
  id: number;
  name: string;
  published: boolean;
  show_on_homepage: boolean;
  downloads_enabled: boolean;
  created_at: string;
  updated_at: string;
} | undefined {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM albums 
    WHERE name = ?
  `);
  
  const result = stmt.get(name) as any;
  if (result) {
    result.published = Boolean(result.published);
    result.show_on_homepage = Boolean(result.show_on_homepage);
    result.downloads_enabled = Boolean(result.downloads_enabled);
  }
  return result;
}

/**
 * Get all albums with their published state
 */
export function getAllAlbums(): Array<{
  id: number;
  name: string;
  published: boolean;
  show_on_homepage: boolean;
  downloads_enabled: boolean;
  folder_id: number | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM albums 
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      name ASC
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    published: Boolean(result.published),
    show_on_homepage: Boolean(result.show_on_homepage),
    downloads_enabled: Boolean(result.downloads_enabled),
    folder_id: result.folder_id ?? null
  }));
}

/**
 * Get only published albums
 */
export function getPublishedAlbums(): Array<{
  id: number;
  name: string;
  published: boolean;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM albums 
    WHERE published = 1
    ORDER BY name
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    published: Boolean(result.published)
  }));
}

/**
 * Toggle album published state
 */
export function toggleAlbumPublished(name: string): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE albums 
    SET published = NOT published, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);
  
  const result = stmt.run(name);
  return result.changes > 0;
}

/**
 * Set album published state
 */
export function setAlbumPublished(name: string, published: boolean): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE albums 
    SET published = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);
  
  const result = stmt.run(published ? 1 : 0, name);
  return result.changes > 0;
}

/**
 * Set album show_on_homepage state
 */
export function setAlbumShowOnHomepage(name: string, showOnHomepage: boolean): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE albums 
    SET show_on_homepage = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);
  
  const result = stmt.run(showOnHomepage ? 1 : 0, name);
  return result.changes > 0;
}

/**
 * Set album visibility and download state
 */
export function setAlbumVisibility(
  name: string,
  visibility: {
    published: boolean;
    show_on_homepage: boolean;
    downloads_enabled: boolean;
  }
): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE albums
    SET published = ?, show_on_homepage = ?, downloads_enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);

  const result = stmt.run(
    visibility.published ? 1 : 0,
    visibility.show_on_homepage ? 1 : 0,
    visibility.downloads_enabled ? 1 : 0,
    name
  );
  return result.changes > 0;
}

/**
 * Set album downloads enabled state
 */
export function setAlbumDownloadsEnabled(name: string, downloadsEnabled: boolean): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE albums
    SET downloads_enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);

  const result = stmt.run(downloadsEnabled ? 1 : 0, name);
  return result.changes > 0;
}

/**
 * Delete an album from the database
 */
export function deleteAlbumState(name: string): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM albums 
    WHERE name = ?
  `);
  
  const result = stmt.run(name);
  return result.changes > 0;
}

/**
 * Rename an album (updates albums table, image_metadata, and share_links via CASCADE)
 */
export function renameAlbum(oldName: string, newName: string): boolean {
  const db = getDatabase();
  
  try {
    // Use a transaction to ensure atomicity
    const transaction = db.transaction(() => {
      // Update image_metadata entries
      const metadataStmt = db.prepare(`
        UPDATE image_metadata 
        SET album = ? 
        WHERE album = ?
      `);
      metadataStmt.run(newName, oldName);
      
      // Update albums table (share_links will auto-update via ON UPDATE CASCADE)
      const albumStmt = db.prepare(`
        UPDATE albums 
        SET name = ? 
        WHERE name = ?
      `);
      albumStmt.run(newName, oldName);
    });
    
    transaction();
    return true;
  } catch (err) {
    error('[Database] Failed to rename album:', err);
    return false;
  }
}

/**
 * Update sort order for multiple images in an album
 */
export function updateImageSortOrder(album: string, imageOrders: { filename: string; sort_order: number }[]): boolean {
  const db = getDatabase();
  
  try {
    // First, let's see what's actually in the database for this album
    const dbImages = db.prepare('SELECT filename FROM image_metadata WHERE album = ?').all(album) as Array<{ filename: string }>;
    info(`[Database] Images in DB for ${album}:`, dbImages.map(i => i.filename).join(', '));
    info(`[Database] Trying to update:`, imageOrders.map(i => i.filename).join(', '));
    
    // Use a transaction for atomic updates
    // IMPORTANT: Only UPDATE existing entries, do not INSERT new ones
    // This prevents recreating duplicate entries after cleanup
    const transaction = db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE image_metadata 
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE album = ? AND filename = ?
      `);
      
      let updatedCount = 0;
      let notFoundCount = 0;
      
      for (const { filename, sort_order } of imageOrders) {
        const result = stmt.run(sort_order, album, filename);
        if (result.changes > 0) {
          updatedCount++;
        } else {
          notFoundCount++;
          error(`[Database] Image not found for update: ${album}/${filename}`);
        }
      }
      
      info(`[Database] Updated ${updatedCount} images, ${notFoundCount} not found`);
    });
    
    transaction();
    return true;
  } catch (err) {
    error('[Database] Failed to update image sort order:', err);
    return false;
  }
}

/**
 * Get all distinct album names from image_metadata
 */
export function getAlbumsFromMetadata(): string[] {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT DISTINCT album FROM image_metadata 
    ORDER BY album
  `);
  
  const results = stmt.all() as Array<{ album: string }>;
  return results.map(r => r.album);
}

/**
 * Get all images from image_metadata for a specific album
 */
export function getImagesInAlbum(album: string): Array<{
  id: number;
  album: string;
  filename: string;
  title: string | null;
  description: string | null;
  media_type: 'photo' | 'video';
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM image_metadata 
    WHERE album = ?
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      filename ASC
  `);
  
  return stmt.all(album) as any[];
}

/**
 * Get all images from published albums
 */
export function getImagesFromPublishedAlbums(): Array<{
  id: number;
  album: string;
  filename: string;
  title: string | null;
  description: string | null;
  media_type: 'photo' | 'video';
  downloads_enabled: boolean;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT im.*, a.downloads_enabled AS downloads_enabled FROM image_metadata im
    INNER JOIN albums a ON im.album = a.name
    WHERE a.published = 1
    ORDER BY im.album, im.filename
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    downloads_enabled: Boolean(result.downloads_enabled)
  }));
}

/**
 * Get all images from albums that should be shown on homepage
 */
export function getImagesForHomepage(): Array<{
  id: number;
  album: string;
  filename: string;
  title: string | null;
  description: string | null;
  media_type: 'photo' | 'video';
  downloads_enabled: boolean;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT im.*, a.downloads_enabled AS downloads_enabled FROM image_metadata im
    INNER JOIN albums a ON im.album = a.name
    WHERE a.published = 1 AND a.show_on_homepage = 1
    ORDER BY a.sort_order, a.name, im.sort_order, im.filename
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    downloads_enabled: Boolean(result.downloads_enabled)
  }));
}

/**
 * Get count of images in an album
 */
export function getImageCountInAlbum(album: string): number {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM image_metadata 
    WHERE album = ?
  `);
  
  const result = stmt.get(album) as { count: number };
  return result.count;
}

/**
 * Check if image exists in database
 */
export function imageExistsInDB(album: string, filename: string): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT 1 FROM image_metadata 
    WHERE album = ? AND filename = ?
  `);
  
  return stmt.get(album, filename) !== undefined;
}

/**
 * Update sort order for multiple albums
 */
export function updateAlbumSortOrder(albumOrders: { name: string; sort_order: number }[]): boolean {
  const db = getDatabase();
  
  try {
    // Use a transaction for atomic updates
    const transaction = db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE albums 
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE name = ?
      `);
      
      for (const { name, sort_order } of albumOrders) {
        stmt.run(sort_order, name);
      }
    });
    
    transaction();
    return true;
  } catch (err) {
    error('[Database] Failed to update album sort order:', err);
    return false;
  }
}

/**
 * Create a share link for an album
 */
export function createShareLink(album: string, expiresAt: string | null): {
  id: number;
  album: string;
  secret_key: string;
  expires_at: string | null;
  created_at: string;
} {
  const db = getDatabase();
  
  // Generate a secure random secret key (32 bytes = 64 hex characters)
  const crypto = require('crypto');
  const secretKey = crypto.randomBytes(32).toString('hex');
  
  const stmt = db.prepare(`
    INSERT INTO share_links (album, secret_key, expires_at)
    VALUES (?, ?, ?)
  `);
  
  const result = stmt.run(album, secretKey, expiresAt);
  
  // Return the created share link
  const getStmt = db.prepare(`
    SELECT * FROM share_links WHERE id = ?
  `);
  
  return getStmt.get(result.lastInsertRowid) as any;
}

/**
 * Get share link by secret key
 */
export function getShareLinkBySecret(secretKey: string): {
  id: number;
  album: string;
  secret_key: string;
  expires_at: string | null;
  created_at: string;
} | undefined {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM share_links 
    WHERE secret_key = ?
  `);
  
  return stmt.get(secretKey) as any;
}

/**
 * Check if a share link is expired
 */
export function isShareLinkExpired(shareLink: { expires_at: string | null }): boolean {
  // If expires_at is null, link never expires
  if (!shareLink.expires_at) {
    return false;
  }
  
  const now = new Date();
  const expiresAt = new Date(shareLink.expires_at);
  
  return now > expiresAt;
}

/**
 * Delete a share link by ID
 */
export function deleteShareLink(id: number): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM share_links 
    WHERE id = ?
  `);
  
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Delete all share links for an album
 */
export function deleteShareLinksForAlbum(album: string): number {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM share_links 
    WHERE album = ?
  `);
  
  const result = stmt.run(album);
  return result.changes;
}

/**
 * Get all share links for an album
 */
export function getShareLinksForAlbum(album: string): Array<{
  id: number;
  album: string;
  secret_key: string;
  expires_at: string | null;
  created_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM share_links 
    WHERE album = ?
    ORDER BY created_at DESC
  `);
  
  return stmt.all(album) as any[];
}

/**
 * Delete expired share links (cleanup function)
 */
export function deleteExpiredShareLinks(): number {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM share_links 
    WHERE expires_at IS NOT NULL 
    AND expires_at < datetime('now')
  `);
  
  const result = stmt.run();
  return result.changes;
}

/**
 * Create or update an album folder in the database
 */
export function saveAlbumFolder(name: string, published: boolean = false): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO album_folders (name, published)
    VALUES (?, ?)
    ON CONFLICT(name) 
    DO UPDATE SET 
      published = excluded.published,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(name, published ? 1 : 0);
}

/**
 * Get folder state by name
 */
export function getFolderState(name: string): {
  id: number;
  name: string;
  published: boolean;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
} | undefined {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM album_folders 
    WHERE name = ?
  `);
  
  const result = stmt.get(name) as any;
  if (result) {
    result.published = Boolean(result.published);
  }
  return result;
}

/**
 * Get all album folders with their published state
 */
export function getAllFolders(): Array<{
  id: number;
  name: string;
  published: boolean;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM album_folders 
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      name ASC
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    published: Boolean(result.published)
  }));
}

/**
 * Get only published folders
 */
export function getPublishedFolders(): Array<{
  id: number;
  name: string;
  published: boolean;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM album_folders 
    WHERE published = 1
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      name ASC
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    published: Boolean(result.published)
  }));
}

/**
 * Set folder published state
 */
export function setFolderPublished(name: string, published: boolean): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE album_folders 
    SET published = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);
  
  const result = stmt.run(published ? 1 : 0, name);
  return result.changes > 0;
}

/**
 * Delete a folder from the database
 * Note: This will set folder_id to NULL for all albums in this folder
 */
export function deleteFolderState(name: string): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM album_folders 
    WHERE name = ?
  `);
  
  const result = stmt.run(name);
  return result.changes > 0;
}

/**
 * Get albums in a specific folder
 */
export function getAlbumsInFolder(folderId: number): Array<{
  id: number;
  name: string;
  published: boolean;
  show_on_homepage: boolean;
  downloads_enabled: boolean;
  folder_id: number | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM albums 
    WHERE folder_id = ?
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      name ASC
  `);
  
  const results = stmt.all(folderId) as any[];
  return results.map(result => ({
    ...result,
    published: Boolean(result.published),
    show_on_homepage: Boolean(result.show_on_homepage),
    downloads_enabled: Boolean(result.downloads_enabled),
    folder_id: result.folder_id ?? null
  }));
}

/**
 * Get albums not in any folder
 */
export function getAlbumsWithoutFolder(): Array<{
  id: number;
  name: string;
  published: boolean;
  show_on_homepage: boolean;
  downloads_enabled: boolean;
  folder_id: number | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM albums 
    WHERE folder_id IS NULL
    ORDER BY 
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
      sort_order ASC,
      name ASC
  `);
  
  const results = stmt.all() as any[];
  return results.map(result => ({
    ...result,
    published: Boolean(result.published),
    show_on_homepage: Boolean(result.show_on_homepage),
    downloads_enabled: Boolean(result.downloads_enabled),
    folder_id: null
  }));
}

/**
 * Set album's folder
 */
export function setAlbumFolder(albumName: string, folderId: number | null): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE albums 
    SET folder_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `);
  
  const result = stmt.run(folderId, albumName);
  return result.changes > 0;
}

/**
 * Update sort order for multiple folders
 */
export function updateFolderSortOrder(folderOrders: { name: string; sort_order: number }[]): boolean {
  const db = getDatabase();
  
  try {
    // Use a transaction for atomic updates
    const transaction = db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE album_folders 
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE name = ?
      `);
      
      for (const { name, sort_order } of folderOrders) {
        stmt.run(sort_order, name);
      }
    });
    
    transaction();
    return true;
  } catch (err) {
    error('[Database] Failed to update folder sort order:', err);
    return false;
  }
}

/**
 * Increment view count for an album (for milestone tracking)
 */
export function incrementAlbumViewCount(album: string): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO album_view_counts (album, view_count, updated_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(album)
    DO UPDATE SET 
      view_count = view_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(album);
}

/**
 * Get all album view counts
 */
export function getAllAlbumViewCounts(): Map<string, { views: number, lastMilestone: number }> {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT album, view_count, last_milestone
    FROM album_view_counts
    ORDER BY view_count DESC
  `);
  
  const results = stmt.all() as Array<{ album: string, view_count: number, last_milestone: number }>;
  const viewCounts = new Map<string, { views: number, lastMilestone: number }>();
  
  for (const row of results) {
    viewCounts.set(row.album, {
      views: row.view_count,
      lastMilestone: row.last_milestone
    });
  }
  
  return viewCounts;
}

/**
 * Update last milestone reached for an album
 */
export function updateAlbumMilestone(album: string, milestone: number): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE album_view_counts
    SET last_milestone = ?, updated_at = CURRENT_TIMESTAMP
    WHERE album = ?
  `);
  
  stmt.run(milestone, album);
}


/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    info('[Database] Database connection closed');
  }
}
