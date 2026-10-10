/**
 * Extended Authentication Routes
 * Handles MFA setup, passkey registration, and user management
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import {
  getUserById,
  updateUser,
  updatePassword,
  enableMFA,
  disableMFA,
  addPasskey,
  removePasskey,
  updatePasskeyCounter,
  getPasskeyByCredentialId,
  verifyPassword,
  verifyBackupCode,
  createUser,
  getUserByEmail,
  getAllUsers,
  deleteUser,
  createInvitedUser,
  getUserByInviteToken,
  completeInvitation,
  setPasswordResetToken,
  getUserByPasswordResetToken,
  clearPasswordResetToken,
  resendInvitation,
  type User,
} from '../database-users.js';
import {
  generateTOTPSecret,
  generateQRCode,
  verifyTOTP,
  generateBackupCodes,
} from '../auth/mfa.js';
import {
  generatePasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  generatePasskeyAuthenticationOptions,
  verifyPasskeyAuthentication,
} from '../auth/passkeys.js';
import {
  planSensitiveReauth,
  userHasPasskeys,
  userHasPassword,
} from '../auth/reauth.js';
import crypto from 'crypto';
import { sendInvitationEmail, sendPasswordResetEmail, isEmailServiceEnabled, generateInvitationUrl } from '../email.js';
import { getCurrentConfig, reloadConfig } from '../config.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { destroySessionsForUser } from '../auth/session-invalidation.js';

const router = Router();

/**
 * Step-up re-auth for MFA disable / backup-code mint.
 * Password when present; else passkey assertion or recent-login window.
 * Returns null on success, or an Express response already sent.
 */
async function requireSensitiveReauth(
  req: Request,
  res: Response,
  user: User
): Promise<true | null> {
  const {
    password,
    passkeyCredential,
    passkeySessionId,
    // alternate names clients may send
    credential,
    sessionId,
  } = req.body || {};

  const plan = planSensitiveReauth({
    hasPassword: userHasPassword(user),
    hasPasskeys: userHasPasskeys(user),
    password,
    passkeyCredential: passkeyCredential ?? credential,
    passkeySessionId: passkeySessionId ?? sessionId,
    sessionAuthenticatedAt: (req.session as any)?.authenticatedAt,
  });

  if (plan.action === 'reject') {
    res.status(plan.status).json({
      error: plan.error,
      code: plan.code,
      availableMethods: plan.availableMethods,
    });
    return null;
  }

  if (plan.action === 'accept_recent_login') {
    return true;
  }

  if (plan.action === 'verify_password') {
    if (!verifyPassword(user, plan.password)) {
      res.status(401).json({ error: 'Invalid password', code: 'invalid_password' });
      return null;
    }
    return true;
  }

  // verify_passkey
  const challengeKey = `passkey-reauth-${plan.sessionId}`;
  const stored = challenges.get(challengeKey);
  if (!stored || stored.userId !== user.id || stored.expires < Date.now()) {
    res.status(400).json({
      error: 'Invalid or expired passkey reauth challenge',
      code: 'passkey_challenge_invalid',
    });
    return null;
  }

  const credentialPayload = plan.credential as { id?: string };
  if (!credentialPayload?.id) {
    res.status(400).json({ error: 'Missing passkey credential', code: 'passkey_required' });
    return null;
  }

  const result = getPasskeyByCredentialId(credentialPayload.id);
  if (!result || result.user.id !== user.id) {
    res.status(400).json({ error: 'Passkey not found', code: 'passkey_not_found' });
    return null;
  }

  const verification = await verifyPasskeyAuthentication(
    plan.credential as any,
    stored.challenge,
    result.passkey.credentialPublicKey,
    result.passkey.counter
  );

  if (!verification.verified) {
    res.status(401).json({ error: 'Passkey verification failed', code: 'passkey_invalid' });
    return null;
  }

  updatePasskeyCounter(user.id, result.passkey.id, verification.authenticationInfo.newCounter);
  challenges.delete(challengeKey);
  // Refresh authenticatedAt so subsequent sensitive ops in-window succeed without re-prompt.
  (req.session as any).authenticatedAt = Date.now();
  return true;
}

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
    error('[AuthExtended] Failed to send admin notification:', err);
  }
}

/**
 * Helper to get user ID from either Passport session or credential session
 */
function getUserIdFromRequest(req: Request): number | null {
  // Check credential session first (has database ID directly)
  if ((req.session as any)?.userId) {
    return parseInt((req.session as any).userId);
  }
  
  // Check Passport session (Google OAuth) - need to look up by email
  if (req.user && (req.user as any).email) {
    const email = (req.user as any).email;
    const user = getUserByEmail(email);
    return user ? user.id : null;
  }
  
  return null;
}

// Store temporary challenges in memory (in production, use Redis or session store)
const challenges = new Map<string, { challenge: string; userId?: number; user?: User; expires: number }>();

