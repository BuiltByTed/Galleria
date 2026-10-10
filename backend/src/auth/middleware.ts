/**
 * Authentication Middleware
 * Handles authentication checks for protected routes
 * Supports both Passport-based sessions (Google OAuth) and credential-based sessions
 */

import { Request, Response, NextFunction } from 'express';
import { getUserByEmail, getUserById } from '../database-users.js';
import { trace } from '../utils/logger.js';

/**
 * Middleware to check if user is authenticated
 * Works with both Passport sessions and credential-based sessions
 * Also verifies user still exists in database
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Debug logging
  trace('[Auth Middleware]', {
    path: req.path,
    method: req.method,
    hasIsAuthenticated: !!req.isAuthenticated,
    isAuthenticatedResult: req.isAuthenticated ? req.isAuthenticated() : false,
    sessionId: req.sessionID,
    hasUserId: !!(req.session as any)?.userId,
    userId: (req.session as any)?.userId,
    cookies: Object.keys(req.cookies || {}),
  });
  
  // Check if authenticated via Passport (Google OAuth)
  if (req.isAuthenticated && req.isAuthenticated()) {
    const sessionUser = req.user as any;
    
    // Verify user still exists and is active in database
    if (sessionUser?.email) {
      const dbUser = getUserByEmail(sessionUser.email);
      if (!dbUser) {
        trace('[Auth Middleware] User no longer exists (Google OAuth):', sessionUser.email);
        // Destroy session and return 401
        req.logout((err) => {
          if (err) trace('[Auth Middleware] Logout error:', err);
        });
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'User account no longer exists' });
      }
      if (!dbUser.is_active) {
        trace('[Auth Middleware] User deactivated (Google OAuth):', sessionUser.email);
        req.logout((err) => {
          if (err) trace('[Auth Middleware] Logout error:', err);
        });
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Account is disabled' });
      }
    }
    
    trace('[Auth Middleware] Authenticated via Passport');
    return next();
  }
  
  // Check if authenticated via credential login (session.userId)
  if ((req.session as any)?.userId) {
    const userId = (req.session as any).userId;
    
    // Verify user still exists and is active in database
    const dbUser = getUserById(userId);
    if (!dbUser) {
      trace('[Auth Middleware] User no longer exists (credentials):', userId);
      // Destroy session and return 401
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'User account no longer exists' });
    }
    if (!dbUser.is_active) {
      trace('[Auth Middleware] User deactivated (credentials):', userId);
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Account is disabled' });
    }
    
    trace('[Auth Middleware] Authenticated via credentials');
    return next();
  }
  
  trace('[Auth Middleware] Not authenticated');
  return res.status(401).json({ error: 'Not authenticated' });
}

/**
 * Middleware to check if user is authenticated (compatible with old isAuthenticated)
 * This maintains backwards compatibility with existing routes
 */
export const isAuthenticated = requireAuth;

/**
 * Build privileged-check user from a live DB row.
 * Role and is_active must never come from session snapshots (frozen at login).
 */
function userFromDb(dbUser: NonNullable<ReturnType<typeof getUserById>>, sessionUser: any = {}) {
  return {
    ...sessionUser,
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name ?? sessionUser.name,
    picture: dbUser.picture ?? sessionUser.picture,
    role: dbUser.role,
    is_active: dbUser.is_active,
    mfa_enabled: dbUser.mfa_enabled,
    auth_methods: dbUser.auth_methods,
  };
}

/**
 * Helper function to get user from request with role lookup from database.
 * Always reloads role and is_active from the DB so demotion/deactivation
 * take effect without requiring re-login.
 */
async function getUserFromRequest(req: Request): Promise<any> {
  // Credential session: session.user.role is a login-time snapshot — ignore it
  if ((req.session as any)?.userId) {
    const userId = (req.session as any).userId;
    const dbUser = getUserById(userId);
    if (!dbUser) {
      return null;
    }
    return userFromDb(dbUser, (req.session as any).user || {});
  }

  // Passport session (Google OAuth) — always look up role from DB
  if (req.user) {
    const sessionUser = req.user as any;
    let dbUser = sessionUser.email ? getUserByEmail(sessionUser.email) : null;
    if (!dbUser && typeof sessionUser.id === 'number') {
      dbUser = getUserById(sessionUser.id);
    }
    if (!dbUser) {
      return null;
    }
    return userFromDb(dbUser, sessionUser);
  }

  // Defensive: credential session with user blob but missing userId
  if ((req.session as any)?.user) {
    const sessionUser = (req.session as any).user;
    if (sessionUser.id != null) {
      const id = typeof sessionUser.id === 'string' ? parseInt(sessionUser.id, 10) : sessionUser.id;
      if (!Number.isNaN(id)) {
        const dbUser = getUserById(id);
        if (dbUser) {
          return userFromDb(dbUser, sessionUser);
        }
      }
    }
    if (sessionUser.email) {
      const dbUser = getUserByEmail(sessionUser.email);
      if (dbUser) {
        return userFromDb(dbUser, sessionUser);
      }
    }
  }

  return null;
}

/**
 * Middleware to check if user is authenticated AND has admin role
 * Viewers can view but not modify
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // First check if authenticated
  const isAuth = (req.isAuthenticated && req.isAuthenticated()) || !!(req.session as any)?.userId;
  
  if (!isAuth) {
    trace('[Admin Middleware] Not authenticated');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  // Get user and check role (fresh from DB — not session snapshot)
  const user = await getUserFromRequest(req);
  
  trace('[Admin Middleware] User lookup result:', {
    hasUser: !!user,
    email: user?.email,
    role: user?.role,
    is_active: user?.is_active,
    id: user?.id,
  });
  
  if (!user || !user.role) {
    trace('[Admin Middleware] No user or role found');
    return res.status(403).json({ error: 'Access denied - role required' });
  }

  if (user.is_active === false) {
    trace('[Admin Middleware] User is inactive:', user.email);
    return res.status(401).json({ error: 'Account is disabled' });
  }
  
  if (user.role !== 'admin') {
    trace('[Admin Middleware] User is not admin:', user.role);
    return res.status(403).json({ error: 'Access denied - admin role required' });
  }
  
  // Attach user to request for use in route handlers
  req.user = user;
  
  trace('[Admin Middleware] User is admin');
  next();
}

/**
 * Middleware to check if user is authenticated AND has manager or admin role
 * Managers can modify content (albums, photos, branding, links) but not system settings
 */
export async function requireManager(req: Request, res: Response, next: NextFunction) {
  // First check if authenticated
  const isAuth = (req.isAuthenticated && req.isAuthenticated()) || !!(req.session as any)?.userId;
  
  if (!isAuth) {
    trace('[Manager Middleware] Not authenticated');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  // Get user and check role (fresh from DB — not session snapshot)
  const user = await getUserFromRequest(req);
  
  if (!user || !user.role) {
    trace('[Manager Middleware] No user or role found');
    return res.status(403).json({ error: 'Access denied - role required' });
  }

  if (user.is_active === false) {
    trace('[Manager Middleware] User is inactive:', user.email);
    return res.status(401).json({ error: 'Account is disabled' });
  }
  
  if (user.role !== 'admin' && user.role !== 'manager') {
    trace('[Manager Middleware] User is not admin or manager:', user.role);
    return res.status(403).json({ error: 'Access denied - manager role required' });
  }
  
  // Attach user to request for use in route handlers
  req.user = user;
  
  trace('[Manager Middleware] User is admin or manager');
  next();
}
