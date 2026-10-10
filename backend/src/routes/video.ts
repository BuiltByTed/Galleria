/**
 * Video Serving Routes
 * Serves HLS playlists and segments for video playback
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { error, info } from '../utils/logger.js';
import { getAlbumState, getShareLinkBySecret, isShareLinkExpired } from '../database.js';
import { requireAuth } from '../auth/middleware.js';
import { isRequestAuthenticated } from '../utils/album-access.js';
import { isOriginAllowed } from '../config.js';
import { streamFileToResponse } from '../utils/stream-file-response.js';

const router = Router();

/**
 * Reflect Origin only when it passes the global allowlist.
 * Unconditional reflection + credentials bypassed server CORS (regression of #821).
 */
const setCredentialedCorsHeaders = (req: Request, res: Response): void => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
};

/** Same rules for writeHead() paths that cannot call setHeader after headers start. */
const credentialedCorsHeaderRecord = (req: Request): Record<string, string> => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isOriginAllowed(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    };
  }
  return {};
};

/**
 * Sanitize path components to prevent directory traversal
 */
const sanitizePath = (name: string): string | null => {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return null;
  }
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    return null;
  }
  return name;
};

/**
 * Extract share key from request query (validated hex format).
 */
const getShareKeyFromQuery = (req: Request): string | null => {
  // Note: req.query.key can be a string OR an array if multiple keys are provided
  const shareKeyParam = req.query.key;
  const shareKey = Array.isArray(shareKeyParam) ? shareKeyParam[0] : shareKeyParam;
  if (shareKey && typeof shareKey === 'string' && /^[a-f0-9]{64}$/i.test(shareKey)) {
    return shareKey;
  }
  return null;
};

/**
 * Safari native HLS does not preserve master-playlist query params on relative
 * media-playlist / segment URIs. Rewrite URI lines so the share key travels with
 * every follow-on request (HLS.js CustomLoader handles this on non-Safari).
 */
const appendKeyToPlaylistUris = (content: string, key: string): string => {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      // Skip empty lines and HLS tags/comments
      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }
      const separator = trimmed.includes('?') ? '&' : '?';
      return `${trimmed}${separator}key=${key}`;
    })
    .join('\n');
};

/**
 * Send an m3u8 playlist, rewriting relative URIs to include share key when present.
 */
const sendPlaylist = (req: Request, res: Response, playlistPath: string): void => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  setCredentialedCorsHeaders(req, res);

  const shareKey = getShareKeyFromQuery(req);
  if (shareKey) {
    // Do not cache key-bearing rewrites (key is a secret capability URL)
    res.setHeader('Cache-Control', 'private, no-store');
    const content = fs.readFileSync(playlistPath, 'utf-8');
    res.send(appendKeyToPlaylistUris(content, shareKey));
    return;
  }

  res.sendFile(playlistPath);
};

/**
 * Check if user has access to album (authenticated, published, or valid share link)
 */
const hasAlbumAccess = (req: Request, album: string): boolean => {
  // Live DB check — deleted/inactive sessions must not stream unpublished video
  const isAuthenticated = isRequestAuthenticated(req);
  
  const shareKey = getShareKeyFromQuery(req);
  let hasValidShareLink = false;
  
  info(`[Video] Access check: album=${album}, shareKey=${shareKey ? String(shareKey).substring(0, 16) + '...' : 'none'}, isAuth=${isAuthenticated}`);
  
  if (shareKey) {
    const shareLink = getShareLinkBySecret(shareKey);
    info(`[Video] Share link lookup: found=${!!shareLink}, match=${shareLink?.album === album}, expired=${shareLink ? isShareLinkExpired(shareLink) : 'N/A'}`);
    if (shareLink && shareLink.album === album && !isShareLinkExpired(shareLink)) {
      hasValidShareLink = true;
    }
  }
  
  // Check album state
  const albumState = getAlbumState(album);
  
  // Return false if album doesn't exist
  if (!albumState) {
    return false;
  }
  
  info(`[Video] Access decision: published=${albumState.published}, auth=${isAuthenticated}, validShareLink=${hasValidShareLink}, granting=${albumState.published || isAuthenticated || hasValidShareLink}`);
  
  // Allow access if: album is published OR user is authenticated OR valid share link
  return albumState.published || isAuthenticated || hasValidShareLink;
};

/**
 * Shared handler for master HLS playlist
 */
