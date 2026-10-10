import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express, { type Express, type Request, type Router } from 'express';

const dataDir = mkdtempSync(path.join(tmpdir(), 'galleria-album-access-'));
const appRoot = path.join(dataDir, 'app-root');
const photosDir = path.join(dataDir, 'photos');
process.env.DATA_DIR = dataDir;

interface AccessResult {
  allowed: boolean;
  exists: boolean;
  reason: string;
}

interface AlbumAccessModule {
  getAlbumAccess(req: Request, albumName: string): AccessResult;
  isRequestAuthenticated(req: Request): boolean;
}

interface RequestOptions {
  authenticated?: boolean;
  /** Credential session userId override (defaults to active test user) */
  userId?: number;
  /** Passport-style session: isAuthenticated + req.user.email */
  passportEmail?: string;
  key?: string;
}

let albumAccess: AlbumAccessModule;
let imageMetadataRouter: Router;
let previewGridRouter: Router;
let albumsRouter: Router;
let generateStaticJSONFiles: (appRoot: string) => Promise<{ success: boolean; error?: string; albumCount?: number }>;
let shareKey = '';
let expiredShareKey = '';
let activeUserId = 0;
let inactiveUserId = 0;
const activeUserEmail = 'active@example.com';
const inactiveUserEmail = 'inactive@example.com';
const deletedUserEmail = 'deleted@example.com';

function request(options: RequestOptions = {}): Request {
  if (options.passportEmail) {
    return {
      isAuthenticated: () => true,
      user: { id: 'google-profile-id', email: options.passportEmail },
      session: { passport: { user: { id: 'google-profile-id', email: options.passportEmail } } },
      query: options.key ? { key: options.key } : {},
    } as unknown as Request;
  }

  const userId = options.userId ?? activeUserId;
  return {
    isAuthenticated: () => Boolean(options.authenticated),
    session: options.authenticated ? { userId } : {},
    query: options.key ? { key: options.key } : {},
  } as unknown as Request;
}

function createRouteApp(): Express {
  const app = express();

  app.set('photosDir', photosDir);
  app.set('appRoot', appRoot);
  app.use((req, _res, next) => {
    const authenticated = req.get('x-test-auth') === '1';
    (req as any).isAuthenticated = () => authenticated;
    (req as any).session = authenticated ? { userId: activeUserId } : {};
    next();
  });
  app.use('/api/image-metadata', imageMetadataRouter);
  app.use('/api/preview-grid', previewGridRouter);
  app.use(albumsRouter);

  return app;
}

