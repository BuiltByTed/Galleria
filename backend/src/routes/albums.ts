/**
 * Route handler for album-related endpoints.
 * This file contains routes for retrieving albums and photos,
 * as well as helper functions for file system operations.
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import exifr from "exifr";
import { 
  getAlbumState, 
  getPublishedAlbums, 
  getAllAlbums, 
  saveAlbum, 
  getAlbumMetadata,
  getAlbumsFromMetadata,
  getImagesInAlbum,
  getImagesFromPublishedAlbums,
  getImagesForHomepage,
  getShareLinkBySecret,
  isShareLinkExpired,
  getAllFolders,
  getPublishedFolders,
  getAlbumsInFolder,
  incrementAlbumViewCount
} from "../database.js";
import { getAlbumAccess, isRequestAuthenticated } from '../utils/album-access.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const router = Router();

// In-memory cache for album photos
interface CacheEntry {
  photos: any[];
  timestamp: number;
}

const albumCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Function to invalidate cache for an album
export const invalidateAlbumCache = (albumName?: string) => {
  if (albumName) {
    albumCache.delete(albumName);
    debug(`[Albums] Cache invalidated for album: ${albumName}`);
  } else {
    albumCache.clear();
    debug('[Albums] All album caches cleared');
  }
};

/**
 * Sanitize path input to prevent directory traversal attacks.
 * @param input - User-provided path component
 * @returns Sanitized path component or null if invalid
 */
const sanitizePath = (input: string): string | null => {
  // Remove any path traversal attempts
  if (
    !input ||
    input.includes("..") ||
    input.includes("/") ||
    input.includes("\\")
  ) {
    return null;
  }
  // Allow alphanumeric characters, spaces, hyphens, and underscores
  if (!/^[a-zA-Z0-9 _-]+$/.test(input)) {
    return null;
  }
  return input.trim();
};

/**
 * Helper function to get all albums from the database.
 * Falls back to filesystem scan if database is empty.
 * @param photosDir - Path to the photos directory (for fallback only)
 * @returns Array of album names
 */
const getAlbums = (photosDir: string) => {
  try {
    // Get albums from database
    const dbAlbums = getAllAlbums()
      .map(a => a.name)
      .filter(name => name !== 'homepage'); // Exclude homepage directory
    
    // If database has albums, use those
    if (dbAlbums.length > 0) {
      return dbAlbums;
    }
    
    // Fallback to filesystem scan if database is empty (backward compatibility)
    warn('[Albums] Database has no albums, falling back to filesystem scan');
    return fs
      .readdirSync(photosDir)
      .filter((file) => {
        // Exclude homepage directory and only include actual directories
        return file !== 'homepage' && fs.statSync(path.join(photosDir, file)).isDirectory();
      });
  } catch (err) {
    error('[Albums] Failed to read albums:', err);
    return [];
  }
};

/**
 * Helper function to get all photos in a specific album from database.
 * @param photosDir - Path to the photos directory (unused, kept for compatibility)
 * @param album - Name of the album to get photos from
 * @returns Array of photo objects with their paths
 */
const getContentInAlbum = (photosDir: string, album: string) => {
  try {
    // Get images from database
    const images = getImagesInAlbum(album);
    const albumState = getAlbumState(album);
    const downloadsEnabled = albumState?.downloads_enabled ?? true;
    
    // Transform to photo objects
    const photos = images.map((img) => {
      // Generate default title from filename
      const defaultTitle = img.filename
        .replace(/\.[^/.]+$/, '') // Remove extension
        .replace(/[-_]/g, ' '); // Replace hyphens and underscores with spaces

      // For videos, thumbnails are stored as JPG
      const isVideo = img.media_type === 'video';
      const thumbnailFilename = isVideo ? img.filename.replace(/\.[^.]+$/, '.jpg') : img.filename;

      const photo = {
        id: `${album}/${img.filename}`,
        title: img.title || defaultTitle,
        description: img.description || undefined,
        album: album,
        thumbnail: `/optimized/thumbnail/${album}/${thumbnailFilename}`,
        modal: `/optimized/modal/${album}/${thumbnailFilename}`,
        download: isVideo || !downloadsEnabled ? '' : `/optimized/download/${album}/${img.filename}`,
        downloads_enabled: downloadsEnabled,
        sort_order: img.sort_order ?? null,
        media_type: img.media_type || 'photo',
      };
      
      // Debug logging
      if (album === 'Animals' && img.filename.includes('Charels')) {
        info(`[Albums] Photo object for ${img.filename}:`, { id: photo.id, title: photo.title });
      }
      
      return photo;
    });
    
    // Photos are already sorted by the database query
    return photos;
  } catch (err) {
    error(`[Albums] Failed to read album ${album}:`, err);
    return [];
  }
};

