import assert from 'node:assert/strict';
import test from 'node:test';
import { originsEqual } from './origins-equal.js';

const allowed = 'https://www.example.com';

test('accepts exact allowed origin', () => {
  assert.equal(originsEqual('https://www.example.com', allowed), true);
});

test('accepts allowed origin with trailing path/slash via URL.origin', () => {
  assert.equal(originsEqual('https://www.example.com/', allowed), true);
  assert.equal(originsEqual('https://www.example.com/admin', allowed), true);
  assert.equal(originsEqual(allowed, 'https://www.example.com/'), true);
});

test('rejects confusable subdomain (startsWith bypass)', () => {
  // Previously origin.startsWith(allowed) accepted this attacker origin
  assert.equal(originsEqual('https://www.example.com.evil.tld', allowed), false);
  assert.equal(originsEqual('https://www.example.com.attacker.com', allowed), false);
});

test('rejects different scheme or host', () => {
  assert.equal(originsEqual('http://www.example.com', allowed), false);
  assert.equal(originsEqual('https://evil.example.com', allowed), false);
  assert.equal(originsEqual('https://www.example.com:8443', allowed), false);
});

test('normalizes default HTTPS port', () => {
  assert.equal(originsEqual('https://www.example.com:443', allowed), true);
  assert.equal(originsEqual(allowed, 'https://www.example.com:443'), true);
});

test('rejects invalid URLs', () => {
  assert.equal(originsEqual('not-a-url', allowed), false);
  assert.equal(originsEqual(allowed, 'not-a-url'), false);
  assert.equal(originsEqual('', allowed), false);
});