// Clean up expired challenges every 5 minutes
setInterval(() => {
  const now = Date.now();
  
  // Clean challenges
  for (const [key, value] of challenges.entries()) {
    if (value.expires < now) {
      challenges.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Get location from IP address using GeoIP
 */
async function getLocationFromIP(ip: string): Promise<string> {
  try {
    // Check for local/private IPs that won't have GeoIP data
    const isLocalIP = 
      ip === '::1' || 
      ip === '127.0.0.1' || 
      ip.startsWith('::ffff:127.') || 
      ip.startsWith('192.168.') || 
      ip.startsWith('10.') || 
      (ip.startsWith('172.') && parseInt(ip.split('.')[1]) >= 16 && parseInt(ip.split('.')[1]) <= 31) ||
      ip === 'unknown';
    
    if (isLocalIP) {
      return 'Local Network';
    }
    
    // Try to import maxmind module
    const maxmind = await import('@maxmind/geoip2-node');
    const path = await import('path');
    const fs = await import('fs');
    
    // Use DATA_DIR from config instead of relative path resolution
    const { DATA_DIR } = await import('../config.js');
    const dbPath = path.join(DATA_DIR, 'GeoLite2-City.mmdb');
    
    // Check if database exists
    if (!fs.existsSync(dbPath)) {
      info('[Auth] GeoIP database not found at:', dbPath);
      return 'Unknown';
    }
    
    const reader = await maxmind.Reader.open(dbPath);
    const response = reader.city(ip);
    
    if (response && response.city && response.country) {
      return `${response.city.names?.en || 'Unknown City'}, ${response.country.names?.en || 'Unknown Country'}`;
    } else if (response && response.country) {
      return response.country.names?.en || 'Unknown';
    }
    
    return 'Unknown';
  } catch (err) {
    // GeoIP is optional - don't fail if not available
    verbose('[Auth] GeoIP lookup failed (this is OK if not configured):', err);
    return 'Unknown';
  }
}

/**
 * Track failed login attempt and send notification on EVERY attempt
 */
async function trackFailedLogin(email: string, ipAddress: string): Promise<void> {
  try {
    // Get location from IP
    const location = await getLocationFromIP(ipAddress);
    
    await notifyAllAdmins(
      'notifications.backend.failedLoginAttemptsTitle',
      'notifications.backend.failedLoginAttemptsBody',
      'failed-login-attempts',
      'failedLoginAttempts',
      {
        userEmail: email,
        ipAddress,
        location: location || 'Unknown'
      }
    );
    warn(`[Auth] Failed login attempt for ${email} from ${ipAddress}${location ? ` (${location})` : ''}`);
  } catch (err) {
    error('[Auth] Failed to send failed login notification:', err);
  }
}

/**
 * Login with email/password (with optional MFA)
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { password, mfaToken } = req.body;
    const identifier = req.body.username ?? req.body.email;
    const email = typeof identifier === "string" ? identifier.trim() : "";
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const ipString = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress;

    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }

    // Find user by email
    const user = getUserByEmail(email);

    if (!user) {
      await trackFailedLogin(email, ipString);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is active
    if (!user.is_active) {
      await trackFailedLogin(email, ipString);
      return res.status(401).json({ error: 'Account is disabled' });
    }

    // Verify password
    if (!verifyPassword(user, password)) {
      await trackFailedLogin(email, ipString);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if MFA is enabled
    if (user.mfa_enabled) {
      if (!mfaToken) {
        // Store user in temporary challenge for MFA verification
        const sessionId = crypto.randomUUID();
        challenges.set(`mfa-login-${sessionId}`, {
          challenge: sessionId,
          userId: user.id,
          user: user,
          expires: Date.now() + 5 * 60 * 1000, // 5 minutes
        });
        
        return res.status(401).json({ 
          requiresMFA: true,
          sessionId,
          message: 'MFA verification required'
        });
      }

      // Verify MFA token
      if (!user.totp_secret || !verifyTOTP(user.totp_secret, mfaToken)) {
        // Try backup code
        if (!verifyBackupCode(user, mfaToken)) {
          await trackFailedLogin(email, ipString);
          return res.status(401).json({ error: 'Invalid MFA token' });
        }
      }
    }

    // Login successful — regenerate session ID before privilege elevation
    // (prevents session fixation on a pre-planted connect.sid)
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        error('[Login] Session regenerate error:', regenErr);
        return res.status(500).json({ error: 'Session creation failed' });
      }

      (req.session as any).userId = user.id;
      (req.session as any).authenticatedAt = Date.now();
      (req.session as any).user = {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
        mfa_enabled: user.mfa_enabled,
        passkey_enabled: user.passkeys && user.passkeys.length > 0,
        auth_methods: user.auth_methods,
      };

      info('[Login] Creating session for user:', {
        userId: user.id,
        email: user.email,
        role: user.role,
        mfa_enabled: user.mfa_enabled,
        sessionID: req.sessionID,
      });

      // Save session explicitly
      req.session.save((err) => {
        if (err) {
          error('[Login] Session save error:', err);
          return res.status(500).json({ error: 'Session creation failed' });
        }

        info('[Login] ✅ Session saved successfully:', {
          sessionID: req.sessionID,
          userId: (req.session as any).userId,
        });

        res.json({
          success: true,
          user: {
            id: user!.id,
            email: user!.email,
            name: user!.name,
            picture: user!.picture,
          },
        });
      });
    });
  } catch (err) {
    error('[AuthExtended] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * Invite new user (admin only)
 * Sends invitation email, user must complete signup
 */
router.post('/invite', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user already exists
    if (getUserByEmail(email)) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Determine role - only admins can create other admins
    let userRole = 'viewer'; // Default role
    const creatorUserId = getUserIdFromRequest(req);
    
    if (creatorUserId) {
      const creator = getUserById(creatorUserId);
      
      if (creator && creator.role === 'admin') {
        // Admin can set any role
        if (role === 'admin') {
          userRole = 'admin';
        } else if (role === 'manager') {
          userRole = 'manager';
        } else {
          userRole = 'viewer';
        }
      } else {
        // Non-admin can only create viewers
        userRole = 'viewer';
      }
    }

    // Generate invite token (secure random string)
    const inviteToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Get inviter name for email
    const inviter = creatorUserId ? getUserById(creatorUserId) : null;
    const inviterName = inviter?.name || 'Administrator';

    // Check if email service is enabled
    const emailEnabled = isEmailServiceEnabled();
    let emailSent = false;
    
    if (emailEnabled) {
      // Reload config from disk to get latest language setting
      reloadConfig();
      const currentConfig = getCurrentConfig();
      const siteLanguage = (currentConfig as any).branding?.language || 'en';
      info(`[Invite] Using site language: ${siteLanguage}`);
      
      // Try to send invitation email FIRST
      emailSent = await sendInvitationEmail(email, inviteToken, inviterName, siteLanguage);

      if (!emailSent) {
        // If email fails, don't create the user
        return res.status(500).json({ 
          error: 'Failed to send invitation email. Please check your SMTP configuration and try again.' 
        });
      }
    }

    // Create user (either after successful email or if email is disabled)
    const user = createInvitedUser({
      email,
      role: userRole,
      invite_token: inviteToken,
      invite_expires_at: expiresAt.toISOString(),
    });

    // Generate invite URL for manual sharing when email is disabled
    const inviteUrl = !emailEnabled ? generateInvitationUrl(inviteToken) : undefined;

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userInvitedTitle',
      'notifications.backend.userInvitedBody',
      'user-invited',
      'userInvited',
      {
        inviterName: (req.user as any).name || (req.user as any).email,
        userEmail: email
      }
    ).catch(err => error('[AuthExtended] Failed to send invitation notification:', err));

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        invite_token: inviteToken, // Include for copy functionality
      },
      emailSent,
      emailEnabled,
      inviteUrl, // Only present when email is disabled
    });
  } catch (err) {
    error('[AuthExtended] Invitation error:', err);
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

/**
 * Resend invitation (admin only)
 */
router.post('/invite/resend/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'invite_expired' && user.status !== 'invited') {
      return res.status(400).json({ error: 'User has already completed signup' });
    }

    // Generate new invite token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Get inviter name for email
    const creatorUserId = getUserIdFromRequest(req);
    const inviter = creatorUserId ? getUserById(creatorUserId) : null;
    const inviterName = inviter?.name || 'Administrator';

    // Check if email service is enabled
    const emailEnabled = isEmailServiceEnabled();
    let emailSent = false;
    
    if (emailEnabled) {
      // Reload config from disk to get latest language setting
      reloadConfig();
      const currentConfig = getCurrentConfig();
      const siteLanguage = (currentConfig as any).branding?.language || 'en';
      
      // Try to send invitation email FIRST
      emailSent = await sendInvitationEmail(user.email, inviteToken, inviterName, siteLanguage);

      if (!emailSent) {
        // If email fails, don't update the token
        return res.status(500).json({ 
          error: 'Failed to send invitation email. Please check your SMTP configuration and try again.' 
        });
      }
    }

    // Update user token (either after successful email or if email is disabled)
    resendInvitation(userId, inviteToken, expiresAt.toISOString());

    // Generate invite URL for manual sharing when email is disabled
    const inviteUrl = !emailEnabled ? generateInvitationUrl(inviteToken) : undefined;

    res.json({
      success: true,
      emailSent,
      emailEnabled,
      inviteUrl, // Only present when email is disabled
    });
  } catch (err) {
    error('[AuthExtended] Resend invitation error:', err);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

/**
 * Validate invite token
 */
router.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const user = getUserByInviteToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid invitation link' });
    }

    // Check if invitation has expired
    if (user.invite_expires_at) {
      const expiresAt = new Date(user.invite_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Invitation has expired' });
      }
    }

    // Check if user has already completed signup
    if (user.status === 'active') {
      return res.status(400).json({ error: 'Invitation already used' });
    }

    res.json({
      valid: true,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    error('[AuthExtended] Validate invite error:', err);
    res.status(500).json({ error: 'Failed to validate invitation' });
  }
});

