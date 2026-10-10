/**
 * Share Link Expiry Tracker Service
 * Uses precise timers to notify admins exactly when share links expire
 */

import { getDatabase } from '../database.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { getAllUsers } from '../database-users.js';
import { info, error, warn } from '../utils/logger.js';

const db = getDatabase();

interface ShareLink {
  id: number;
  album: string;
  secret_key: string;
  created_at: string;
  expires_at: string | null;
  notified: number; // 0 = not notified, 1 = notified
}

// Store active timers by share link ID
const expiryTimers = new Map<number, NodeJS.Timeout>();

// Maximum setTimeout delay (about 24.8 days in milliseconds)
const MAX_TIMEOUT_MS = 2147483647;

/**
 * Send notification to all admins about an expired share link
 */
async function notifyExpiredLink(link: ShareLink): Promise<void> {
  const admins = getAllUsers().filter(u => u.role === 'admin');

  for (const admin of admins) {
    const title = await translateNotification(
      'notifications.backend.shareLinkExpiredTitle',
      { albumName: link.album }
    );
    const body = await translateNotification(
      'notifications.backend.shareLinkExpiredBody',
      { albumName: link.album }
    );

    await sendNotificationToUser(admin.id, {
      title,
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'share-link-expired',
      requireInteraction: false
    }, 'shareLinkExpired');
  }

  info(`[ShareLinkExpiryTracker] Notified admins about expired link for album: ${link.album}`);
}

/**
 * Schedule a timer for a specific share link expiration
 */
function scheduleExpiryTimer(link: ShareLink): void {
  if (!link.expires_at) {
    return; // No expiration, nothing to schedule
  }

  // Clear existing timer if any
  const existingTimer = expiryTimers.get(link.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    expiryTimers.delete(link.id);
  }

  const expiresAt = new Date(link.expires_at).getTime();
  const now = Date.now();
  const delay = expiresAt - now;

  // If already expired, notify immediately
  if (delay <= 0) {
    if (link.notified === 0) {
      info(`[ShareLinkExpiryTracker] Link ${link.id} (${link.album}) already expired, notifying now`);
      notifyExpiredLink(link).then(() => {
        // Mark as notified
        const updateStmt = db.prepare('UPDATE share_links SET notified = 1 WHERE id = ?');
        updateStmt.run(link.id);
      }).catch(err => {
        error('[ShareLinkExpiryTracker] Failed to notify about expired link:', err);
      });
    }
    return;
  }

  // If delay exceeds max setTimeout, schedule a check for later
  if (delay > MAX_TIMEOUT_MS) {
    info(`[ShareLinkExpiryTracker] Link ${link.id} expires in ${Math.round(delay / 86400000)} days, will recheck later`);
    const timer = setTimeout(() => {
      // Reload link from database and reschedule
      const reloadStmt = db.prepare('SELECT * FROM share_links WHERE id = ?');
      const reloadedLink = reloadStmt.get(link.id) as ShareLink | undefined;
      if (reloadedLink) {
        scheduleExpiryTimer(reloadedLink);
      }
    }, MAX_TIMEOUT_MS);
    
    expiryTimers.set(link.id, timer);
    return;
  }

  // Schedule the notification
  info(`[ShareLinkExpiryTracker] Scheduled expiry notification for link ${link.id} (${link.album}) in ${Math.round(delay / 1000)} seconds`);
  
  const timer = setTimeout(() => {
    info(`[ShareLinkExpiryTracker] Link ${link.id} (${link.album}) has expired, sending notification`);
    
    notifyExpiredLink(link).then(() => {
      // Mark as notified
      const updateStmt = db.prepare('UPDATE share_links SET notified = 1 WHERE id = ?');
      updateStmt.run(link.id);
    }).catch(err => {
      error('[ShareLinkExpiryTracker] Failed to notify about expired link:', err);
    }).finally(() => {
      // Clean up timer
      expiryTimers.delete(link.id);
    });
  }, delay);

  expiryTimers.set(link.id, timer);
}

/**
 * Load all share links from database and schedule timers
 */
export function loadAndScheduleExpiryTimers(): void {
  try {
    info('[ShareLinkExpiryTracker] Loading share links from database to schedule expiry timers...');

    // Find all share links with expiration dates that haven't been notified
    const stmt = db.prepare(`
      SELECT id, album, secret_key, created_at, expires_at, notified
      FROM share_links
      WHERE expires_at IS NOT NULL
        AND notified = 0
    `);

    const links = stmt.all() as ShareLink[];

    if (links.length === 0) {
      info('[ShareLinkExpiryTracker] No active share links with expiration found');
      return;
    }

    info(`[ShareLinkExpiryTracker] Found ${links.length} share link(s) with expiration, scheduling timers...`);

    // Schedule a timer for each link
    for (const link of links) {
      scheduleExpiryTimer(link);
    }

    info('[ShareLinkExpiryTracker] All expiry timers scheduled');
  } catch (err) {
    error('[ShareLinkExpiryTracker] Error loading and scheduling expiry timers:', err);
  }
}

/**
 * Schedule expiry timer for a newly created share link
 * Call this when creating a new share link
 */
export function scheduleNewShareLinkExpiry(linkId: number): void {
  try {
    const stmt = db.prepare(`
      SELECT id, album, secret_key, created_at, expires_at, notified
      FROM share_links
      WHERE id = ?
    `);

    const link = stmt.get(linkId) as ShareLink | undefined;

    if (!link) {
      warn(`[ShareLinkExpiryTracker] Share link ${linkId} not found`);
      return;
    }

    if (!link.expires_at) {
      info(`[ShareLinkExpiryTracker] Share link ${linkId} has no expiration, skipping timer`);
      return;
    }

    scheduleExpiryTimer(link);
  } catch (err) {
    error('[ShareLinkExpiryTracker] Error scheduling new share link expiry:', err);
  }
}

/**
 * Cancel expiry timer for a deleted share link
 * Call this when deleting a share link
 */
export function cancelShareLinkExpiryTimer(linkId: number): void {
  const timer = expiryTimers.get(linkId);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(linkId);
    info(`[ShareLinkExpiryTracker] Cancelled expiry timer for link ${linkId}`);
  }
}

/**
 * Start share link expiry tracking
 * Loads all existing links from database and schedules precise timers
 */
export function startShareLinkExpiryTracking(): void {
  info('[ShareLinkExpiryTracker] Starting share link expiry tracking with precise timers');
  loadAndScheduleExpiryTimers();
}
