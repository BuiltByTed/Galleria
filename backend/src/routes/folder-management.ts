/**
 * Album Folder Management Routes
 * Authenticated routes for creating, deleting, and managing album folders
 */

import { Router, Request, Response } from "express";
import { csrfProtection } from "../security.js";
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { getAllUsers } from '../database-users.js';
import { 
  saveAlbumFolder,
  deleteFolderState,
  setFolderPublished,
  getAllFolders,
  getFolderState,
  setAlbumFolder,
  setAlbumPublished,
  getAlbumsInFolder,
  updateFolderSortOrder,
  deleteAlbumMetadata,
  deleteAlbumState
} from "../database.js";
import { generateStaticJSONFiles } from "./static-json.js";
import fs from "fs";
import { requireAuth, requireAdmin, requireManager } from '../auth/middleware.js';
import {
  deleteAlbumsFromFolder,
  FolderAlbumDeletionError,
} from "../utils/folder-album-deletion.js";

const router = Router();

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

/**
 * Helper to send push notification to all admin users
 */
async function notifyAllAdmins(title: string, body: string, tag: string, notificationType?: any, variables?: Record<string, any>): Promise<void> {
  try {
    const admins = getAllUsers().filter(u => u.role === 'admin');
    for (const admin of admins) {
      const translatedTitle = await translateNotification(title, variables);
      const translatedBody = await translateNotification(body, variables);
      
      sendNotificationToUser(admin.id, {
        title: translatedTitle,
        body: translatedBody,
        tag,
        data: { type: notificationType }
      }, notificationType);
    }
  } catch (err) {
    error('[FolderManagement] Failed to send notification to admins:', err);
  }
}

/**
 * Sanitize folder name - allows letters, numbers, spaces, hyphens, and underscores
 */
const sanitizeName = (name: string): string | null => {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return null;
  }
  // Allow alphanumeric characters, spaces, hyphens, and underscores
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
    return null;
  }
  return name.trim();
};

/**
 * Get all folders (admin only)
 */