const serveMasterPlaylist = async (req: Request, res: Response, album: string, filename: string): Promise<void> => {
  try {
    info(`[Video] Master playlist request: album=${album}, filename=${filename}`);

    // Sanitize inputs
    const sanitizedAlbum = sanitizePath(album);
    const sanitizedFilename = sanitizePath(filename);

    if (!sanitizedAlbum || !sanitizedFilename) {
      error(`[Video] Sanitization failed: album=${album}, filename=${filename}`);
      res.status(400).json({ error: 'Invalid path parameters' });
      return;
    }

    // Check album exists first
    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      error(`[Video] Album not found: ${sanitizedAlbum}`);
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Check access (authentication, published state, or share link)
    if (!hasAlbumAccess(req, sanitizedAlbum)) {
      error(`[Video] Access denied for album: ${sanitizedAlbum}`);
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const videoDir = req.app.get("videoDir");
    if (!videoDir) {
      error('[Video] videoDir not configured');
      res.status(500).json({ error: 'Video directory not configured' });
      return;
    }

    const masterPlaylistPath = path.join(
      videoDir,
      sanitizedAlbum,
      sanitizedFilename,
      'master.m3u8'
    );
    info(`[Video] Looking for master playlist at: ${masterPlaylistPath}`);

    // Check if master playlist exists
    if (!fs.existsSync(masterPlaylistPath)) {
      error(`[Video] Master playlist not found: ${masterPlaylistPath}`);
      
      // Debug: show what's actually in the video directory
      const albumVideoDir = path.join(videoDir, sanitizedAlbum);
      if (fs.existsSync(albumVideoDir)) {
        const files = fs.readdirSync(albumVideoDir);
        error(`[Video] Files in album directory: ${JSON.stringify(files)}`);
      } else {
        error(`[Video] Album video directory doesn't exist: ${albumVideoDir}`);
      }
      
      res.status(404).json({ error: 'Master playlist not found' });
      return;
    }
    
    info('[Video] Master playlist found, sending file');
    sendPlaylist(req, res, masterPlaylistPath);
  } catch (err) {
    error('[Video] Failed to serve master playlist:', err);
    error('[Video] Error details:', {
      message: (err as Error).message,
      stack: (err as Error).stack,
      name: (err as Error).name
    });
    res.status(500).json({ error: 'Failed to serve master playlist' });
  }
};

/**
 * Serve master HLS playlist
 * GET /api/video/:album/:filename/master.m3u8
 */
router.get("/:album/:filename/master.m3u8", async (req: Request, res: Response): Promise<void> => {
  const { album, filename } = req.params;
  await serveMasterPlaylist(req, res, album, filename);
});

/**
 * Serve HLS playlist for a video (individual resolution)
 * GET /api/video/:album/:filename/:resolution/playlist.m3u8
 */
router.get("/:album/:filename/:resolution/playlist.m3u8", async (req: Request, res: Response): Promise<void> => {
  try {
    const { album, filename, resolution } = req.params;

    // Sanitize inputs
    const sanitizedAlbum = sanitizePath(album);
    const sanitizedFilename = sanitizePath(filename);
    const sanitizedResolution = sanitizePath(resolution);

    if (!sanitizedAlbum || !sanitizedFilename || !sanitizedResolution) {
      res.status(400).json({ error: 'Invalid path parameters' });
      return;
    }

    // Check album exists first
    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Check access (authentication, published state, or share link)
    if (!hasAlbumAccess(req, sanitizedAlbum)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Validate resolution
    if (!['240p', '360p', '720p', '1080p'].includes(sanitizedResolution)) {
      res.status(400).json({ error: 'Invalid resolution' });
      return;
    }

    const videoDir = req.app.get("videoDir");
    if (!videoDir) {
      error('[Video] videoDir not configured');
      res.status(500).json({ error: 'Video directory not configured' });
      return;
    }

    const playlistPath = path.join(
      videoDir,
      sanitizedAlbum,
      sanitizedFilename,
      sanitizedResolution,
      'playlist.m3u8'
    );

    // Check if playlist exists
    if (!fs.existsSync(playlistPath)) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    sendPlaylist(req, res, playlistPath);
  } catch (err) {
    error('[Video] Failed to serve playlist:', err);
    res.status(500).json({ error: 'Failed to serve playlist' });
  }
});

/**
 * Serve HLS segment for a video
 * GET /api/video/:album/:filename/:resolution/:segment
 */
router.get("/:album/:filename/:resolution/:segment", async (req: Request, res: Response): Promise<void> => {
  try {
    const { album, filename, resolution, segment } = req.params;

    // Sanitize inputs
    const sanitizedAlbum = sanitizePath(album);
    const sanitizedFilename = sanitizePath(filename);
    const sanitizedResolution = sanitizePath(resolution);
    const sanitizedSegment = sanitizePath(segment);

    if (!sanitizedAlbum || !sanitizedFilename || !sanitizedResolution || !sanitizedSegment) {
      res.status(400).json({ error: 'Invalid path parameters' });
      return;
    }

    // Check album exists first
    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Check access (authentication, published state, or share link)
    if (!hasAlbumAccess(req, sanitizedAlbum)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Validate resolution
    if (!['240p', '360p', '720p', '1080p'].includes(sanitizedResolution)) {
      res.status(400).json({ error: 'Invalid resolution' });
      return;
    }

    // Validate segment filename (must be .ts file)
    if (!sanitizedSegment.endsWith('.ts')) {
      res.status(400).json({ error: 'Invalid segment file' });
      return;
    }

    const videoDir = req.app.get("videoDir");
    if (!videoDir) {
      error('[Video] videoDir not configured');
      res.status(500).json({ error: 'Video directory not configured' });
      return;
    }

    const segmentPath = path.join(
      videoDir,
      sanitizedAlbum,
      sanitizedFilename,
      sanitizedResolution,
      sanitizedSegment
    );

    // Check if segment exists
    if (!fs.existsSync(segmentPath)) {
      res.status(404).json({ error: 'Segment not found' });
      return;
    }

    // Set appropriate headers for MPEG-TS segments
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache segments for 1 year
    setCredentialedCorsHeaders(req, res);

    // Send the segment file
    res.sendFile(segmentPath);
  } catch (err) {
    error('[Video] Failed to serve segment:', err);
    res.status(500).json({ error: 'Failed to serve segment' });
  }
});

/**
 * Get available resolutions for a video
 * GET /api/video/:album/:filename/resolutions
 */
router.get("/:album/:filename/resolutions", async (req: Request, res: Response): Promise<void> => {
  try {
    const { album, filename } = req.params;

    // Sanitize inputs
    const sanitizedAlbum = sanitizePath(album);
    const sanitizedFilename = sanitizePath(filename);

    if (!sanitizedAlbum || !sanitizedFilename) {
      res.status(400).json({ error: 'Invalid path parameters' });
      return;
    }

    // Check album exists first
    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Check access (authentication, published state, or share link)
    if (!hasAlbumAccess(req, sanitizedAlbum)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const videoDir = req.app.get("videoDir");
    if (!videoDir) {
      error('[Video] videoDir not configured');
      res.status(500).json({ error: 'Video directory not configured' });
      return;
    }

    const videoPath = path.join(videoDir, sanitizedAlbum, sanitizedFilename);

    // Check if video directory exists
    if (!fs.existsSync(videoPath)) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Check which resolution directories exist
    const availableResolutions: string[] = [];
    const possibleResolutions = ['240p', '360p', '720p', '1080p'];

    for (const resolution of possibleResolutions) {
      const resolutionPath = path.join(videoPath, resolution, 'playlist.m3u8');
      if (fs.existsSync(resolutionPath)) {
        availableResolutions.push(resolution);
      }
    }

    if (availableResolutions.length === 0) {
      res.status(404).json({ error: 'No video resolutions available' });
      return;
    }

    res.json({
      album: sanitizedAlbum,
      filename: sanitizedFilename,
      resolutions: availableResolutions
    });
  } catch (err) {
    error('[Video] Failed to get resolutions:', err);
    res.status(500).json({ error: 'Failed to get resolutions' });
  }
});

/**
 * Serve rotated video file for admin thumbnail scrubbing
 * GET /api/video/:album/:filename/original.mp4
 * Requires authentication - for admin panel use only
 */
router.get("/:album/:filename/original.mp4", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album, filename } = req.params;
    info(`[Video] Rotated video request: album=${album}, filename=${filename}`);

    // Sanitize inputs
    const sanitizedAlbum = sanitizePath(album);
    const sanitizedFilename = sanitizePath(filename);

    if (!sanitizedAlbum || !sanitizedFilename) {
      error(`[Video] Sanitization failed: album=${album}, filename=${filename}`);
      res.status(400).json({ error: 'Invalid path parameters' });
      return;
    }

    const videoDir = req.app.get("videoDir");
    if (!videoDir) {
      error('[Video] videoDir not configured');
      res.status(500).json({ error: 'Video directory not configured' });
      return;
    }

    const rotatedVideoPath = path.join(
      videoDir,
      sanitizedAlbum,
      sanitizedFilename,
      'original.mp4'
    );
    info(`[Video] Looking for rotated video at: ${rotatedVideoPath}`);

    // Check if rotated video exists
    if (!fs.existsSync(rotatedVideoPath)) {
      error(`[Video] Rotated video not found: ${rotatedVideoPath}`);
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Get file stats for range request support
    const stat = fs.statSync(rotatedVideoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Handle range request (for seeking)
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        ...credentialedCorsHeaderRecord(req),
      });

      await streamFileToResponse(rotatedVideoPath, res, { start, end });
    } else {
      // Send entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        ...credentialedCorsHeaderRecord(req),
      });

      await streamFileToResponse(rotatedVideoPath, res);
    }
  } catch (err) {
    error('[Video] Failed to serve rotated video:', err);
    if (res.headersSent) {
      if (!res.destroyed) {
        res.destroy();
      }
      return;
    }
    res.status(500).json({ error: 'Failed to serve video' });
  }
});

export default router;