/**
 * Complete user signup from invitation
 */
router.post('/invite/:token/complete', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { name, password, totpToken, setupToken } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: 'Name and password are required' });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = getUserByInviteToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid invitation link' });
    }

    // Check if invitation has expired
    if (user.invite_expires_at) {
      const expiresAt = new Date(user.invite_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Invitation has expired' });
      }
    }

    // Check if user has already completed signup
    if (user.status === 'active') {
      return res.status(400).json({ error: 'Invitation already used' });
    }

    // Complete the invitation (set name, password, mark as active)
    completeInvitation(user.id, { name, password });

    // If MFA setup was requested, enable it
    if (totpToken && setupToken) {
      const setup = challenges.get(`mfa-setup-${setupToken}`);
      if (setup && setup.userId === user.id && setup.expires > Date.now()) {
        // Verify TOTP token (from MFA setup during signup)
        // Note: This allows optional MFA setup during signup
        const { backupCodes } = req.body;
        if (backupCodes) {
          enableMFA(user.id, setup.challenge, backupCodes);
          challenges.delete(`mfa-setup-${setupToken}`);
        }
      }
    }

    // Get updated user
    const updatedUser = getUserById(user.id);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userAcceptedInviteTitle',
      'notifications.backend.userAcceptedInviteBody',
      'user-accepted-invite',
      'userAcceptedInvite',
      {
        userName: updatedUser!.name || 'New User',
        userEmail: updatedUser!.email
      }
    ).catch(err => error('[AuthExtended] Failed to send invite acceptance notification:', err));

    res.json({
      success: true,
      user: {
        id: updatedUser!.id,
        email: updatedUser!.email,
        name: updatedUser!.name,
        role: updatedUser!.role,
      },
    });
  } catch (err) {
    error('[AuthExtended] Complete signup error:', err);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

/**
 * Request password reset (public endpoint)
 */
router.post('/password-reset/request', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = getUserByEmail(email);

    // Uniform response for unknown emails and MFA accounts — do not reveal
    // registration or MFA status. Self-service reset is only issued for
    // non-MFA accounts; MFA recovery is via authenticated admin paths.
    if (!user || user.mfa_enabled || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
      return res.json({ success: true, message: 'If the email exists, a password reset link has been sent' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 1 hour from now
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Reload config from disk to get latest language setting
    reloadConfig();
    const currentConfig = getCurrentConfig();
    const siteLanguage = (currentConfig as any).branding?.language || 'en';

    // Try to send password reset email FIRST
    const emailSent = await sendPasswordResetEmail(user.email, resetToken, user.name, siteLanguage);

    if (!emailSent) {
      error('[Password Reset] Failed to send email');
      return res.status(500).json({ error: 'Failed to send password reset email. Please check your SMTP configuration.' });
    }

    // Only save reset token if email was sent successfully
    setPasswordResetToken(user.id, resetToken, expiresAt.toISOString());

    res.json({ 
      success: true, 
      message: 'If the email exists, a password reset link has been sent' 
    });
  } catch (err) {
    error('[AuthExtended] Password reset request error:', err);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

/**
 * Validate password reset token
 */
router.get('/password-reset/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const user = getUserByPasswordResetToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid password reset link' });
    }

    // Check if reset token has expired
    if (user.password_reset_expires_at) {
      const expiresAt = new Date(user.password_reset_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Password reset link has expired' });
      }
    }

    res.json({
      valid: true,
      email: user.email,
    });
  } catch (err) {
    error('[AuthExtended] Validate password reset error:', err);
    res.status(500).json({ error: 'Failed to validate password reset link' });
  }
});

