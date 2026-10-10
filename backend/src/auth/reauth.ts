/**
 * Step-up re-authentication for sensitive account actions (MFA disable, backup codes).
 *
 * Rules (ticket #3440 / #536 class):
 * - Password present → must prove password (session alone is never enough)
 * - Passwordless with passkeys → fresh passkey assertion OR recent-login window
 * - OAuth-only (no password, no passkey) → recent-login window only
 */

/** Max age of session.authenticatedAt accepted as "recent login" proof. */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

export type ReauthMethod = 'password' | 'passkey' | 'recent_login';

export type ReauthPlan =
  | { action: 'verify_password'; password: string }
  | { action: 'verify_passkey'; credential: unknown; sessionId: string }
  | { action: 'accept_recent_login' }
  | {
      action: 'reject';
      status: number;
      error: string;
      code: string;
      availableMethods: ReauthMethod[];
    };

export function userHasPassword(user: { password_hash?: string | null }): boolean {
  return typeof user.password_hash === 'string' && user.password_hash.length > 0;
}

export function userHasPasskeys(user: { passkeys?: unknown[] | null }): boolean {
  return Array.isArray(user.passkeys) && user.passkeys.length > 0;
}

/**
 * True when authenticatedAt is a finite timestamp within the reauth window of `now`.
 * Missing / non-finite timestamps fail closed (not recent).
 */
export function isRecentAuth(
  authenticatedAt: number | null | undefined,
  now: number = Date.now(),
  windowMs: number = REAUTH_WINDOW_MS
): boolean {
  if (authenticatedAt == null || !Number.isFinite(authenticatedAt)) {
    return false;
  }
  const age = now - authenticatedAt;
  return age >= 0 && age <= windowMs;
}

function availableMethods(hasPassword: boolean, hasPasskeys: boolean): ReauthMethod[] {
  const methods: ReauthMethod[] = [];
  if (hasPassword) methods.push('password');
  if (hasPasskeys) methods.push('passkey');
  if (!hasPassword) methods.push('recent_login');
  return methods;
}

/**
 * Decide how to re-prove identity for a sensitive action.
 * Does not perform crypto; callers verify password/passkey after this plan.
 */
export function planSensitiveReauth(input: {
  hasPassword: boolean;
  hasPasskeys: boolean;
  password?: string | null;
  passkeyCredential?: unknown;
  passkeySessionId?: string | null;
  sessionAuthenticatedAt?: number | null;
  now?: number;
  windowMs?: number;
}): ReauthPlan {
  const {
    hasPassword,
    hasPasskeys,
    password,
    passkeyCredential,
    passkeySessionId,
    sessionAuthenticatedAt,
    now = Date.now(),
    windowMs = REAUTH_WINDOW_MS,
  } = input;

  const methods = availableMethods(hasPassword, hasPasskeys);
  const passwordProvided = typeof password === 'string' && password.length > 0;
  const passkeyProvided =
    passkeyCredential != null &&
    typeof passkeySessionId === 'string' &&
    passkeySessionId.length > 0;

  // Password accounts: always require password proof (session theft must not disable MFA).
  if (hasPassword) {
    if (passwordProvided) {
      return { action: 'verify_password', password: password as string };
    }
    // Optional: allow passkey step-up for hybrid password+passkey accounts.
    if (passkeyProvided && hasPasskeys) {
      return {
        action: 'verify_passkey',
        credential: passkeyCredential,
        sessionId: passkeySessionId as string,
      };
    }
    return {
      action: 'reject',
      status: 401,
      error: 'Password required',
      code: 'password_required',
      availableMethods: methods,
    };
  }

  // Passwordless with passkeys: assertion or recent login.
  if (hasPasskeys) {
    if (passkeyProvided) {
      return {
        action: 'verify_passkey',
        credential: passkeyCredential,
        sessionId: passkeySessionId as string,
      };
    }
    if (isRecentAuth(sessionAuthenticatedAt, now, windowMs)) {
      return { action: 'accept_recent_login' };
    }
    return {
      action: 'reject',
      status: 401,
      error: 'Re-authentication required',
      code: 'passkey_reauth_required',
      availableMethods: methods,
    };
  }

  // OAuth-only: recent login only (no interactive second factor registered).
  if (isRecentAuth(sessionAuthenticatedAt, now, windowMs)) {
    return { action: 'accept_recent_login' };
  }

  return {
    action: 'reject',
    status: 401,
    error: 'Re-authentication required. Sign in again to continue.',
    code: 'reauth_required',
    availableMethods: methods,
  };
}
