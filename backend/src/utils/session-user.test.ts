import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionBelongsToUser } from './session-user.js';

const userId = 42;
const email = 'victim@example.com';

test('matches credential sessions by userId', () => {
  assert.equal(sessionBelongsToUser({ userId: 42 }, userId, email), true);
  assert.equal(sessionBelongsToUser({ userId: '42' }, userId, email), true);
  assert.equal(sessionBelongsToUser({ userId: 7 }, userId, email), false);
});

test('matches credential sessions by session.user id or email', () => {
  assert.equal(
    sessionBelongsToUser({ user: { id: 42, email: 'other@example.com' } }, userId, email),
    true
  );
  assert.equal(
    sessionBelongsToUser({ user: { id: 7, email: 'Victim@example.com' } }, userId, email),
    true
  );
  assert.equal(
    sessionBelongsToUser({ user: { id: 7, email: 'other@example.com' } }, userId, email),
    false
  );
});

test('matches passport sessions by email object (not whole object === userId)', () => {
  // Broken old matcher: session.passport.user === userId never holds for object form
  const passportSession = {
    passport: {
      user: { id: 'google-profile-abc', email: 'victim@example.com', name: 'V' },
    },
  };
  assert.equal(sessionBelongsToUser(passportSession, userId, email), true);
  assert.notEqual(passportSession.passport.user as unknown, userId);

  assert.equal(
    sessionBelongsToUser(
      { passport: { user: { id: 'google-other', email: 'other@example.com' } } },
      userId,
      email
    ),
    false
  );
});

test('matches legacy bare passport.user numeric id', () => {
  assert.equal(sessionBelongsToUser({ passport: { user: 42 } }, userId, email), true);
  assert.equal(sessionBelongsToUser({ passport: { user: '42' } }, userId, email), true);
  // Google profile string ids must not match DB id by coercion of non-numeric strings
  assert.equal(
    sessionBelongsToUser({ passport: { user: 'google-profile-abc' } }, userId, email),
    false
  );
});

test('rejects empty or unrelated sessions', () => {
  assert.equal(sessionBelongsToUser(null, userId, email), false);
  assert.equal(sessionBelongsToUser({}, userId, email), false);
  assert.equal(sessionBelongsToUser({ passport: {} }, userId, email), false);
});