/**
 * Complete password reset
 */
router.post('/password-reset/:token/complete', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = getUserByPasswordResetToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid password reset link' });
    }

    // Check if reset token has expired
    if (user.password_reset_expires_at) {
      const expiresAt = new Date(user.password_reset_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Password reset link has expired' });
      }
    }

    // Update password
    updatePassword(user.id, password);
    
    // Clear reset token
    clearPasswordResetToken(user.id);

    // Invalidate every existing session for this user (stolen cookies must not survive reset)
    await destroySessionsForUser(
      req.sessionStore as any,
      user.id,
      user.email,
      'password-reset'
    );

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.passwordChangedTitle',
      'notifications.backend.passwordChangedBody',
      'password-changed',
      'passwordChanged',
      {
        userName: user.name || user.email,
        userEmail: user.email
      }
    ).catch(err => error('[AuthExtended] Failed to send password change notification:', err));

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] Complete password reset error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

/**
 * Admin: Reset user's MFA (disable MFA only)
 */
router.post('/users/:userId/reset-mfa', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.mfa_enabled) {
      return res.status(400).json({ error: 'User does not have MFA enabled' });
    }

    // Disable MFA
    disableMFA(userId);

    info(`[Admin] MFA disabled for user ${user.email} (ID: ${userId})`);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.mfaDisabledTitle',
      'notifications.backend.mfaDisabledBody',
      'mfa-disabled',
      'mfaDisabled',
      {
        userName: user.name || user.email,
        userEmail: user.email
      }
    ).catch(err => error('[AuthExtended] Failed to send MFA disable notification:', err));

    res.json({
      success: true,
      message: 'MFA has been disabled',
    });
  } catch (err) {
    error('[AuthExtended] Reset MFA error:', err);
    res.status(500).json({ error: 'Failed to reset MFA' });
  }
});

