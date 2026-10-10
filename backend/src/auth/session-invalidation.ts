/**
 * Destroy all express-session store entries that belong to a given user.
 * Used after password change/reset (and user deletion) so stolen cookies die immediately.
 */

import { error, info } from '../utils/logger.js';

export type SessionRecord = {
  userId?: number | string;
  user?: {
    id?: number | string;
    email?: string;
  };
  passport?: {
    // Google OAuth serializeUser stores full profile fields, not DB id alone
    user?: number | string | {
      id?: number | string;
      email?: string;
      name?: string;
      picture?: string;
    };
  };
};

export type SessionStoreLike = {
  all?: (
    callback: (err: Error | null, sessions: Record<string, SessionRecord> | SessionRecord[] | null) => void
  ) => void;
  destroy: (sid: string, callback?: (err?: Error) => void) => void;
};

/**
 * True when a stored session is authenticated as the given user.
 * Credential sessions: session.userId / session.user.id
 * Passport (Google): session.passport.user.email (or legacy id scalar)
 */
export function sessionBelongsToUser(
  session: SessionRecord | null | undefined,
  userId: number,
  userEmail?: string | null
): boolean {
  if (!session) return false;

  if (session.userId != null && Number(session.userId) === userId) {
    return true;
  }

  if (session.user?.id != null && Number(session.user.id) === userId) {
    return true;
  }

  if (userEmail) {
    const email = userEmail.toLowerCase();
    if (session.user?.email && session.user.email.toLowerCase() === email) {
      return true;
    }
  }

  const passportUser = session.passport?.user;
  if (passportUser == null) {
    return false;
  }

  if (typeof passportUser === 'object') {
    if (passportUser.id != null && Number(passportUser.id) === userId) {
      return true;
    }
    if (
      userEmail &&
      passportUser.email &&
      passportUser.email.toLowerCase() === userEmail.toLowerCase()
    ) {
      return true;
    }
    return false;
  }

  // Scalar passport user (numeric id or email string)
  if (typeof passportUser === 'number' || /^\d+$/.test(String(passportUser))) {
    return Number(passportUser) === userId;
  }

  if (userEmail && String(passportUser).toLowerCase() === userEmail.toLowerCase()) {
    return true;
  }

  return false;
}

function normalizeSessions(
  sessions: Record<string, SessionRecord> | SessionRecord[] | null | undefined
): Array<[string, SessionRecord]> {
  if (!sessions) return [];

  if (Array.isArray(sessions)) {
    // Some stores return an array; sid may live on the object
    return sessions
      .map((session, index) => {
        const sid =
          (session as SessionRecord & { id?: string; sid?: string }).id ||
          (session as SessionRecord & { sid?: string }).sid ||
          String(index);
        return [sid, session] as [string, SessionRecord];
      });
  }

  return Object.entries(sessions);
}

/**
 * Destroy every session in the store that matches userId / userEmail.
 * Resolves when all destroy callbacks finish (or immediately if store has no .all).
 */
export function destroySessionsForUser(
  sessionStore: SessionStoreLike | undefined | null,
  userId: number,
  userEmail?: string | null,
  logContext = 'password-change'
): Promise<number> {
  return new Promise((resolve) => {
    if (!sessionStore?.all) {
      resolve(0);
      return;
    }

    sessionStore.all((err, sessions) => {
      if (err) {
        error(`[Session] Failed to list sessions for ${logContext}:`, err);
        resolve(0);
        return;
      }

      const entries = normalizeSessions(sessions).filter(([, session]) =>
        sessionBelongsToUser(session, userId, userEmail)
      );

      if (entries.length === 0) {
        resolve(0);
        return;
      }

      let remaining = entries.length;
      let destroyed = 0;

      for (const [sid] of entries) {
        sessionStore.destroy(sid, (destroyErr) => {
          if (destroyErr) {
            error(`[Session] Failed to destroy session ${sid}:`, destroyErr);
          } else {
            destroyed += 1;
            info(`[Session] Destroyed session ${sid} for user ${userId} (${logContext})`);
          }
          remaining -= 1;
          if (remaining === 0) {
            resolve(destroyed);
          }
        });
      }
    });
  });
}
