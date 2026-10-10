import assert from 'node:assert/strict';
import test from 'node:test';
import {
  destroySessionsForUser,
  sessionBelongsToUser,
  type SessionRecord,
  type SessionStoreLike,
} from './session-invalidation.js';

test('sessionBelongsToUser matches credential userId', () => {
  assert.equal(sessionBelongsToUser({ userId: 42 }, 42), true);
  assert.equal(sessionBelongsToUser({ userId: '42' }, 42), true);
  assert.equal(sessionBelongsToUser({ userId: 7 }, 42), false);
});

test('sessionBelongsToUser matches credential session.user blob', () => {
  assert.equal(
    sessionBelongsToUser({ user: { id: 3, email: 'a@example.com' } }, 3, 'a@example.com'),
    true
  );
  assert.equal(
    sessionBelongsToUser({ user: { email: 'a@example.com' } }, 99, 'a@example.com'),
    true
  );
  assert.equal(
    sessionBelongsToUser({ user: { id: 3, email: 'other@example.com' } }, 99, 'a@example.com'),
    false
  );
});

test('sessionBelongsToUser matches passport email object (Google OAuth)', () => {
  const session: SessionRecord = {
    passport: { user: { id: 'google-sub', email: 'admin@example.com', name: 'Admin' } },
  };
  assert.equal(sessionBelongsToUser(session, 1, 'admin@example.com'), true);
  assert.equal(sessionBelongsToUser(session, 1, 'ADMIN@example.com'), true);
  assert.equal(sessionBelongsToUser(session, 1, 'other@example.com'), false);
  // Old delete-user matcher (passport.user === userId) would miss this
  assert.equal(session.passport?.user === 1, false);
});

test('sessionBelongsToUser matches scalar passport user id', () => {
  assert.equal(sessionBelongsToUser({ passport: { user: 9 } }, 9), true);
  assert.equal(sessionBelongsToUser({ passport: { user: '9' } }, 9), true);
  assert.equal(sessionBelongsToUser({ passport: { user: 'user@x.com' } }, 1, 'user@x.com'), true);
});

test('sessionBelongsToUser rejects empty/unrelated sessions', () => {
  assert.equal(sessionBelongsToUser(undefined, 1), false);
  assert.equal(sessionBelongsToUser({}, 1, 'a@b.c'), false);
  assert.equal(sessionBelongsToUser({ cookie: {} } as SessionRecord, 1), false);
});

test('destroySessionsForUser destroys matching sids only', async () => {
  const destroyed: string[] = [];
  const store: SessionStoreLike = {
    all(cb) {
      cb(null, {
        sidA: { userId: 1 },
        sidB: { userId: 2 },
        sidC: { passport: { user: { email: 'one@example.com' } } },
        sidD: {},
      });
    },
    destroy(sid, cb) {
      destroyed.push(sid);
      cb?.();
    },
  };

  const count = await destroySessionsForUser(store, 1, 'one@example.com', 'test');
  assert.equal(count, 2);
  assert.deepEqual(destroyed.sort(), ['sidA', 'sidC']);
});

test('destroySessionsForUser resolves 0 when store has no all()', async () => {
  const store: SessionStoreLike = {
    destroy() {},
  };
  const count = await destroySessionsForUser(store, 1);
  assert.equal(count, 0);
});