router.get("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const folders = getAllFolders();
    res.json(folders);
  } catch (err) {
    error('[FolderManagement] Failed to fetch folders:', err);
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

/**
 * Create a new folder
 */
router.post("/", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, published } = req.body;
    
    if (!name) {
      res.status(400).json({ error: 'Folder name is required' });
      return;
    }

    const sanitizedName = sanitizeName(name);
    if (!sanitizedName) {
      res.status(400).json({ error: 'Invalid folder name. Use only letters, numbers, spaces, hyphens, and underscores.' });
      return;
    }

    // Check if folder already exists
    const existing = getFolderState(sanitizedName);
    if (existing) {
      res.status(400).json({ error: 'Folder already exists' });
      return;
    }

    // Create folder in database (unpublished by default unless specified)
    saveAlbumFolder(sanitizedName, published === true);
    info(`[FolderManagement] Created folder: ${sanitizedName} (${published ? 'published' : 'unpublished'})`);

    // Get the newly created folder to return full object
    const newFolder = getFolderState(sanitizedName);
    if (!newFolder) {
      res.status(500).json({ error: 'Failed to retrieve created folder' });
      return;
    }

    // Send push notification to all admins
    const userName = (req.user as any).name || (req.user as any).email;
    await notifyAllAdmins(
      'notifications.backend.folderCreatedTitle',
      'notifications.backend.folderCreatedBody',
      'folder-created',
      'folderCreated',
      {
        folderName: sanitizedName,
        createdBy: userName
      }
    ).catch(err => error('[FolderManagement] Failed to send folder creation notification:', err));

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);

    res.json(newFolder);
  } catch (err) {
    error('[FolderManagement] Failed to create folder:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

/**
 * Delete a folder
 * Query parameter: deleteAlbums=true to also delete all albums in the folder
 * Default behavior: Albums are moved to root level (folder_id set to NULL)
 */
router.delete("/:folder", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { folder } = req.params;
    const deleteAlbums = req.query.deleteAlbums === 'true';
    
    const sanitizedFolder = sanitizeName(folder);
    if (!sanitizedFolder) {
      res.status(400).json({ error: 'Invalid folder name' });
      return;
    }

    // Get folder state to get folder ID
    const folderState = getFolderState(sanitizedFolder);
    if (!folderState) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    // Get albums in folder for notification BEFORE deletion
    const albumsInFolder = getAlbumsInFolder(folderState.id);
    const albumNames = albumsInFolder.map(a => a.name).join(', ') || 'none';

    // If deleteAlbums is true, delete all albums in the folder
    if (deleteAlbums) {
      info(`[FolderManagement] Deleting ${albumsInFolder.length} albums in folder "${sanitizedFolder}"`);
      
      const photosDir = req.app.get('photosDir');
      const optimizedDir = req.app.get('optimizedDir');
      const videoDir = req.app.get('videoDir');

      await deleteAlbumsFromFolder(
        albumsInFolder,
        { photosDir, optimizedDir, videoDir },
        {
          pathExists: targetPath => fs.existsSync(targetPath),
          removeDirectory: targetPath => {
            fs.rmSync(targetPath, { recursive: true, force: true });
          },
          cancelShareLinkTimers: async albumName => {
            const { getShareLinksForAlbum } = await import('../database.js');
            const { cancelShareLinkExpiryTimer } = await import('../services/share-link-expiry-tracker.js');
            const existingLinks = getShareLinksForAlbum(albumName);
            for (const link of existingLinks) {
              cancelShareLinkExpiryTimer(link.id);
            }
          },
          deleteAlbumMetadata,
          deleteAlbumState,
          onVideoDirectoryDeleted: albumName => {
            info(`[FolderManagement] Deleted video directory: ${albumName}`);
          },
          onAlbumDeleted: albumName => {
            info(`[FolderManagement] Deleted album: ${albumName}`);
          },
        }
      );
    }

    // Delete folder state from database
    const folderDeleted = deleteFolderState(sanitizedFolder);
    if (folderDeleted) {
      info(`[FolderManagement] Deleted folder: ${sanitizedFolder}`);
    } else {
      info(`[FolderManagement] Folder not found in database: ${sanitizedFolder}`);
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    // Send push notification to all admins
    const userName = (req.user as any).name || (req.user as any).email;
    
    // Determine the action taken
    let action: string;
    let bodyKey: string;
    if (albumsInFolder.length === 0) {
      action = 'empty';
      bodyKey = 'notifications.backend.folderDeletedBodyEmpty';
    } else if (deleteAlbums) {
      action = 'deleted';
      bodyKey = 'notifications.backend.folderDeletedBodyWithDeleted';
    } else {
      action = 'released';
      bodyKey = 'notifications.backend.folderDeletedBodyWithReleased';
    }
    
    await notifyAllAdmins(
      'notifications.backend.folderDeletedTitle',
      bodyKey,
      'folder-deleted',
      'folderDeleted',
      {
        folderName: sanitizedFolder,
        deletedBy: userName,
        albumCount: albumsInFolder.length,
        albumNames,
        action
      }
    ).catch(err => error('[FolderManagement] Failed to send folder deletion notification:', err));

    // Note: If deleteAlbums is false, albums will automatically have folder_id set to NULL (ON DELETE SET NULL)

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);

    res.json({ success: true });
  } catch (err) {
    if (err instanceof FolderAlbumDeletionError) {
      error(`[FolderManagement] Failed to delete album ${err.failedAlbums[0]}:`, err.cause);
      res.status(500).json({
        error: 'Failed to delete all albums; folder was not deleted',
        failedAlbums: err.failedAlbums
      });
      return;
    }

    error('[FolderManagement] Failed to delete folder:', err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

/**
 * Toggle folder published state
 */
router.patch("/:folder/publish", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { folder } = req.params;
    const { published } = req.body;
    
    const sanitizedFolder = sanitizeName(folder);
    if (!sanitizedFolder) {
      res.status(400).json({ error: 'Invalid folder name' });
      return;
    }

    if (typeof published !== 'boolean') {
      res.status(400).json({ error: 'Published state must be a boolean' });
      return;
    }

    // Check if folder exists
    const folderState = getFolderState(sanitizedFolder);
    if (!folderState) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }

    // Prevent publishing empty folders
    if (published === true) {
      const albumsInFolder = getAlbumsInFolder(folderState.id);
      if (albumsInFolder.length === 0) {
        res.status(400).json({ error: 'Cannot publish empty folder. Add albums to this folder first.' });
        return;
      }
    }

    // Update folder state
    const success = setFolderPublished(sanitizedFolder, published);
    
    if (!success) {
      res.status(500).json({ error: 'Failed to update folder' });
      return;
    }
    
    info(`[FolderManagement] Set folder "${sanitizedFolder}" published state to: ${published}`);

    // Cascade publish state to all albums in this folder
    const albumsInFolder = getAlbumsInFolder(folderState.id);
    const albumNames = albumsInFolder.map(a => a.name).join(', ') || 'none';
    let albumsUpdated = 0;
    for (const album of albumsInFolder) {
      setAlbumPublished(album.name, published);
      albumsUpdated++;
    }
    info(`[FolderManagement] Updated ${albumsUpdated} album(s) in folder to published=${published}`);

    // Send push notification to all admins
    const userName = (req.user as any).name || (req.user as any).email;
    const titleKey = published ? 'notifications.backend.folderPublishedTitle' : 'notifications.backend.folderUnpublishedTitle';
    const bodyKey = published ? 'notifications.backend.folderPublishedBody' : 'notifications.backend.folderUnpublishedBody';
    const tag = published ? 'folder-published' : 'folder-unpublished';
    const notificationType = published ? 'folderPublished' : 'folderUnpublished';
    const userKey = published ? 'publishedBy' : 'unpublishedBy';
    
    await notifyAllAdmins(
      titleKey,
      bodyKey,
      tag,
      notificationType,
      {
        folderName: sanitizedFolder,
        [userKey]: userName,
        albumCount: albumsInFolder.length,
        albumNames
      }
    ).catch(err => error('[FolderManagement] Failed to send folder publish/unpublish notification:', err));

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);

    res.json({ 
      success: true, 
      folder: sanitizedFolder,
      published,
      albumsUpdated
    });
  } catch (err) {
    error('[FolderManagement] Failed to update folder published state:', err);
    res.status(500).json({ error: 'Failed to update folder published state' });
  }
});

