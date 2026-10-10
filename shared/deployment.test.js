import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrigin, publicApiUrl, publicSiteUrl, requestOrigin } from './deployment.js';

test('new installs and Unraid sentinel values default to same-origin', () => {
  for (const value of [undefined, '', ' ', '-', 'none', 'null', 'notset']) {
    assert.equal(publicApiUrl({}, { DOMAIN: value, BACKEND_DOMAIN: value, API_URL: value }), '');
  }
  assert.equal(normalizeOrigin('photos.example.com/'), 'https://photos.example.com');
  assert.equal(normalizeOrigin('http://[::1]:8123'), 'http://[::1]:8123');
});

test('legacy variables and saved split-domain installations retain their API', () => {
  const config = { frontend: { apiUrl: 'https://saved-api.example.com' } };
  assert.equal(publicApiUrl(config, {}), 'https://saved-api.example.com');
  assert.equal(publicApiUrl(config, { BACKEND_DOMAIN: 'api.example.com' }), 'https://api.example.com');
  assert.equal(publicApiUrl(config, { BACKEND_DOMAIN: '-', API_URL: 'http://backend:3001' }), 'http://backend:3001');
  assert.equal(publicApiUrl(config, { DOMAIN: 'photos.example.com' }), '');
  assert.equal(publicApiUrl(config, { DOMAIN: 'photos.example.com', BACKEND_DOMAIN: 'api.example.com' }), 'https://api.example.com');
});

test('site URLs never invent a second hostname or change a mapped port', () => {
  const config = { frontend: { siteUrl: 'https://photos.example.com', apiUrl: '' } };
  assert.equal(publicSiteUrl(config, {}), 'https://photos.example.com');
  assert.equal(publicSiteUrl(config, { DOMAIN: 'https://gallery.example.net' }), 'https://gallery.example.net');
  assert.equal(publicSiteUrl(config, { FRONTEND_DOMAIN: 'http://192.168.1.2:8765' }), 'http://192.168.1.2:8765');
  assert.equal(publicSiteUrl({}, {}, 'http://192.168.1.2:8765'), 'http://192.168.1.2:8765');
  assert.equal(requestOrigin({ headers: { host: 'gallery.local:8765', 'x-forwarded-proto': 'https' } }), 'https://gallery.local:8765');
});

test('invalid public origins cannot inject paths or script content', () => {
  for (const value of ['ftp://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?x=1']) {
    assert.throws(() => normalizeOrigin(value));
  }
});