/**
 * Helper function to shuffle an array using Fisher-Yates algorithm.
 * @param array - Array to shuffle
 * @returns Shuffled array
 */
const shuffleArray = <T>(array: T[]): T[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

/**
 * Helper function to get all photos from all albums (filtered by published state) from database.
 * @param photosDir - Path to the photos directory (unused, kept for compatibility)
 * @param includeUnpublished - Whether to include unpublished albums (admin only)
 * @returns Array of all photo objects with their paths and album information
 */
const getAllPhotos = (photosDir: string, includeUnpublished: boolean = false) => {
  try {
    let images;
    
    if (includeUnpublished) {
      // Get all images from all albums
      const allAlbums = getAllAlbums()
        .filter(a => a.name !== 'homepage');

      images = allAlbums.flatMap(album =>
        getImagesInAlbum(album.name).map(img => ({
          ...img,
          downloads_enabled: album.downloads_enabled
        }))
      );
    } else {
      // Get only images from published albums
      images = getImagesFromPublishedAlbums().filter(img => img.album !== 'homepage');
    }
    
    const allPhotos = images.map((img) => {
      // Generate title from filename by removing extension and replacing separators
      const defaultTitle = img.filename
        .replace(/\.[^/.]+$/, '') // Remove extension
        .replace(/[-_]/g, ' '); // Replace hyphens and underscores with spaces

      // For videos, thumbnails are stored as JPG
      const isVideo = img.media_type === 'video';
      const thumbnailFilename = isVideo ? img.filename.replace(/\.[^.]+$/, '.jpg') : img.filename;
      const downloadsEnabled = (img as any).downloads_enabled ?? true;

      return {
        id: `${img.album}/${img.filename}`,
        title: img.title || defaultTitle,
        description: img.description || undefined,
        album: img.album,
        thumbnail: `/optimized/thumbnail/${img.album}/${thumbnailFilename}`,
        modal: `/optimized/modal/${img.album}/${thumbnailFilename}`,
        download: isVideo || !downloadsEnabled ? '' : `/optimized/download/${img.album}/${img.filename}`,
        downloads_enabled: downloadsEnabled,
        media_type: img.media_type || 'photo',
      };
    });

    const albumCount = new Set(images.map(i => i.album)).size;
    debug(`[Albums] Found ${allPhotos.length} total photos across ${albumCount} albums`);
    
    // Shuffle all photos for random order
    return shuffleArray(allPhotos);
  } catch (err) {
    error('[Albums] Failed to get all photos:', err);
    return [];
  }
};

// Get all albums (filtered by published state for non-authenticated users)
router.get("/api/albums", (req: Request, res) => {
  const photosDir = req.app.get("photosDir");
  const allAlbums = getAlbums(photosDir);
  
  // Sync filesystem albums to database (auto-add any missing albums as unpublished)
  const allAlbumStates = getAllAlbums();
  const albumsInDB = new Set(allAlbumStates.map(a => a.name));
  
  for (const albumName of allAlbums) {
    if (!albumsInDB.has(albumName) && albumName !== 'homepage') {
      // Auto-add missing albums as unpublished (for manually created folders)
      saveAlbum(albumName, false);
      debug(`[Albums] Auto-synced album to database: ${albumName} (unpublished - manually created folder)`);
    }
  }
  
  // Re-fetch album states after sync
  const updatedAlbumStates = getAllAlbums();
  
  // Live DB check — deleted/inactive sessions must not list unpublished albums
  const isAuthenticated = isRequestAuthenticated(req);
  
  verbose('[Albums] Auth check:', {
    isAuthenticated,
    hasIsAuthenticatedFunc: !!req.isAuthenticated,
    isAuthenticatedResult: req.isAuthenticated ? req.isAuthenticated() : false,
    hasUserId: !!(req.session as any)?.userId,
    userId: (req.session as any)?.userId,
    sessionID: req.sessionID,
    albumCount: allAlbums.length,
  });
  
  // Get folders
  const allFolders = isAuthenticated ? getAllFolders() : getPublishedFolders();
  
  if (isAuthenticated) {
    // For authenticated users, return all albums with their published state and folder info
    const albumsWithState = allAlbums.map((albumName: string) => {
      const state = updatedAlbumStates.find(a => a.name === albumName);
      return {
        name: albumName,
        published: state?.published ?? false,
        show_on_homepage: state?.show_on_homepage ?? true,
        downloads_enabled: state?.downloads_enabled ?? true,
        folder_id: state?.folder_id ?? null
      };
    });
    res.json({
      albums: albumsWithState,
      folders: allFolders
    });
  } else {
    // For non-authenticated users, only return published albums and folders
    const publishedAlbums = allAlbums.filter((albumName: string) => {
      const state = updatedAlbumStates.find(a => a.name === albumName);
      return state?.published === true;
    });
    
    // Group albums by folder for better structure
    const albumsWithFolder = publishedAlbums.map((albumName: string) => {
      const state = updatedAlbumStates.find(a => a.name === albumName);
      return {
        name: albumName,
        folder_id: state?.folder_id ?? null,
        published: true, // Already filtered to published albums
        show_on_homepage: state?.show_on_homepage ?? true,
        downloads_enabled: state?.downloads_enabled ?? true
      };
    });
    
    res.json({
      albums: albumsWithFolder,
      folders: allFolders
    });
  }
});

// Shared handler for static JSON
const serveAlbumJSON = (req: Request, res: Response, albumName: string): void => {
  // Sanitize album parameter to prevent path traversal
  const sanitizedAlbum = sanitizePath(albumName);
  if (!sanitizedAlbum) {
    res.status(400).json({ error: "Invalid album name" });
    return;
  }

  const access = getAlbumAccess(req, sanitizedAlbum);

  if (!access.exists) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  if (!access.allowed) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // Serve static JSON file if it exists
  const appRoot = req.app.get('appRoot');
  const jsonPath = path.join(appRoot, 'frontend', 'dist', 'albums-data', `${sanitizedAlbum}.json`);
  
  if (fs.existsSync(jsonPath)) {
    try {
      const jsonData = fs.readFileSync(jsonPath, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.send(jsonData);
      return;
    } catch (err) {
      error(`[Albums] Failed to read JSON file for ${sanitizedAlbum}:`, err);
    }
  }
  
  // Fallback: JSON doesn't exist, return 404
  res.status(404).json({ error: "Album JSON not found" });
};

// Get static JSON for an album
router.get("/api/albums/:album/photos-json", (req: Request, res): void => {
  serveAlbumJSON(req, res, req.params.album);
});

// Shared handler for album photos
const serveAlbumPhotos = (req: Request, res: Response, albumName: string): void => {
  const startTime = Date.now();

  // Sanitize album parameter to prevent path traversal
  const sanitizedAlbum = sanitizePath(albumName);
  if (!sanitizedAlbum) {
    res.status(400).json({ error: "Invalid album name" });
    return;
  }

  const photosDir = req.app.get("photosDir");
  const albumPath = path.join(photosDir, sanitizedAlbum);

  const access = getAlbumAccess(req, sanitizedAlbum);

  if (!access.exists) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  if (!access.allowed) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const albumState = access.albumState!;
  
  // Check if album directory exists
  if (!fs.existsSync(albumPath) || !fs.statSync(albumPath).isDirectory()) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  // Increment view count for milestone tracking
  try {
    incrementAlbumViewCount(sanitizedAlbum);
  } catch (err) {
    // Don't fail the request if view tracking fails
    warn('[Albums] Failed to increment view count:', err);
  }

  // Check cache first
  const cached = albumCache.get(sanitizedAlbum);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    const duration = Date.now() - startTime;
    debug(`[Albums] Cache hit for album: ${sanitizedAlbum} (${cached.photos.length} photos, ${duration}ms)`);
    // Return cached photos with published state
    res.json({
      photos: cached.photos,
      published: albumState.published,
      downloads_enabled: albumState.downloads_enabled
    });
    return;
  }

  // Cache miss or expired - fetch from filesystem
  debug(`[Albums] Cache miss for album: ${sanitizedAlbum}`);
  const fetchStart = Date.now();
  const photos = getContentInAlbum(photosDir, sanitizedAlbum);
  const fetchDuration = Date.now() - fetchStart;
  
  // Store in cache
  albumCache.set(sanitizedAlbum, {
    photos,
    timestamp: now
  });
  
  const totalDuration = Date.now() - startTime;
  debug(`[Albums] Fetched ${photos.length} photos in ${fetchDuration}ms, total request: ${totalDuration}ms`);
  
  // Return photos with published state
  res.json({
    photos,
    published: albumState.published,
    downloads_enabled: albumState.downloads_enabled
  });
};

// Get album photos
router.get("/api/albums/:album/photos", (req: Request, res): void => {
  serveAlbumPhotos(req, res, req.params.album);
});

// Get all photos from albums configured for homepage in random order
router.get("/api/random-photos", (req: Request, res) => {
  // Only return photos from albums that have show_on_homepage = true
  const images = getImagesForHomepage().filter(img => img.album !== 'homepage');
  
  const allPhotos = images.map((img) => {
    // Generate title from filename by removing extension and replacing separators
    const defaultTitle = img.filename
      .replace(/\.[^/.]+$/, '') // Remove extension
      .replace(/[-_]/g, ' '); // Replace hyphens and underscores with spaces

    // For videos, thumbnails are stored as JPG
    const isVideo = img.media_type === 'video';
    const thumbnailFilename = isVideo ? img.filename.replace(/\.[^.]+$/, '.jpg') : img.filename;
    const downloadsEnabled = (img as any).downloads_enabled ?? true;

    return {
      id: `${img.album}/${img.filename}`,
      title: img.title || defaultTitle,
      description: img.description || undefined,
      album: img.album,
      thumbnail: `/optimized/thumbnail/${img.album}/${thumbnailFilename}`,
      modal: `/optimized/modal/${img.album}/${thumbnailFilename}`,
      download: isVideo || !downloadsEnabled ? '' : `/optimized/download/${img.album}/${img.filename}`,
      downloads_enabled: downloadsEnabled,
      media_type: img.media_type || 'photo',
    };
  });

  const albumCount = new Set(images.map(i => i.album)).size;
  debug(`[Albums] Returning ${allPhotos.length} photos from ${albumCount} homepage albums`);
  
  // Shuffle all photos for random order
  const shuffledPhotos = shuffleArray(allPhotos);
  res.json(shuffledPhotos);
});

// Get shared album by secret key
router.get("/api/shared/:secretKey", async (req: Request, res): Promise<void> => {
  const { secretKey } = req.params;

  // Validate secret key format (64 hex characters)
  if (!secretKey || !/^[a-f0-9]{64}$/i.test(secretKey)) {
    res.status(404).json({ error: "Invalid share link" });
    return;
  }

  // Look up the share link
  const shareLink = getShareLinkBySecret(secretKey);
  
  if (!shareLink) {
    res.status(404).json({ error: "Share link not found" });
    return;
  }

  // Check if this is a meta tag injection request (server-side only, skip notifications)
  const isMetaInjection = req.headers['x-meta-injection'] === 'true';

  // Check if expired
  if (isShareLinkExpired(shareLink)) {
    // Notify admins that someone tried to access an expired link (skip for meta injection)
    if (!isMetaInjection) {
      try {
        const { sendNotificationToUser } = await import('../push-notifications.js');
        const { translateNotification } = await import('../i18n-backend.js');
        const { getAllUsers } = await import('../database-users.js');
        
        const admins = getAllUsers().filter(u => u.role === 'admin');
        for (const admin of admins) {
          const title = await translateNotification('notifications.backend.shareLinkExpiredAccessedTitle', { albumName: shareLink.album });
          const body = await translateNotification('notifications.backend.shareLinkExpiredAccessedBody', { albumName: shareLink.album });
          
          sendNotificationToUser(admin.id, {
            title,
            body,
            tag: 'share-link-expired-accessed'
          }, 'shareLinkExpiredAccessed');
        }
      } catch (err) {
        error('[Albums] Failed to send expired link access notification:', err);
      }
    }
    
    res.status(410).json({ error: "Share link has expired", expired: true });
    return;
  }
  
  // Notify admins that someone accessed the share link (skip for meta injection)
  if (!isMetaInjection) {
    try {
      const { sendNotificationToUser } = await import('../push-notifications.js');
      const { translateNotification } = await import('../i18n-backend.js');
      const { getAllUsers } = await import('../database-users.js');
      
      const admins = getAllUsers().filter(u => u.role === 'admin');
      for (const admin of admins) {
        const title = await translateNotification('notifications.backend.shareLinkAccessedTitle', { albumName: shareLink.album });
        const body = await translateNotification('notifications.backend.shareLinkAccessedBody', { albumName: shareLink.album });
        
        sendNotificationToUser(admin.id, {
          title,
          body,
          tag: 'share-link-accessed'
        }, 'shareLinkAccessed');
      }
    } catch (err) {
      error('[Albums] Failed to send share link access notification:', err);
    }
  }

  // Get the album name
  const album = shareLink.album;
  const photosDir = req.app.get("photosDir");
  const albumPath = path.join(photosDir, album);
  
  // Check if album directory exists
  if (!fs.existsSync(albumPath) || !fs.statSync(albumPath).isDirectory()) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  // Return album info and photos (bypass published check)
    const photos = getContentInAlbum(photosDir, album);
  
  res.json({
    album,
    photos,
    expiresAt: shareLink.expires_at
  });
});

// Shared handler for EXIF data
const servePhotoEXIF = async (req: Request, res: Response, albumName: string, filename: string): Promise<void> => {
  // Sanitize inputs to prevent path traversal
  const sanitizedAlbum = sanitizePath(albumName);
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_. -]/g, '');
  
  if (!sanitizedAlbum || !sanitizedFilename) {
    res.status(400).json({ error: "Invalid album or filename" });
    return;
  }

  // Ensure the filename has an image extension
  if (!/\.(jpg|jpeg|png|gif)$/i.test(sanitizedFilename)) {
    res.status(400).json({ error: "Invalid image file" });
    return;
  }

  const access = getAlbumAccess(req, sanitizedAlbum);

  if (!access.exists) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  if (!access.allowed) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  try {
    const photosDir = req.app.get("photosDir");
    const filePath = path.join(photosDir, sanitizedAlbum, sanitizedFilename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Image not found" });
      return;
    }

    // Extract EXIF data
    const exif = await exifr.parse(filePath);
    
    if (!exif) {
      res.json({ message: "No EXIF data found" });
      return;
    }

    res.json(exif);
  } catch (err) {
    error(`[Albums] Failed to read EXIF for ${albumName}/${filename}:`, err);
    res.status(500).json({ error: "Failed to read EXIF data" });
  }
};