// Send password reset email (admin-initiated)
router.post('/users/:userId/send-password-reset', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user uses password authentication
    const authMethods = user.auth_methods || [];
    if (!authMethods.includes('credentials')) {
      return res.status(400).json({ error: 'User does not use password authentication' });
    }

    // Generate password reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 1 hour from now
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Reload config from disk to get latest language setting
    reloadConfig();
    const currentConfig = getCurrentConfig();
    const siteLanguage = (currentConfig as any).branding?.language || 'en';

    // Try to send password reset email FIRST
    const emailSent = await sendPasswordResetEmail(user.email, resetToken, user.name, siteLanguage);

    if (!emailSent) {
      error('[Admin] Failed to send password reset email');
      return res.status(500).json({ 
        error: 'Failed to send password reset email. Please check your SMTP configuration.'
      });
    }

    // Only save reset token if email was sent successfully
    setPasswordResetToken(userId, resetToken, expiresAt.toISOString());

    info(`[Admin] Password reset email sent to ${user.email} (ID: ${userId})`);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.adminPasswordResetTitle',
      'notifications.backend.adminPasswordResetBody',
      'admin-password-reset',
      'adminPasswordReset',
      {
        adminName: (req.user as any).name || (req.user as any).email,
        targetUserEmail: user.email
      }
    ).catch(err => error('[AuthExtended] Failed to send admin password reset notification:', err));

    res.json({
      success: true,
      emailSent,
      message: 'Password reset email has been sent',
    });
  } catch (err) {
    error('[AuthExtended] Send password reset error:', err);
    res.status(500).json({ error: 'Failed to send password reset email' });
  }
});

/**
 * Change password
 */
router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    if (!verifyPassword(user, currentPassword)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Update password
    updatePassword(userId, newPassword);

    // Invalidate every session for this user (including other devices / stolen cookies)
    await destroySessionsForUser(
      req.sessionStore as any,
      userId,
      user.email,
      'change-password'
    );

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.passwordChangedTitle',
      'notifications.backend.passwordChangedBody',
      'password-changed',
      'passwordChanged',
      {
        userName: user.name || user.email,
        userEmail: user.email
      }
    ).catch(err => error('[AuthExtended] Failed to send password change notification:', err));

    // Force re-login on the current client as well
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        error('[AuthExtended] Failed to destroy current session after password change:', destroyErr);
        // Password already updated and other sessions wiped; still report success
        return res.json({ success: true, requiresReauth: true });
      }
      res.json({ success: true, requiresReauth: true });
    });
  } catch (err) {
    error('[AuthExtended] Password change error:', err);
    res.status(500).json({ error: 'Password change failed' });
  }
});

/**
 * Enable MFA - Step 1: Generate TOTP secret and QR code
 */
router.post('/mfa/setup', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.mfa_enabled) {
      return res.status(400).json({ error: 'MFA is already enabled' });
    }

    // Generate TOTP secret
    const { secret, otpauth_url } = generateTOTPSecret(user.email);
    
    // Generate QR code
    const qrCode = await generateQRCode(otpauth_url);
    
    // Generate backup codes
    const backupCodes = generateBackupCodes();

    // Store secret temporarily (not saved to DB until verification)
    const setupToken = crypto.randomBytes(32).toString('hex');
    challenges.set(`mfa-setup-${setupToken}`, {
      challenge: secret,
      userId,
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    res.json({
      setupToken,
      qrCode,
      secret,
      backupCodes,
    });
  } catch (err) {
    error('[AuthExtended] MFA setup error:', err);
    res.status(500).json({ error: 'MFA setup failed' });
  }
});

/**
 * Enable MFA - Step 2: Verify TOTP token and enable MFA
 */
