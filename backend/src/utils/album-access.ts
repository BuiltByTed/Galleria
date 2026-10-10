import type { Request } from 'express';
import { getAlbumState, getShareLinkBySecret, isShareLinkExpired } from '../database.js';
import { getUserByEmail, getUserById } from '../database-users.js';

type AlbumState = NonNullable<ReturnType<typeof getAlbumState>>;

export interface AlbumAccessResult {
  allowed: boolean;
  exists: boolean;
  albumState?: AlbumState;
  reason: 'not_found' | 'published' | 'authenticated' | 'share_link' | 'denied';
}

/**
 * True if the request has a live, active user session.
 * Re-validates against the DB (same rules as requireAuth) so deleted or
 * deactivated accounts do not retain access to unpublished content.
 */
export function isRequestAuthenticated(req: Request): boolean {
  // Credential login: session.userId is the DB numeric id
  if ((req.session as any)?.userId != null) {
    const userId = Number((req.session as any).userId);
    if (!Number.isFinite(userId)) {
      return false;
    }
    const dbUser = getUserById(userId);
    return Boolean(dbUser && dbUser.is_active);
  }

  // Passport (Google OAuth): req.user is { id: googleProfileId, email, ... }
  if (req.isAuthenticated && req.isAuthenticated()) {
    const sessionUser = req.user as any;
    if (sessionUser?.email) {
      const dbUser = getUserByEmail(sessionUser.email);
      return Boolean(dbUser && dbUser.is_active);
    }
    // Cannot verify without email — do not grant content access
    return false;
  }

  return false;
}

export function getShareKeyFromRequest(req: Request): string | null {
  const shareKeyParam = req.query.key;
  const shareKey = Array.isArray(shareKeyParam) ? shareKeyParam[0] : shareKeyParam;

  if (typeof shareKey !== 'string' || !/^[a-f0-9]{64}$/i.test(shareKey)) {
    return null;
  }

  return shareKey;
}

export function getValidShareLinkAlbum(req: Request): string | null {
  const shareKey = getShareKeyFromRequest(req);

  if (!shareKey) {
    return null;
  }

  const shareLink = getShareLinkBySecret(shareKey);

  if (!shareLink || isShareLinkExpired(shareLink)) {
    return null;
  }

  return shareLink.album;
}

export function hasValidShareLinkForAlbum(req: Request, albumName: string): boolean {
  return getValidShareLinkAlbum(req) === albumName;
}

export function getAlbumAccess(req: Request, albumName: string): AlbumAccessResult {
  const albumState = getAlbumState(albumName);

  if (!albumState) {
    return {
      allowed: false,
      exists: false,
      reason: 'not_found',
    };
  }

  if (albumState.published) {
    return {
      allowed: true,
      exists: true,
      albumState,
      reason: 'published',
    };
  }

  if (isRequestAuthenticated(req)) {
    return {
      allowed: true,
      exists: true,
      albumState,
      reason: 'authenticated',
    };
  }

  if (hasValidShareLinkForAlbum(req, albumName)) {
    return {
      allowed: true,
      exists: true,
      albumState,
      reason: 'share_link',
    };
  }

  return {
    allowed: false,
    exists: true,
    albumState,
    reason: 'denied',
  };
}

export function canAccessAlbum(req: Request, albumName: string): boolean {
  return getAlbumAccess(req, albumName).allowed;
}
