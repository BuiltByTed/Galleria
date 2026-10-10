/**
 * User Database Module
 * Manages user accounts for multi-auth system
 */

import { getDatabase } from './database.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const BCRYPT_ROUNDS = 12;

export interface User {
  id: number;
  // Legacy column name: stores an email or a local username (no email required).
  email: string;
  password_hash: string | null;
  auth_methods: string[]; // Parsed from JSON
  mfa_enabled: boolean;
  totp_secret: string | null;
  backup_codes: string[] | null; // Parsed from JSON
  passkeys: Passkey[] | null; // Parsed from JSON
  google_id: string | null;
  name: string | null;
  picture: string | null;
  role: string;
  is_active: boolean;
  email_verified: boolean;
  status: string; // 'invited', 'active', 'invite_expired'
  invite_token: string | null;
  invite_expires_at: string | null;
  password_reset_token: string | null;
  password_reset_expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface Passkey {
  id: string;
  name: string;
  credentialID: string;
  credentialPublicKey: string;
  counter: number;
  transports?: string[];
  created_at: string;
}

export interface AuthSession {
  id: string;
  user_id: number;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  mfa_verified: boolean;
  created_at: string;
}

/**
 * Helper to parse JSON fields from database
 */
function parseUser(row: any): User | null {
  if (!row) return null;
  
  return {
    ...row,
    auth_methods: row.auth_methods ? JSON.parse(row.auth_methods) : [],
    backup_codes: row.backup_codes ? JSON.parse(row.backup_codes) : null,
    passkeys: row.passkeys ? JSON.parse(row.passkeys) : null,
    mfa_enabled: Boolean(row.mfa_enabled),
    is_active: Boolean(row.is_active),
    email_verified: Boolean(row.email_verified),
  };
}

/**
 * Get user by ID
 */
export function getUserById(id: number): User | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const row = stmt.get(id);
  return parseUser(row);
}

/**
 * Get user by email
 */
export function getUserByEmail(email: string): User | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  const row = stmt.get(email);
  return parseUser(row);
}


/**
 * Get user by Google ID
 */
export function getUserByGoogleId(googleId: string): User | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE google_id = ?');
  const row = stmt.get(googleId);
  return parseUser(row);
}

/**
 * Create a new user
 */