/**
 * Move album to folder (or remove from folder if folderId is null)
 */
router.patch("/:folder/albums/:album", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { folder, album } = req.params;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    let folderId: number | null = null;
    
    // If folder is "none", remove from folder
    if (folder !== 'none') {
      const sanitizedFolder = sanitizeName(folder);
      if (!sanitizedFolder) {
        res.status(400).json({ error: 'Invalid folder name' });
        return;
      }

      // Get folder ID
      const folderState = getFolderState(sanitizedFolder);
      if (!folderState) {
        res.status(404).json({ error: 'Folder not found' });
        return;
      }
      
      folderId = folderState.id;
    }

    // Update album's folder
    const success = setAlbumFolder(sanitizedAlbum, folderId);
    
    if (!success) {
      res.status(500).json({ error: 'Failed to move album' });
      return;
    }
    
    info(`[FolderManagement] Moved album "${sanitizedAlbum}" to folder ${folderId ? folder : 'none'}`);

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);

    res.json({ success: true });
  } catch (err) {
    error('[FolderManagement] Failed to move album to folder:', err);
    res.status(500).json({ error: 'Failed to move album to folder' });
  }
});

/**
 * Update folder sort order
 */
router.put('/sort-order', requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { folderOrders } = req.body;
    
    if (!Array.isArray(folderOrders)) {
      res.status(400).json({ error: 'Invalid folder orders data' });
      return;
    }
    
    // Validate each entry has name and sort_order
    for (const entry of folderOrders) {
      if (typeof entry.name !== 'string' || typeof entry.sort_order !== 'number') {
        res.status(400).json({ error: 'Each folder must have name and sort_order' });
        return;
      }
    }
    
    const success = updateFolderSortOrder(folderOrders);
    
    if (success) {
      info(`[FolderManagement] Updated sort order for ${folderOrders.length} folders`);
      
      // Regenerate static JSON files
      const appRoot = req.app.get('appRoot');
      generateStaticJSONFiles(appRoot);
      
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to update folder order' });
    }
  } catch (err) {
    error('[FolderManagement] Failed to update folder order:', err);
    res.status(500).json({ error: 'Failed to update folder order' });
  }
});

export default router;