async function withRouteApp(assertions: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = createRouteApp();
  const server = app.listen(0);

  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await assertions(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

async function fetchRoute(baseUrl: string, pathname: string, options: { authenticated?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.authenticated) {
    headers['x-test-auth'] = '1';
  }

  return fetch(`${baseUrl}${pathname}`, { headers });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test.before(async () => {
  mkdirSync(path.join(photosDir, 'Published'), { recursive: true });
  mkdirSync(path.join(photosDir, 'Private'), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    environment: {
      frontend: { port: 3000, apiUrl: 'http://localhost:3000' },
      backend: { port: 3001, allowedOrigins: ['http://localhost:3000'] },
      security: { allowedHosts: ['localhost:3000'], rateLimitWindowMs: 1000, rateLimitMaxRequests: 100 },
      logging: { level: 'error' },
      auth: {
        google: { enabled: false, clientId: '', clientSecret: '' },
        sessionSecret: 'test-session-secret',
        authorizedEmails: [],
      },
    },
    branding: { avatarPath: '/photos/avatar.png' },
    analytics: { enabled: false, openobserve: {} },
    externalLinks: [],
  }));

  const sharp = (await import('sharp')).default;
  await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).jpeg().toFile(path.join(photosDir, 'Published', 'published.jpg')),
    sharp({ create: { width: 4, height: 4, channels: 3, background: '#111111' } }).jpeg().toFile(path.join(photosDir, 'Private', 'private.jpg')),
  ]);

  const database = await import('../database.js');
  const databaseUsers = await import('../database-users.js');
  albumAccess = await import('./album-access.js');
  imageMetadataRouter = (await import('../routes/image-metadata.js')).default;
  previewGridRouter = (await import('../routes/preview-grid.js')).default;
  albumsRouter = (await import('../routes/albums.js')).default;
  ({ generateStaticJSONFiles } = await import('../routes/static-json.js'));

  const db = database.initializeDatabase();
  // Users table is normally created during setup; create it here for auth checks
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      auth_methods TEXT NOT NULL DEFAULT '["google"]',
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT,
      backup_codes TEXT,
      passkeys TEXT,
      google_id TEXT UNIQUE,
      name TEXT,
      picture TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      is_active INTEGER NOT NULL DEFAULT 1,
      email_verified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      invite_token TEXT UNIQUE,
      invite_expires_at TEXT,
      password_reset_token TEXT UNIQUE,
      password_reset_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    )
  `);

  const activeUser = databaseUsers.createUser({
    email: activeUserEmail,
    name: 'Active User',
    auth_methods: ['password'],
    email_verified: true,
    role: 'viewer',
  });
  activeUserId = activeUser.id;

  const inactiveUser = databaseUsers.createUser({
    email: inactiveUserEmail,
    name: 'Inactive User',
    auth_methods: ['password'],
    email_verified: true,
    role: 'viewer',
  });
  inactiveUserId = inactiveUser.id;
  databaseUsers.updateUser(inactiveUserId, { is_active: false });

  // Create then delete so isRequestAuthenticated rejects leftover sessions
  const deletedUser = databaseUsers.createUser({
    email: deletedUserEmail,
    name: 'Deleted User',
    auth_methods: ['password'],
    email_verified: true,
    role: 'viewer',
  });
  databaseUsers.deleteUser(deletedUser.id);

  database.saveAlbum('Published', true);
  database.saveAlbum('Private', false);
  database.saveAlbum('OtherPrivate', false);
  database.saveImageMetadata('Published', 'published.jpg', 'Published Photo', 'Public description');
  database.saveImageMetadata('Published', 'published-video.mp4', 'Published Video', 'Public video', 'video');
  database.saveImageMetadata('Private', 'private.jpg', 'Private Photo', 'Secret description');
  database.saveImageMetadata('Private', 'private-video.mp4', 'Private Video', 'Secret video', 'video');
  database.saveImageMetadata('OtherPrivate', 'other.jpg', 'Other Private Photo', null);
  shareKey = database.createShareLink('Private', null).secret_key;
  expiredShareKey = database.createShareLink('Private', new Date(Date.now() - 60_000).toISOString()).secret_key;
});

test('allows public access to published albums', () => {
  const access = albumAccess.getAlbumAccess(request(), 'Published');

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'published');
});

test('denies anonymous access to unpublished albums without a valid share link', () => {
  const access = albumAccess.getAlbumAccess(request(), 'Private');

  assert.equal(access.allowed, false);
  assert.equal(access.exists, true);
  assert.equal(access.reason, 'denied');
});

test('allows authenticated access to unpublished albums', () => {
  const access = albumAccess.getAlbumAccess(request({ authenticated: true }), 'Private');

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'authenticated');
});

test('isRequestAuthenticated accepts live credential and passport sessions', () => {
  assert.equal(albumAccess.isRequestAuthenticated(request({ authenticated: true })), true);
  assert.equal(albumAccess.isRequestAuthenticated(request({ passportEmail: activeUserEmail })), true);
  assert.equal(albumAccess.isRequestAuthenticated(request()), false);
});

test('isRequestAuthenticated rejects deleted or inactive user sessions', () => {
  // Stale credential session pointing at a deleted user id
  assert.equal(
    albumAccess.isRequestAuthenticated(request({ authenticated: true, userId: 99999 })),
    false
  );

  // Inactive account still has a cookie
  assert.equal(
    albumAccess.isRequestAuthenticated(request({ authenticated: true, userId: inactiveUserId })),
    false
  );

  // Passport session whose email no longer maps to a user
  assert.equal(
    albumAccess.isRequestAuthenticated(request({ passportEmail: deletedUserEmail })),
    false
  );

  // Passport session for deactivated account
  assert.equal(
    albumAccess.isRequestAuthenticated(request({ passportEmail: inactiveUserEmail })),
    false
  );

  // Content path must deny unpublished album for deleted-user session
  const deletedAccess = albumAccess.getAlbumAccess(
    request({ authenticated: true, userId: 99999 }),
    'Private'
  );
  assert.equal(deletedAccess.allowed, false);
  assert.equal(deletedAccess.reason, 'denied');
});

test('allows share-link access only for the matching unexpired album', () => {
  const allowed = albumAccess.getAlbumAccess(request({ key: shareKey }), 'Private');
  const wrongAlbum = albumAccess.getAlbumAccess(request({ key: shareKey }), 'OtherPrivate');
  const expired = albumAccess.getAlbumAccess(request({ key: expiredShareKey }), 'Private');

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'share_link');
  assert.equal(wrongAlbum.allowed, false);
  assert.equal(wrongAlbum.reason, 'denied');
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, 'denied');
});

test('image metadata routes filter or deny unpublished albums unless authenticated or shared', async () => {
  await withRouteApp(async (baseUrl) => {
    const allResponse = await fetchRoute(baseUrl, '/api/image-metadata/all');
    assert.equal(allResponse.status, 200);
    const allMetadata = await allResponse.json() as Array<{ album: string; filename: string }>;
    assert.deepEqual(new Set(allMetadata.map(item => item.album)), new Set(['Published']));

    const sharedAllResponse = await fetchRoute(baseUrl, `/api/image-metadata/all?key=${shareKey}`);
    assert.equal(sharedAllResponse.status, 200);
    const sharedAllMetadata = await sharedAllResponse.json() as Array<{ album: string }>;
    assert.deepEqual(new Set(sharedAllMetadata.map(item => item.album)), new Set(['Private', 'Published']));

    const privateAlbumResponse = await fetchRoute(baseUrl, '/api/image-metadata/album/Private');
    assert.equal(privateAlbumResponse.status, 403);

    const sharedAlbumResponse = await fetchRoute(baseUrl, `/api/image-metadata/album/Private?key=${shareKey}`);
    assert.equal(sharedAlbumResponse.status, 200);
    const sharedAlbumMetadata = await sharedAlbumResponse.json() as Array<{ filename: string }>;
    assert.deepEqual(new Set(sharedAlbumMetadata.map(item => item.filename)), new Set(['private.jpg', 'private-video.mp4']));

    const privateImageResponse = await fetchRoute(baseUrl, '/api/image-metadata/Private/private.jpg');
    assert.equal(privateImageResponse.status, 403);

    const authenticatedImageResponse = await fetchRoute(baseUrl, '/api/image-metadata/Private/private.jpg', { authenticated: true });
    assert.equal(authenticatedImageResponse.status, 200);

    const sharedImageResponse = await fetchRoute(baseUrl, `/api/image-metadata/Private/private.jpg?key=${shareKey}`);
    assert.equal(sharedImageResponse.status, 200);
    const sharedImageMetadata = await sharedImageResponse.json() as { title: string };
    assert.equal(sharedImageMetadata.title, 'Private Photo');
  });
});

test('preview grid route denies unpublished albums anonymously and allows valid share links', async () => {
  await withRouteApp(async (baseUrl) => {
    const anonymousPrivateResponse = await fetchRoute(baseUrl, '/api/preview-grid/album/Private');
    assert.equal(anonymousPrivateResponse.status, 403);

    const publishedResponse = await fetchRoute(baseUrl, '/api/preview-grid/album/Published');
    assert.equal(publishedResponse.status, 200);
    assert.match(publishedResponse.headers.get('content-type') ?? '', /^image\/jpeg/);

    const sharedPrivateResponse = await fetchRoute(baseUrl, `/api/preview-grid/album/Private?key=${shareKey}`);
    assert.equal(sharedPrivateResponse.status, 200);
    assert.match(sharedPrivateResponse.headers.get('content-type') ?? '', /^image\/jpeg/);
  });
});

test('EXIF and video metadata routes check album access before file existence', async () => {
  await withRouteApp(async (baseUrl) => {
    const privateExifResponse = await fetchRoute(baseUrl, '/api/photos/Private/missing.jpg/exif');
    assert.equal(privateExifResponse.status, 403);

    const publishedExifResponse = await fetchRoute(baseUrl, '/api/photos/Published/missing.jpg/exif');
    assert.equal(publishedExifResponse.status, 404);

    const sharedExifResponse = await fetchRoute(baseUrl, `/api/photos/Private/private.jpg/exif?key=${shareKey}`);
    assert.equal(sharedExifResponse.status, 200);

    const privateVideoResponse = await fetchRoute(baseUrl, '/api/videos/Private/missing.mp4/metadata');
    assert.equal(privateVideoResponse.status, 403);

    const authenticatedVideoResponse = await fetchRoute(baseUrl, '/api/videos/Private/missing.mp4/metadata', { authenticated: true });
    assert.equal(authenticatedVideoResponse.status, 404);
  });
});

test('static JSON generation removes stale unpublished album files', async () => {
  const outputDir = path.join(appRoot, 'frontend', 'dist', 'albums-data');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'Private.json'), JSON.stringify([['private.jpg', 'Private Photo']]));

  const result = await generateStaticJSONFiles(appRoot);

  assert.equal(result.success, true);
  assert.equal(result.albumCount, 1);
  assert.equal(existsSync(path.join(outputDir, 'Private.json')), false);
  assert.equal(existsSync(path.join(outputDir, 'Published.json')), true);

  const albumsList = JSON.parse(readFileSync(path.join(outputDir, 'albums-list.json'), 'utf8'));
  assert.deepEqual(albumsList, ['Published']);
});
