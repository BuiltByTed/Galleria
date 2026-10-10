/**
 * Share Links Routes
 * Handles creating and validating share links for unpublished albums
 */

import { Router, Request, Response } from "express";
import { csrfProtection } from "../security.js";
import { requireManager } from '../auth/middleware.js';
import { 
  createShareLink, 
  getShareLinkBySecret, 
  isShareLinkExpired,
  deleteShareLink,
  deleteShareLinksForAlbum,
  getShareLinksForAlbum
} from "../database.js";
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { getAllUsers } from '../database-users.js';

const router = Router();

/**
 * Helper to send push notification to all admin users
 */
async function notifyAllAdmins(title: string, body: string, tag: string, notificationType?: any, variables?: Record<string, any>): Promise<void> {
  try {
    const admins = getAllUsers().filter(u => u.role === 'admin');
    
    for (const admin of admins) {
      const translatedTitle = await translateNotification(title, variables);
      const translatedBody = await translateNotification(body, variables);
      
      await sendNotificationToUser(admin.id, {
        title: translatedTitle,
        body: translatedBody,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        requireInteraction: false
      }, notificationType);
    }
  } catch (err) {
    error('[ShareLinks] Failed to send admin notification:', err);
  }
}

/**
 * Sanitize album name
 */
const sanitizeName = (name: string): string | null => {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return null;
  }
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
    return null;
  }
  return name.trim();
};

/**
 * Create a new share link for an album
 * POST /api/share-links/create
 * Body: { album: string, expirationMinutes: number | null }
 */
router.post("/create", csrfProtection, requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album, expirationMinutes } = req.body;
    
    if (!album) {
      res.status(400).json({ error: 'Album name is required' });
      return;
    }

    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    // Calculate expiration date if provided
    let expiresAt: string | null = null;
    if (expirationMinutes !== null && expirationMinutes !== undefined) {
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + expirationMinutes);
      expiresAt = expirationDate.toISOString();
    }

    // Create the share link
    const shareLink = createShareLink(sanitizedAlbum, expiresAt);
    
    info(`Created share link for album "${sanitizedAlbum}": ${shareLink.secret_key} (expires: ${expiresAt || 'never'})`);

    // Schedule expiry timer if link has an expiration date
    if (expiresAt) {
      const { scheduleNewShareLinkExpiry } = await import('../services/share-link-expiry-tracker.js');
      scheduleNewShareLinkExpiry(shareLink.id);
    }

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.shareLinkCreatedTitle',
      'notifications.backend.shareLinkCreatedBody',
      'share-link-created',
      'shareLinkCreated',
      {
        albumName: sanitizedAlbum,
        createdBy: (req.user as any).name || (req.user as any).email
      }
    ).catch(err => error('[ShareLinks] Failed to send share link creation notification:', err));

    res.json({
      success: true,
      shareLink: {
        id: shareLink.id,
        album: shareLink.album,
        secretKey: shareLink.secret_key,
        expiresAt: shareLink.expires_at,
        createdAt: shareLink.created_at
      }
    });
  } catch (err) {
    error('[ShareLinks] Failed to create share link:', err);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

/**
 * Validate a share link and return album info if valid
 * GET /api/share-links/validate/:secretKey
 */
router.get("/validate/:secretKey", async (req: Request, res: Response): Promise<void> => {
  try {
    const { secretKey } = req.params;
    
    if (!secretKey || !/^[a-f0-9]{64}$/i.test(secretKey)) {
      res.status(400).json({ 
        error: 'Invalid secret key format',
        valid: false 
      });
      return;
    }

    // Get the share link
    const shareLink = getShareLinkBySecret(secretKey);
    
    if (!shareLink) {
      res.status(404).json({ 
        error: 'Share link not found',
        valid: false 
      });
      return;
    }

    // Check if expired
    if (isShareLinkExpired(shareLink)) {
      res.status(410).json({ 
        error: 'Share link has expired',
        valid: false,
        expired: true
      });
      return;
    }

    // Valid share link
    res.json({
      valid: true,
      album: shareLink.album,
      expiresAt: shareLink.expires_at
    });
  } catch (err) {
    error('[ShareLinks] Failed to validate share link:', err);
    res.status(500).json({ 
      error: 'Failed to validate share link',
      valid: false 
    });
  }
});

/**
 * Get all share links for an album (admin only)
 * GET /api/share-links/album/:album
 */
router.get("/album/:album", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    const shareLinks = getShareLinksForAlbum(sanitizedAlbum);
    
    res.json({
      success: true,
      shareLinks: shareLinks.map(link => ({
        id: link.id,
        album: link.album,
        secretKey: link.secret_key,
        expiresAt: link.expires_at,
        createdAt: link.created_at,
        expired: isShareLinkExpired(link)
      }))
    });
  } catch (err) {
    error('[ShareLinks] Failed to get share links:', err);
    res.status(500).json({ error: 'Failed to get share links' });
  }
});

/**
 * Delete all share links for an album (admin only)
 * DELETE /api/share-links/album/:album
 */
router.delete("/album/:album", csrfProtection, requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    // Get share link IDs before deleting so we can cancel timers
    const existingLinks = getShareLinksForAlbum(sanitizedAlbum);
    const linkIds = existingLinks.map(link => link.id);

    // Delete the share links
    const deletedCount = deleteShareLinksForAlbum(sanitizedAlbum);
    
    info(`[ShareLinks] Deleted ${deletedCount} share links for album: ${sanitizedAlbum}`);

    // Cancel expiry timers for deleted links
    if (linkIds.length > 0) {
      const { cancelShareLinkExpiryTimer } = await import('../services/share-link-expiry-tracker.js');
      for (const linkId of linkIds) {
        cancelShareLinkExpiryTimer(linkId);
      }
    }

    res.json({
      success: true,
      deletedCount
    });
  } catch (err) {
    error('[ShareLinks] Failed to delete share links:', err);
    res.status(500).json({ error: 'Failed to delete share links' });
  }
});

/**
 * Delete a single share link by id (admin only)
 * DELETE /api/share-links/:id
 */
router.delete("/:id", csrfProtection, requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) {
      res.status(400).json({ error: 'Invalid share link id' });
      return;
    }

    const deleted = deleteShareLink(id);
    if (!deleted) {
      res.status(404).json({ error: 'Share link not found' });
      return;
    }

    info(`[ShareLinks] Deleted share link id=${id}`);

    const { cancelShareLinkExpiryTimer } = await import('../services/share-link-expiry-tracker.js');
    cancelShareLinkExpiryTimer(id);

    res.json({
      success: true,
      deletedId: id
    });
  } catch (err) {
    error('[ShareLinks] Failed to delete share link:', err);
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

export default router;
