/**
 * Session ownership helpers for auth wipe / content-path checks.
 * Credential logins store session.userId (DB numeric id).
 * Passport (Google OAuth) stores session.passport.user as
 * { id: googleProfileId, email, name, picture } — never the DB id alone.
 */

/**
 * True if a store session blob belongs to the given user id/email.
 * Used when deleting a user to destroy their open sessions.
 */
export function sessionBelongsToUser(
  session: any,
  userId: number,
  email: string
): boolean {
  if (!session || !Number.isFinite(userId)) {
    return false;
  }

  const normalizedEmail = typeof email === 'string' ? email.toLowerCase() : '';

  // Credential sessions
  if (session.userId != null && Number(session.userId) === userId) {
    return true;
  }

  if (session.user) {
    if (session.user.id != null && Number(session.user.id) === userId) {
      return true;
    }
    if (
      normalizedEmail &&
      typeof session.user.email === 'string' &&
      session.user.email.toLowerCase() === normalizedEmail
    ) {
      return true;
    }
  }

  // Passport sessions
  const passportUser = session.passport?.user;
  if (passportUser == null) {
    return false;
  }

  // Object form (current Passport serializeUser stores full user object)
  if (typeof passportUser === 'object') {
    if (
      normalizedEmail &&
      typeof passportUser.email === 'string' &&
      passportUser.email.toLowerCase() === normalizedEmail
    ) {
      return true;
    }
    // Numeric id only if it is the DB id (credential-style), not a Google profile string
    if (typeof passportUser.id === 'number' && passportUser.id === userId) {
      return true;
    }
    if (
      typeof passportUser.id === 'string' &&
      /^\d+$/.test(passportUser.id) &&
      Number(passportUser.id) === userId
    ) {
      return true;
    }
    return false;
  }

  // Legacy: bare id serialized as passport.user
  if (typeof passportUser === 'number' && passportUser === userId) {
    return true;
  }
  if (
    typeof passportUser === 'string' &&
    /^\d+$/.test(passportUser) &&
    Number(passportUser) === userId
  ) {
    return true;
  }

  return false;
}