router.post('/mfa/verify-setup', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { setupToken, token, backupCodes } = req.body;

    if (!setupToken || !token || !backupCodes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get temporary secret
    const setup = challenges.get(`mfa-setup-${setupToken}`);
    if (!setup || setup.userId !== userId || setup.expires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired setup token' });
    }

    // Verify TOTP token
    if (!verifyTOTP(setup.challenge, token)) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Enable MFA
    enableMFA(userId, setup.challenge, backupCodes);
    challenges.delete(`mfa-setup-${setupToken}`);

    // Update session to reflect MFA enabled
    if ((req.session as any)?.user) {
      (req.session as any).user.mfa_enabled = true;
    }

    // Get user info for notification
    const user = getUserById(userId);

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.userSetupMFATitle',
        'notifications.backend.userSetupMFABody',
        'user-setup-mfa',
        'mfaEnabled',
        {
          userName: user.name || user.email,
          userEmail: user.email
        }
      ).catch(err => error('[AuthExtended] Failed to send MFA setup notification:', err));
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] MFA verification error:', err);
    res.status(500).json({ error: 'MFA verification failed' });
  }
});

/**
 * Disable MFA
 * Requires step-up reauth: password if set, else passkey assertion or recent login.
 */
router.post('/mfa/disable', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const reauthOk = await requireSensitiveReauth(req, res, user);
    if (!reauthOk) {
      return;
    }

    disableMFA(userId);

    // Update session to reflect MFA disabled
    if ((req.session as any)?.user) {
      (req.session as any).user.mfa_enabled = false;
    }

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.mfaDisabledTitle',
        'notifications.backend.mfaDisabledBody',
        'mfa-disabled',
        'mfaDisabled',
        {
          userName: user.name || user.email,
          userEmail: user.email
        }
      ).catch(err => error('[AuthExtended] Failed to send MFA disable notification:', err));
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] MFA disable error:', err);
    res.status(500).json({ error: 'Failed to disable MFA' });
  }
});

/**
 * Get new backup codes
 * Requires step-up reauth: password if set, else passkey assertion or recent login.
 */
router.post('/mfa/backup-codes', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = getUserById(userId);
    if (!user || !user.mfa_enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    const reauthOk = await requireSensitiveReauth(req, res, user);
    if (!reauthOk) {
      return;
    }

    // Generate new backup codes
    const backupCodes = generateBackupCodes();
    enableMFA(userId, user.totp_secret!, backupCodes);

    res.json({ backupCodes });
  } catch (err) {
    error('[AuthExtended] Backup codes error:', err);
    res.status(500).json({ error: 'Failed to generate backup codes' });
  }
});

/**
 * Start passkey registration
 */
router.post('/passkey/register-options', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const options = await generatePasskeyRegistrationOptions(
      user.id,
      user.email,
      user.name || user.email,
      user.passkeys || []
    );

    info('[Passkey Registration] Generated options:', {
      challengeLength: options.challenge.length,
      challenge: options.challenge,
      userId: options.user.id,
      userIdLength: options.user.id.length,
      userName: options.user.name,
      rpId: options.rp.id,
      rpName: options.rp.name,
      excludeCredentialsCount: options.excludeCredentials?.length || 0,
    });

    // Store challenge
    const challengeKey = `passkey-reg-${userId}`;
    challenges.set(challengeKey, {
      challenge: options.challenge,
      userId,
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    res.json(options);
  } catch (err) {
    error('[AuthExtended] Passkey registration options error:', err);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

/**
 * Verify passkey registration
 */
router.post('/passkey/register-verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { credential, name } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Missing credential' });
    }

    // Get stored challenge
    const challengeKey = `passkey-reg-${userId}`;
    const stored = challenges.get(challengeKey);
    
    if (!stored || stored.userId !== userId || stored.expires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }

    // Verify registration
    const verification = await verifyPasskeyRegistration(credential, stored.challenge);

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    // Save passkey
    // Convert Uint8Array to base64url (URL-safe base64 without padding)
    const credentialIDBase64 = Buffer.from(verification.registrationInfo.credential.id)
      .toString('base64url');
    
    const credentialPublicKeyBase64 = Buffer.from(verification.registrationInfo.credential.publicKey)
      .toString('base64url');
    
    const passkey = {
      id: crypto.randomUUID(),
      name: name || `Passkey ${Date.now()}`,
      credentialID: credentialIDBase64,
      credentialPublicKey: credentialPublicKeyBase64,
      counter: verification.registrationInfo.credential.counter,
      transports: credential.response.transports,
    };

    addPasskey(userId, passkey);
    challenges.delete(challengeKey);

    // Get user info for notification
    const user = getUserById(userId);

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.userCreatedPasskeyTitle',
        'notifications.backend.userCreatedPasskeyBody',
        'user-created-passkey',
        'passkeyCreated',
        {
          userName: user.name || user.email,
          passkeyName: passkey.name
        }
      ).catch(err => error('[AuthExtended] Failed to send passkey creation notification:', err));
    }

    res.json({ success: true, passkey: { id: passkey.id, name: passkey.name } });
  } catch (err: any) {
    error('[AuthExtended] Passkey registration verification error:', err);
    error('[AuthExtended] Error stack:', err.stack);
    error('[AuthExtended] Error message:', err.message);
    res.status(500).json({ error: err.message || 'Passkey registration failed' });
  }
});