export function createUser(data: {
  email: string;
  password?: string;
  auth_methods?: string[];
  google_id?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
  role?: string;
}): User {
  const db = getDatabase();
  
  const authMethods = data.auth_methods || ['google'];
  const passwordHash = data.password ? bcrypt.hashSync(data.password, BCRYPT_ROUNDS) : null;
  const role = data.role || 'viewer'; // Default to viewer role
  
  const stmt = db.prepare(`
    INSERT INTO users (
      email, password_hash, auth_methods, 
      google_id, name, picture, email_verified, role, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);
  
  const result = stmt.run(
    data.email,
    passwordHash,
    JSON.stringify(authMethods),
    data.google_id || null,
    data.name || null,
    data.picture || null,
    data.email_verified ? 1 : 0,
    role
  );
  
  return getUserById(result.lastInsertRowid as number)!;
}

/**
 * Update user profile
 */
export function updateUser(userId: number, data: {
  email?: string;
  name?: string;
  picture?: string;
  is_active?: boolean;
  role?: string;
}): boolean {
  const db = getDatabase();
  
  const updates: string[] = [];
  const values: any[] = [];
  
  if (data.email !== undefined) {
    updates.push('email = ?');
    values.push(data.email);
  }
  if (data.name !== undefined) {
    updates.push('name = ?');
    values.push(data.name);
  }
  if (data.picture !== undefined) {
    updates.push('picture = ?');
    values.push(data.picture);
  }
  if (data.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(data.is_active ? 1 : 0);
  }
  if (data.role !== undefined) {
    updates.push('role = ?');
    values.push(data.role);
  }
  
  if (updates.length === 0) return false;
  
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(userId);
  
  const stmt = db.prepare(`
    UPDATE users SET ${updates.join(', ')}
    WHERE id = ?
  `);
  
  const result = stmt.run(...values);
  return result.changes > 0;
}

/**
 * Update user password
 */
export function updatePassword(userId: number, newPassword: string): boolean {
  const db = getDatabase();
  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  
  const stmt = db.prepare(`
    UPDATE users 
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(passwordHash, userId);
  return result.changes > 0;
}

/**
 * Verify user password
 */
export function verifyPassword(user: User, password: string): boolean {
  if (!user.password_hash) return false;
  return bcrypt.compareSync(password, user.password_hash);
}

/**
 * Link Google account to existing user
 */
export function linkGoogleAccount(userId: number, googleId: string, name?: string, picture?: string): boolean {
  const db = getDatabase();
  
  // Get current auth methods
  const user = getUserById(userId);
  if (!user) return false;
  
  const authMethods = [...user.auth_methods];
  if (!authMethods.includes('google')) {
    authMethods.push('google');
  }
  
  const stmt = db.prepare(`
    UPDATE users 
    SET google_id = ?, auth_methods = ?, name = COALESCE(?, name), 
        picture = COALESCE(?, picture), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(googleId, JSON.stringify(authMethods), name, picture, userId);
  return result.changes > 0;
}

/**
 * Enable MFA for user
 */
export function enableMFA(userId: number, totpSecret: string, backupCodes: string[]): boolean {
  const db = getDatabase();
  
  // Hash backup codes
  const hashedCodes = backupCodes.map(code => bcrypt.hashSync(code, BCRYPT_ROUNDS));
  
  const stmt = db.prepare(`
    UPDATE users 
    SET mfa_enabled = 1, totp_secret = ?, backup_codes = ?, 
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(totpSecret, JSON.stringify(hashedCodes), userId);
  return result.changes > 0;
}

/**
 * Disable MFA for user
 */
export function disableMFA(userId: number): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE users 
    SET mfa_enabled = 0, totp_secret = NULL, backup_codes = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(userId);
  return result.changes > 0;
}

/**
 * Verify backup code and remove it if valid
 */
export function verifyBackupCode(user: User, code: string): boolean {
  if (!user.backup_codes || user.backup_codes.length === 0) {
    return false;
  }
  
  // Find matching backup code
  let matchIndex = -1;
  for (let i = 0; i < user.backup_codes.length; i++) {
    if (bcrypt.compareSync(code, user.backup_codes[i])) {
      matchIndex = i;
      break;
    }
  }
  
  if (matchIndex === -1) return false;
  
  // Remove used backup code
  const db = getDatabase();
  const remainingCodes = user.backup_codes.filter((_, i) => i !== matchIndex);
  
  const stmt = db.prepare(`
    UPDATE users 
    SET backup_codes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  stmt.run(JSON.stringify(remainingCodes), user.id);
  return true;
}

/**
 * Add passkey to user
 */
export function addPasskey(userId: number, passkey: Omit<Passkey, 'created_at'>): boolean {
  const db = getDatabase();
  const user = getUserById(userId);
  if (!user) return false;
  
  const passkeys = user.passkeys || [];
  passkeys.push({
    ...passkey,
    created_at: new Date().toISOString(),
  });
  
  // Add 'passkey' to auth methods if not already there
  const authMethods = [...user.auth_methods];
  if (!authMethods.includes('passkey')) {
    authMethods.push('passkey');
  }
  
  const stmt = db.prepare(`
    UPDATE users 
    SET passkeys = ?, auth_methods = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(JSON.stringify(passkeys), JSON.stringify(authMethods), userId);
  return result.changes > 0;
}

/**
 * Remove passkey from user
 */
export function removePasskey(userId: number, passkeyId: string): boolean {
  const db = getDatabase();
  const user = getUserById(userId);
  if (!user || !user.passkeys) return false;
  
  const passkeys = user.passkeys.filter(pk => pk.id !== passkeyId);
  
  // If no more passkeys, remove 'passkey' from auth methods
  const authMethods = passkeys.length === 0
    ? user.auth_methods.filter(m => m !== 'passkey')
    : user.auth_methods;
  
  const stmt = db.prepare(`
    UPDATE users 
    SET passkeys = ?, auth_methods = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(
    passkeys.length > 0 ? JSON.stringify(passkeys) : null,
    JSON.stringify(authMethods),
    userId
  );
  
  return result.changes > 0;
}

/**
 * Update passkey counter (for replay attack prevention)
 */
export function updatePasskeyCounter(userId: number, passkeyId: string, newCounter: number): boolean {
  const db = getDatabase();
  const user = getUserById(userId);
  if (!user || !user.passkeys) return false;
  
  const passkeys = user.passkeys.map(pk => 
    pk.id === passkeyId ? { ...pk, counter: newCounter } : pk
  );
  
  const stmt = db.prepare(`
    UPDATE users 
    SET passkeys = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(JSON.stringify(passkeys), userId);
  return result.changes > 0;
}

/**
 * Get passkey by credential ID
 */
export function getPasskeyByCredentialId(credentialId: string): { user: User; passkey: Passkey } | null {
  const db = getDatabase();
  
  // Search all users for matching passkey
  const stmt = db.prepare('SELECT * FROM users WHERE passkeys IS NOT NULL');
  const users = stmt.all();
  
  for (const row of users) {
    const user = parseUser(row);
    if (!user || !user.passkeys) continue;
    
    const passkey = user.passkeys.find(pk => pk.credentialID === credentialId);
    if (passkey) {
      return { user, passkey };
    }
  }
  
  return null;
}

/**
 * Update last login time
 */
export function updateLastLogin(userId: number): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE users 
    SET last_login_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(userId);
  return result.changes > 0;
}

/**
 * Record MFA attempt
 */
export function recordMFAAttempt(userId: number, ipAddress: string, success: boolean): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO mfa_attempts (user_id, ip_address, success)
    VALUES (?, ?, ?)
  `);
  
  stmt.run(userId, ipAddress, success ? 1 : 0);
}

/**
 * Get recent MFA attempts for rate limiting
 */
export function getRecentMFAAttempts(userId: number, minutes: number = 15): number {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM mfa_attempts
    WHERE user_id = ? 
      AND success = 0
      AND created_at > datetime('now', '-${minutes} minutes')
  `);
  
  const result = stmt.get(userId) as { count: number };
  return result.count;
}

