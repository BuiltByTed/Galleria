import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REAUTH_WINDOW_MS,
  isRecentAuth,
  planSensitiveReauth,
  userHasPasskeys,
  userHasPassword,
} from './reauth.js';

test('userHasPassword treats null/empty as absent', () => {
  assert.equal(userHasPassword({ password_hash: null }), false);
  assert.equal(userHasPassword({ password_hash: '' }), false);
  assert.equal(userHasPassword({ password_hash: 'hash' }), true);
});

test('userHasPasskeys requires non-empty array', () => {
  assert.equal(userHasPasskeys({ passkeys: null }), false);
  assert.equal(userHasPasskeys({ passkeys: [] }), false);
  assert.equal(userHasPasskeys({ passkeys: [{ id: '1' }] }), true);
});

test('isRecentAuth fails closed on missing timestamps', () => {
  const now = 1_000_000;
  assert.equal(isRecentAuth(undefined, now), false);
  assert.equal(isRecentAuth(null, now), false);
  assert.equal(isRecentAuth(Number.NaN, now), false);
});

test('isRecentAuth accepts only within window', () => {
  const now = 1_000_000;
  assert.equal(isRecentAuth(now, now), true);
  assert.equal(isRecentAuth(now - REAUTH_WINDOW_MS, now), true);
  assert.equal(isRecentAuth(now - REAUTH_WINDOW_MS - 1, now), false);
  assert.equal(isRecentAuth(now + 1, now), false); // future clock skew rejected
});

test('password account requires password; session alone never enough', () => {
  const plan = planSensitiveReauth({
    hasPassword: true,
    hasPasskeys: false,
    sessionAuthenticatedAt: Date.now(),
  });
  assert.equal(plan.action, 'reject');
  if (plan.action === 'reject') {
    assert.equal(plan.code, 'password_required');
    assert.ok(plan.availableMethods.includes('password'));
    assert.ok(!plan.availableMethods.includes('recent_login'));
  }
});

test('password account with password plans verify_password', () => {
  const plan = planSensitiveReauth({
    hasPassword: true,
    hasPasskeys: false,
    password: 'secret',
  });
  assert.deepEqual(plan, { action: 'verify_password', password: 'secret' });
});

test('password account may use passkey when both registered', () => {
  const plan = planSensitiveReauth({
    hasPassword: true,
    hasPasskeys: true,
    passkeyCredential: { id: 'cred' },
    passkeySessionId: 'sid-1',
  });
  assert.equal(plan.action, 'verify_passkey');
  if (plan.action === 'verify_passkey') {
    assert.equal(plan.sessionId, 'sid-1');
  }
});

test('passwordless passkey user without proof is rejected (regression #3440)', () => {
  const plan = planSensitiveReauth({
    hasPassword: false,
    hasPasskeys: true,
    // stale / missing session auth time
    sessionAuthenticatedAt: Date.now() - REAUTH_WINDOW_MS - 10_000,
  });
  assert.equal(plan.action, 'reject');
  if (plan.action === 'reject') {
    assert.equal(plan.code, 'passkey_reauth_required');
  }
});

test('passwordless passkey user accepts fresh passkey assertion', () => {
  const plan = planSensitiveReauth({
    hasPassword: false,
    hasPasskeys: true,
    passkeyCredential: { id: 'cred' },
    passkeySessionId: 'reauth-1',
  });
  assert.equal(plan.action, 'verify_passkey');
});

test('passwordless passkey user accepts recent login', () => {
  const now = 5_000_000;
  const plan = planSensitiveReauth({
    hasPassword: false,
    hasPasskeys: true,
    sessionAuthenticatedAt: now - 60_000,
    now,
  });
  assert.equal(plan.action, 'accept_recent_login');
});

test('OAuth-only without recent login is rejected (session theft path)', () => {
  const plan = planSensitiveReauth({
    hasPassword: false,
    hasPasskeys: false,
    sessionAuthenticatedAt: undefined,
  });
  assert.equal(plan.action, 'reject');
  if (plan.action === 'reject') {
    assert.equal(plan.code, 'reauth_required');
    assert.deepEqual(plan.availableMethods, ['recent_login']);
  }
});

test('OAuth-only with recent login is accepted', () => {
  const now = 9_000_000;
  const plan = planSensitiveReauth({
    hasPassword: false,
    hasPasskeys: false,
    sessionAuthenticatedAt: now - 30_000,
    now,
  });
  assert.equal(plan.action, 'accept_recent_login');
});

test('empty password string does not count as provided', () => {
  const plan = planSensitiveReauth({
    hasPassword: true,
    hasPasskeys: false,
    password: '',
  });
  assert.equal(plan.action, 'reject');
});