// Get EXIF data
router.get("/api/photos/:album/:filename/exif", async (req, res): Promise<void> => {
  await servePhotoEXIF(req, res, req.params.album, req.params.filename);
});

// Shared handler for video metadata
const serveVideoMetadata = async (req: Request, res: Response, albumName: string, filename: string): Promise<void> => {
  // Sanitize inputs to prevent path traversal
  const sanitizedAlbum = sanitizePath(albumName);
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_. -]/g, '');
  
  if (!sanitizedAlbum || !sanitizedFilename) {
    res.status(400).json({ error: "Invalid album or filename" });
    return;
  }

  // Ensure the filename has a video extension
  if (!/\.(mp4|mov|avi|mkv|webm)$/i.test(sanitizedFilename)) {
    res.status(400).json({ error: "Invalid video file" });
    return;
  }

  const access = getAlbumAccess(req, sanitizedAlbum);

  if (!access.exists) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  if (!access.allowed) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  try {
    const photosDir = req.app.get("photosDir");
    const filePath = path.join(photosDir, sanitizedAlbum, sanitizedFilename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    // Use ffprobe to get video metadata
    const { getVideoMetadata } = await import('../utils/video-processor.js');
    const metadata = await getVideoMetadata(filePath);
    
    if (!metadata) {
      res.json({ message: "No video metadata found" });
      return;
    }
    
    res.json(metadata);
  } catch (err) {
    error(`[Albums] Failed to read video metadata for ${albumName}/${filename}:`, err);
    res.status(500).json({ error: "Failed to read video metadata" });
  }
};

// Get video metadata
router.get("/api/videos/:album/:filename/metadata", async (req, res): Promise<void> => {
  await serveVideoMetadata(req, res, req.params.album, req.params.filename);
});

export default router;