/**
 * Get all active users
 */
export function getAllUsers(): User[] {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM users 
    WHERE is_active = 1
    ORDER BY created_at DESC
  `);
  
  const rows = stmt.all();
  return rows.map((row: any) => parseUser(row)).filter((u: User | null): u is User => u !== null);
}

/**
 * Clean up expired sessions
 */
export function cleanupExpiredSessions(): number {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM auth_sessions
    WHERE expires_at < datetime('now')
  `);
  
  const result = stmt.run();
  return result.changes;
}

/**
 * Delete user account
 */
export function deleteUser(userId: number): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare('DELETE FROM users WHERE id = ?');
  const result = stmt.run(userId);
  return result.changes > 0;
}

/**
 * Create invited user (without password, pending setup)
 */
export function createInvitedUser(data: {
  email: string;
  role?: string;
  invite_token: string;
  invite_expires_at: string;
}): User {
  const db = getDatabase();
  
  const role = data.role || 'viewer';
  
  const stmt = db.prepare(`
    INSERT INTO users (
      email, role, status, invite_token, invite_expires_at,
      auth_methods, email_verified
    )
    VALUES (?, ?, 'invited', ?, ?, '[]', 0)
  `);
  
  const result = stmt.run(
    data.email,
    role,
    data.invite_token,
    data.invite_expires_at
  );
  
  return getUserById(result.lastInsertRowid as number)!;
}

/**
 * Get user by invite token
 */
export function getUserByInviteToken(token: string): User | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE invite_token = ?');
  const row = stmt.get(token);
  return parseUser(row);
}

/**
 * Complete user invitation (set name, password, mark as active)
 */
export function completeInvitation(
  userId: number,
  data: {
    name: string;
    password: string;
  }
): boolean {
  const db = getDatabase();
  
  const passwordHash = bcrypt.hashSync(data.password, BCRYPT_ROUNDS);
  
  const stmt = db.prepare(`
    UPDATE users 
    SET name = ?, password_hash = ?, status = 'active',
        invite_token = NULL, invite_expires_at = NULL,
        auth_methods = '["credentials"]', email_verified = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(data.name, passwordHash, userId);
  return result.changes > 0;
}

/**
 * Update user status
 */
export function updateUserStatus(userId: number, status: string): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE users 
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(status, userId);
  return result.changes > 0;
}

/**
 * Set password reset token
 */
export function setPasswordResetToken(
  userId: number,
  token: string,
  expiresAt: string
): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE users 
    SET password_reset_token = ?, password_reset_expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(token, expiresAt, userId);
  return result.changes > 0;
}

/**
 * Get user by password reset token
 */
export function getUserByPasswordResetToken(token: string): User | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE password_reset_token = ?');
  const row = stmt.get(token);
  return parseUser(row);
}

/**
 * Clear password reset token
 */
export function clearPasswordResetToken(userId: number): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE users 
    SET password_reset_token = NULL, password_reset_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(userId);
  return result.changes > 0;
}

/**
 * Resend invitation (generate new token and expiry)
 */
export function resendInvitation(
  userId: number,
  newToken: string,
  newExpiresAt: string
): boolean {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE users 
    SET invite_token = ?, invite_expires_at = ?, status = 'invited',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  const result = stmt.run(newToken, newExpiresAt, userId);
  return result.changes > 0;
}
