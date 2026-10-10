import assert from 'node:assert/strict';
import test from 'node:test';
import { getAllowedOrigins, getConfigExists, isOriginAllowed } from './config.js';

test('allows exact origins from getAllowedOrigins', () => {
  const allowed = getAllowedOrigins();
  assert.ok(allowed.length > 0, 'expected at least localhost defaults');
  for (const origin of allowed) {
    assert.equal(isOriginAllowed(origin), true, origin);
  }
});

test('allows localhost and 127.0.0.1 on any port', () => {
  assert.equal(isOriginAllowed('http://localhost:9999'), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:5173'), true);
});

test('allows IPv4 Docker/Unraid ports 3000 and 3001 only', () => {
  assert.equal(isOriginAllowed('http://192.168.1.50:3000'), true);
  assert.equal(isOriginAllowed('http://10.0.0.2:3001'), true);
  assert.equal(isOriginAllowed('http://192.168.1.50:8080'), false);
});

test('rejects unlisted third-party origins (CORS bypass class)', () => {
  // HTTP third-party never passes (OOBE only opens https when config is missing)
  assert.equal(isOriginAllowed('http://evil.example'), false);
  assert.equal(isOriginAllowed('http://attacker.example.com'), false);
  assert.equal(isOriginAllowed('http://evil.example:3000'), false);

  if (getConfigExists()) {
    assert.equal(isOriginAllowed('https://evil.example'), false);
    assert.equal(isOriginAllowed('https://attacker.example.com'), false);
  } else {
    // Matches global server CORS: OOBE allows any HTTPS origin during setup
    assert.equal(isOriginAllowed('https://evil.example'), true);
  }
});

test('rejects missing/empty origin', () => {
  assert.equal(isOriginAllowed(undefined), false);
  assert.equal(isOriginAllowed(null), false);
  assert.equal(isOriginAllowed(''), false);
});

test('rejects malformed origin URLs', () => {
  assert.equal(isOriginAllowed('not-a-url'), false);
});