/**
 * Generate passkey options for step-up reauth (sensitive actions while already logged in).
 * Challenge is stored under passkey-reauth-${sessionId} and consumed by requireSensitiveReauth.
 */
router.post('/passkey/reauth-options', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!userHasPasskeys(user)) {
      return res.status(400).json({
        error: 'No passkeys registered',
        code: 'no_passkeys',
      });
    }

    const options = await generatePasskeyAuthenticationOptions(user.passkeys || []);
    const sessionId = crypto.randomUUID();
    challenges.set(`passkey-reauth-${sessionId}`, {
      challenge: options.challenge,
      userId,
      expires: Date.now() + 5 * 60 * 1000,
    });

    res.json({ ...options, sessionId });
  } catch (err) {
    error('[AuthExtended] Passkey reauth options error:', err);
    res.status(500).json({ error: 'Failed to generate reauth options' });
  }
});

/**
 * Get authentication options for passkey login.
 *
 * Public endpoint: always returns discoverable (empty allowCredentials) options
 * with a constant shape. Never looks up users by email — that would enable
 * account enumeration and credential-ID harvest for phishing.
 */
router.post('/passkey/auth-options', async (req: Request, res: Response) => {
  try {
    // Ignore email/body for enumeration resistance; client may still send email.
    const options = await generatePasskeyAuthenticationOptions([]);

    // Store challenge
    const sessionId = crypto.randomUUID();
    challenges.set(`passkey-auth-${sessionId}`, {
      challenge: options.challenge,
      expires: Date.now() + 5 * 60 * 1000,
    });

    res.json({ ...options, sessionId });
  } catch (err) {
    error('[AuthExtended] Passkey auth options error:', err);
    res.status(500).json({ error: 'Failed to generate auth options' });
  }
});

/**
 * Verify passkey authentication
 */
router.post('/passkey/auth-verify', async (req: Request, res: Response) => {
  try {
    const { credential, sessionId } = req.body;

    if (!credential || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get stored challenge
    const stored = challenges.get(`passkey-auth-${sessionId}`);
    if (!stored || stored.expires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }

    // Find passkey by credential ID
    const result = getPasskeyByCredentialId(credential.id);
    if (!result) {
      return res.status(400).json({ error: 'Passkey not found' });
    }

    const { user, passkey } = result;

    // Reject disabled accounts (same guard as password /login)
    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    // Verify authentication
    const verification = await verifyPasskeyAuthentication(
      credential,
      stored.challenge,
      passkey.credentialPublicKey,
      passkey.counter
    );

    if (!verification.verified) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    // Update counter
    updatePasskeyCounter(user.id, passkey.id, verification.authenticationInfo.newCounter);
    challenges.delete(`passkey-auth-${sessionId}`);

    // Create session — regenerate ID before privilege elevation (session fixation)
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        error('[Passkey Login] Session regenerate error:', regenErr);
        return res.status(500).json({ error: 'Session creation failed' });
      }

      (req.session as any).userId = user.id;
      (req.session as any).authenticatedAt = Date.now();
      (req.session as any).user = {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
        mfa_enabled: user.mfa_enabled,
        passkey_enabled: user.passkeys && user.passkeys.length > 0,
        auth_methods: user.auth_methods,
      };

      info('[Passkey Login] Creating session for user:', {
        userId: user.id,
        email: user.email,
        role: user.role,
        mfa_enabled: user.mfa_enabled,
        sessionID: req.sessionID,
      });

      // Save session explicitly
      req.session.save((err) => {
        if (err) {
          error('[Passkey Login] Session save error:', err);
          return res.status(500).json({ error: 'Session creation failed' });
        }

        info('[Passkey Login] ✅ Session saved successfully');

        res.json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            picture: user.picture,
          },
        });
      });
    });
  } catch (err) {
    error('[AuthExtended] Passkey auth verification error:', err);
    res.status(500).json({ error: 'Passkey authentication failed' });
  }
});

/**
 * List user's passkeys
 */
router.get('/passkey/list', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passkeys = (user.passkeys || []).map(pk => ({
      id: pk.id,
      name: pk.name,
      created_at: pk.created_at,
    }));

    res.json({ passkeys });
  } catch (err) {
    error('[AuthExtended] Passkey list error:', err);
    res.status(500).json({ error: 'Failed to list passkeys' });
  }
});

/**
 * Remove a passkey
 */
router.delete('/passkey/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const passkeyId = req.params.id;

    // Get user info before deleting
    const user = getUserById(userId);
    
    // Get passkey name before deletion
    let passkeyName = 'Passkey';
    if (user && user.passkeys) {
      const passkey = user.passkeys.find((pk: any) => pk.id === passkeyId);
      if (passkey) {
        passkeyName = passkey.name;
      }
    }

    const success = removePasskey(userId, passkeyId);

    if (!success) {
      return res.status(404).json({ error: 'Passkey not found' });
    }

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.passkeyDeletedTitle',
        'notifications.backend.passkeyDeletedBody',
        'passkey-deleted',
        'passkeyDeleted',
        {
          userName: user.name || user.email,
          passkeyName
        }
      ).catch(err => error('[AuthExtended] Failed to send passkey deletion notification:', err));
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] Passkey removal error:', err);
    res.status(500).json({ error: 'Failed to remove passkey' });
  }
});

/**
 * List all users (admin only)
 * Does not return invite_token — use GET /users/:userId/invite-link for copy-link.
 */
router.get('/users', requireAdmin, (req: Request, res: Response) => {
  try {
    const users = getAllUsers();
    
    // Remove sensitive data and add computed fields
    const sanitizedUsers = users.map((user: User) => {
      // Determine display status based on user state
      let displayStatus = null;
      
      if (user.status === 'invited') {
        // Check if invite has expired
        if (user.invite_expires_at) {
          const expiresAt = new Date(user.invite_expires_at);
          if (expiresAt < new Date()) {
            displayStatus = 'invite_expired';
          } else {
            displayStatus = 'invited';
          }
        } else {
          displayStatus = 'invited';
        }
      }
      
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        auth_methods: user.auth_methods,
        mfa_enabled: user.mfa_enabled,
        passkey_count: user.passkeys?.length || 0,
        is_active: user.is_active,
        status: displayStatus, // Only show status if invited or expired
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      };
    });

    res.json({ users: sanitizedUsers });
  } catch (err) {
    error('[AuthExtended] List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/**
 * Get invite URL for an invited user (admin only — copy-link; never bulk-list tokens)
 */
router.get('/users/:userId/invite-link', requireAdmin, (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'invited' && user.status !== 'invite_expired') {
      return res.status(400).json({ error: 'User has no pending invitation' });
    }

    if (!user.invite_token) {
      return res.status(404).json({ error: 'Invitation token not found' });
    }

    res.json({ inviteUrl: generateInvitationUrl(user.invite_token) });
  } catch (err) {
    error('[AuthExtended] Get invite link error:', err);
    res.status(500).json({ error: 'Failed to get invitation link' });
  }
});

/**
 * Delete user (admin only - can't delete yourself)
 */
router.delete('/users/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const currentUserId = getUserIdFromRequest(req);
    
    if (!currentUserId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    // Prevent deleting yourself
    if (userId === currentUserId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    
    // Get target user
    const targetUser = getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Delete user from database
    const success = deleteUser(userId);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete user' });
    }

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userDeletedTitle',
      'notifications.backend.userDeletedBody',
      'user-deleted',
      'userDeleted',
      {
        userEmail: targetUser.email,
        deletedBy: (req.user as any).name || (req.user as any).email
      }
    ).catch(err => error('[AuthExtended] Failed to send user deletion notification:', err));
    
    // Invalidate all sessions for this user (credential userId + passport email).
    // Passport stores session.passport.user as { id: googleProfileId, email, ... }
    // — never compare the whole object to the DB numeric id (handled in matcher).
    await destroySessionsForUser(
      req.sessionStore as any,
      userId,
      targetUser.email,
      'user-deleted'
    );
    
    info(`[User Management] User ${targetUser.email} (ID: ${userId}) deleted by user ID: ${currentUserId}`);
    
    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (err) {
    error('[AuthExtended] Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * Update user role (Admin only)
 */
router.patch('/users/:userId/role', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const { role } = req.body;
    const currentUserId = getUserIdFromRequest(req);
    
    if (!currentUserId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    // Validate role
    const validRoles = ['admin', 'manager', 'viewer'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, manager, or viewer' });
    }
    
    // Get target user
    const targetUser = getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Prevent changing your own role
    if (userId === currentUserId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    
    // Update user role
    updateUser(userId, { role });
    
    info(`[User Management] User ${targetUser.email} (ID: ${userId}) role changed to ${role} by user ID: ${currentUserId}`);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userRoleChangedTitle',
      'notifications.backend.userRoleChangedBody',
      'user-role-changed',
      'userRoleChanged',
      {
        userName: targetUser.name || targetUser.email,
        userEmail: targetUser.email,
        oldRole: targetUser.role,
        newRole: role
      }
    ).catch(err => error('[AuthExtended] Failed to send role change notification:', err));
    
    res.json({
      success: true,
      message: 'User role updated successfully',
      role,
    });
  } catch (err) {
    error('[AuthExtended] Update user role error:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

/**
 * Get user's enabled auth methods
 */
router.get('/user/methods', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      authMethods: user.auth_methods,
      mfaEnabled: user.mfa_enabled,
      passkeyCount: user.passkeys?.length || 0,
      hasPassword: !!user.password_hash,
      hasGoogleLinked: !!user.google_id,
    });
  } catch (err) {
    error('[AuthExtended] Auth methods error:', err);
    res.status(500).json({ error: 'Failed to get auth methods' });
  }
});

export default router;
