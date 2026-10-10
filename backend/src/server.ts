/**
 * Main server file for the photography website backend.
 * This file sets up the Express server, configures middleware,
 * and defines the main routes for the application.
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import { createRequire } from "module";
import passport from "passport";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Import CommonJS module for session store
const require = createRequire(import.meta.url);
const SqliteStoreFactory = require("better-sqlite3-session-store");

// Import configuration
import config, {
  PORT,
  PHOTOS_DIR,
  OPTIMIZED_DIR,
  DATA_DIR,
  getConfigExists,
  isOriginAllowed,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  getLogLevel,
  isEnvSet,
  getCurrentConfig,
} from "./config.ts";
import { validateProductionSecurity } from "./security.ts";
import { initializeDatabase } from "./database.ts";
import { initPromise as i18nInitPromise } from './i18n.js';
import { initializePushNotifications } from './push-notifications.js';
import {
  initLogger,
  info,
  warn,
  error,
  debug,
  verbose,
  trace,
} from "./utils/logger.ts";
import { getAlbumAccess, isRequestAuthenticated } from "./utils/album-access.ts";
import { getSessionCookieDomain } from "./utils/session-cookie-domain.ts";

// Initialize logger early with config or environment variable
initLogger(getLogLevel());

// In-memory cache for optimized images (thumbnails + modals)
const imageCache = new Map<
  string,
  { data: Buffer; contentType: string; timestamp: number }
>();
const IMAGE_CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const IMAGE_CACHE_MAX_ITEMS = 2000; // Limit cache size (thumbnails + modals)

function getOptimizedRelativePath(reqPath: string): string | null {
  let decoded: string;

  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    return null;
  }

  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }

  return decoded.replace(/^[/\\]+/, "");
}

function isOptimizedCachePath(reqPath: string): boolean {
  const relative = getOptimizedRelativePath(reqPath);

  if (relative) {
    return (
      relative === "thumbnail" ||
      relative === "modal" ||
      relative.startsWith("thumbnail/") ||
      relative.startsWith("modal/")
    );
  }

  return reqPath.startsWith("/thumbnail") || reqPath.startsWith("/modal");
}

function safeOptimizedPath(
  optimizedDir: string,
  reqPath: string
): string | null {
  const relative = getOptimizedRelativePath(reqPath);

  if (
    !relative ||
    (!relative.startsWith("thumbnail/") && !relative.startsWith("modal/"))
  ) {
    return null;
  }

  const root = path.resolve(optimizedDir);
  const candidate = path.resolve(root, relative);

  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }

  return candidate;
}

// Import authentication middleware
import { requireAdmin } from "./auth/middleware.ts";

// Import route handlers
import albumsRouter from "./routes/albums.ts";
import albumManagementRouter from "./routes/album-management.ts";
import folderManagementRouter from "./routes/folder-management.ts";
import externalPagesRouter from "./routes/external-pages.ts";
import healthRouter from "./routes/health.ts";
import analyticsRouter from "./routes/analytics.ts";
import metricsRouter from "./routes/metrics.ts";
import sitemapRouter from "./routes/sitemap.ts";
import yearRouter from "./routes/year.ts";
import authRouter from "./routes/auth.ts";
import authExtendedRouter from "./routes/auth-extended.ts";
import externalLinksRouter from "./routes/external-links.ts";
import brandingRouter from "./routes/branding.ts";
import imageOptimizationRouter from "./routes/image-optimization.ts";
import videoOptimizationRouter from "./routes/video-optimization.ts";
import configRouter from "./routes/config.ts";
import imageMetadataRouter from "./routes/image-metadata.ts";
import aiTitlesRouter from "./routes/ai-titles.ts";
import systemRouter from "./routes/system.ts";
import shareLinksRouter from "./routes/share-links.ts";
import optimizationStreamRouter from "./routes/optimization-stream.ts";
import previewGridRouter from "./routes/preview-grid.ts";
import staticJsonRouter, {
  generateStaticJSONFiles,
} from "./routes/static-json.ts";
import setupRouter from "./routes/setup.ts";
import videoRouter from "./routes/video.ts";
import pushNotificationsRouter from "./routes/push-notifications.ts";
import notificationPreferencesRouter from "./routes/notification-preferences.ts";

// Get the current directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate production security before starting (skip if in setup mode)
if (getConfigExists()) {
  validateProductionSecurity();
} else {
  info(
    "[Server] Setup mode detected - skipping production security validation"
  );
}

// Initialize database lazily (on first use) to avoid ESM/CommonJS issues
// The database module will be imported when needed by routes

// Initialize Express application
const app = express();

// Trust proxy - required for production behind nginx/reverse proxy
// This allows express to read X-Forwarded-* headers correctly
app.set("trust proxy", 1);

// Request logging middleware (verbose level)
app.use((req, res, next) => {
  // Skip logging for static assets (photos, optimized, fonts, etc.)
  const isStaticAsset =
    req.path.startsWith("/photos/") ||
    req.path.startsWith("/optimized/") ||
    req.path.startsWith("/fonts/") ||
    req.path.startsWith("/favicon.ico");

  if (!isStaticAsset) {
    verbose(
      `[HTTP] ${req.method} ${req.path} - ${req.ip || req.socket.remoteAddress}`
    );
  }
  next();
});

// HTTPS redirect middleware (production only)
// Check BACKEND_DOMAIN env var first (for Docker), then fall back to config
const isProduction = isEnvSet(process.env.BACKEND_DOMAIN)
  ? process.env.BACKEND_DOMAIN!.startsWith("https://")
  : config.frontend.apiUrl.startsWith("https://");
if (isProduction) {
  app.use((req, res, next) => {
    // Skip HTTPS redirect for IP addresses (e.g., direct Docker access) and localhost
    const host = req.headers.host || "";
    const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
    const isIpAddress = ipPattern.test(host);
    const isLocalhost =
      host.startsWith("localhost") || host.startsWith("127.0.0.1");

    // Check if request is already HTTPS
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

    if (!isSecure && !isIpAddress && !isLocalhost) {
      // Redirect to HTTPS
      const httpsUrl = `https://${req.headers.host}${req.url}`;
      return res.redirect(301, httpsUrl);
    }

    next();
  });
}

// Resolve photo directory paths relative to project root
// PHOTOS_DIR should be relative to where you run the backend (typically backend/ directory)
let photosDir = path.resolve(__dirname, "../../", PHOTOS_DIR);
let optimizedDir = path.resolve(__dirname, "../../", OPTIMIZED_DIR);
let videoDir = path.join(DATA_DIR, "video");

// Resolve symlinks to get the real path (important for macOS TCC permissions)
try {
  photosDir = fs.realpathSync(photosDir);
  debug("[Server] Photos directory (real path):", photosDir);
} catch (err) {
  warn("[Server] Could not resolve photos directory:", photosDir);
}

try {
  optimizedDir = fs.realpathSync(optimizedDir);
  debug("[Server] Optimized directory (real path):", optimizedDir);
} catch (err) {
  warn("[Server] Could not resolve optimized directory:", optimizedDir);
}

try {
  videoDir = fs.realpathSync(videoDir);
  debug("[Server] Video directory (real path):", videoDir);
} catch (err) {
  // Video dir might not exist yet, that's okay
  debug("[Server] Video directory not resolved (may not exist yet):", videoDir);
}

// Verify directory paths exist
if (!fs.existsSync(photosDir)) {
  warn("[Server] Photos directory does not exist:", photosDir);
}
if (!fs.existsSync(optimizedDir)) {
  warn("[Server] Optimized directory does not exist:", optimizedDir);
}
if (!fs.existsSync(videoDir)) {
  debug("[Server] Video directory does not exist (will be created on first video upload):", videoDir);
}

// Configure security middleware
// Set security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images to be loaded from different origins
    contentSecurityPolicy: false, // Disable CSP as we're serving images
    frameguard: { action: "deny" }, // X-Frame-Options: DENY (prevent clickjacking)
    noSniff: true, // X-Content-Type-Options: nosniff (prevent MIME type sniffing)
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }, // Referrer-Policy
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  })
);

// Configure CORS with specific origins
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);

      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      // Reject origin by passing false (not an Error)
      warn(`CORS blocked origin: ${origin}`);
      callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Analytics-Signature",
      "X-CSRF-Token",
      "Cache-Control",
    ],
  })
);

// Rate limiting to prevent abuse
// Allow up to configured requests per window - normal users won't hit this
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  // Skip failed requests (don't count them)
  skipFailedRequests: true,
  // Skip public read-only endpoints that are called frequently
  skip: (req) => {
    const path = req.path;
    // Don't rate limit public GET requests to these endpoints
    if (req.method === "GET") {
      return (
        path === "/api/branding" ||
        path === "/api/albums" ||
        path.startsWith("/api/albums/") ||
        path === "/api/random-photos" ||
        path === "/api/health"
      );
    }
    return false;
  },
});

// Stricter rate limiting for authentication endpoints to prevent brute force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message:
    "Too many authentication attempts from this IP, please try again after 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
});

// Passkey bootstrap routes always (or often) return 2xx with challenge material.
// authLimiter's skipSuccessfulRequests would never increment on auth-options
// (always 200) and under-count verify abuse — count every response by IP.
const passkeyAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message:
    "Too many authentication attempts from this IP, please try again after 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  // Count all outcomes — required for public challenge issuance
  skipSuccessfulRequests: false,
});

app.use("/api/", limiter);
// Apply stricter rate limiting to authentication endpoints
app.use("/api/auth-extended/login", authLimiter);
app.use("/api/auth-extended/password-reset", authLimiter);
// Public passkey login bootstrap — rate-limit by IP, all responses (ticket #3444)
app.use("/api/auth-extended/passkey/auth-options", passkeyAuthLimiter);
app.use("/api/auth-extended/passkey/auth-verify", passkeyAuthLimiter);
app.use("/api/auth/google", authLimiter);

// Parse JSON request bodies with size limit
app.use(express.json({ limit: "1mb" }));

// Configure session middleware for authentication
const sessionSecret = config.auth?.sessionSecret;
if (!sessionSecret) {
  if (getConfigExists()) {
    error("[Server] CRITICAL ERROR: SESSION_SECRET is not configured!");
    error(
      "[Server] Please set auth.sessionSecret in config.json or SESSION_SECRET environment variable."
    );
    error("[Server] Generate a secure secret with: openssl rand -hex 32");
    process.exit(1);
  } else {
    info("[Server] Using temporary session secret for setup mode");
  }
}

// Initialize SQLite session store
const db = initializeDatabase();
const SqliteStore = SqliteStoreFactory(session);

// Initialize push notifications after database is ready
initializePushNotifications();

// Middleware to set dynamic cookie options BEFORE session middleware runs
// This allows both IP access (http://4.20.69.80) and domain access (https://api.example.com)
app.use((req: Request, res: Response, next) => {
  const host = req.hostname || req.headers.host?.split(":")[0] || "";
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

  // Store computed values on request for session middleware to use
  (req as any).__cookieSecure = isSecure;
  (req as any).__cookieSameSite = isSecure ? "lax" : false;
  (req as any).__cookieDomain = getSessionCookieDomain(host);

  debug(`[Session Cookie] host=${host}, secure=${isSecure}, domain=${(req as any).__cookieDomain}`);
  next();
});

// Session middleware with dynamic cookie configuration
// Cookie domain and secure flag are set per-request based on how the user accesses the site
const sessionStore = new SqliteStore({
  client: db,
  expired: {
    clear: true,
    intervalMs: 900000, // Clean up expired sessions every 15 minutes
  },
});
let activeSessionSecret: string;
let sessionMiddleware: ReturnType<typeof session>;
app.use((req, res, next) => {
  // OOBE publishes a permanent secret without restarting the container.
  const secret = process.env.SESSION_SECRET || getCurrentConfig().auth.sessionSecret;
  if (secret !== activeSessionSecret) {
    activeSessionSecret = secret;
    sessionMiddleware = session({
      store: sessionStore,
      secret,
      resave: false,
      saveUninitialized: false,
      rolling: true, // Extend sessions during long uploads
      cookie: {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        secure: "auto",
        sameSite: "lax",
      },
    });
  }
  sessionMiddleware(req, res, next);
});

// Middleware to apply dynamic cookie options after session is initialized
app.use((req: Request, res: Response, next) => {
  if (req.session && req.session.cookie) {
    req.session.cookie.secure = (req as any).__cookieSecure;
    req.session.cookie.sameSite = (req as any).__cookieSameSite;
    // Only set domain if we have one (undefined means browser default)
    if ((req as any).__cookieDomain) {
      req.session.cookie.domain = (req as any).__cookieDomain;
    }
  }
  next();
});

// Middleware to detect and clear stale session cookies
// This handles the case where a client has a connect.sid cookie referencing
// a session that no longer exists in the database (e.g., after DB reset or config change)
app.use((req: Request, res: Response, next) => {
  // Check if client sent a session cookie but session is empty/uninitialized
  const hasCookie = req.headers.cookie?.includes("connect.sid");
  const sessionIsEmpty = !req.session || (!(req.session as any).passport && !(req.session as any).userId);

  if (hasCookie && sessionIsEmpty && req.sessionID) {
    // The client has a stale cookie - regenerate the session to clear it
    debug("[Session] Detected stale session cookie, regenerating session");

    // Clear cookies on all possible domains to handle domain changes
    // This ensures old cookies from different domain configurations are removed
    const hostname = req.hostname;
    const cookieDomain = getSessionCookieDomain(hostname);
    const clearCookieOptions = { path: "/", httpOnly: true };

    // Clear on exact hostname (e.g., api-docker.tedcharles.net)
    res.clearCookie("connect.sid", { ...clearCookieOptions, domain: hostname });

    // Clear on the registrable domain (e.g., .tedcharles.net)
    if (cookieDomain) {
      res.clearCookie("connect.sid", {
        ...clearCookieOptions,
        domain: cookieDomain,
      });
    }

    // Clear without explicit domain (browser default)
    res.clearCookie("connect.sid", clearCookieOptions);

    debug(
      `[Session] Cleared cookies on domains: ${hostname}, ${cookieDomain || "none"}, default`
    );

    req.session.regenerate((err) => {
      if (err) {
        warn("[Session] Failed to regenerate stale session:", err);
      }
      next();
    });
  } else {
    next();
  }
});

// Initialize Passport for Google OAuth
app.use(passport.initialize());
app.use(passport.session());

// Debug middleware - log requests to metrics endpoints
if (!isProduction) {
  app.use("/api/metrics", (req, res, next) => {
    verbose(`[Metrics Request] ${req.method} ${req.path}`);
    verbose("  Cookies:", req.headers.cookie || "NONE");
    verbose("  Session ID:", req.sessionID);
    next();
  });
}

// DO NOT serve original photos - only optimized versions should be accessible
// Original photos are kept private and only optimized versions are served via /optimized
// Exception: Serve avatar files for branding (cache busted via query param)
app.get("/photos/avatar.png", (req: Request, res: Response) => {
  const avatarPath = path.join(photosDir, "avatar.png");
  if (fs.existsSync(avatarPath)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Immutable caching - cache bust is handled via ?v= query param
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(avatarPath);
  } else {
    res.status(404).json({ error: "Avatar not found" });
  }
});

// Serve optimized header avatar (80x80 WebP for fast header loading)
app.get("/photos/avatar-header.webp", (req: Request, res: Response) => {
  const headerAvatarPath = path.join(photosDir, "avatar-header.webp");
  if (fs.existsSync(headerAvatarPath)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Type", "image/webp");
    // Immutable caching - cache bust is handled via ?v= query param
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(headerAvatarPath);
  } else {
    // Fall back to full avatar if header version doesn't exist
    const avatarPath = path.join(photosDir, "avatar.png");
    if (fs.existsSync(avatarPath)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(avatarPath);
    } else {
      res.status(404).json({ error: "Avatar not found" });
    }
  }
});

// In-memory cache middleware for thumbnails AND modals
const cacheImageMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // When mounted under /optimized, req.path is relative to that mount point
  // So req.path will be /thumbnail/... or /modal/... (without /optimized prefix)
  if (!isOptimizedCachePath(req.path)) {
    return next();
  }

  const imagePath = safeOptimizedPath(optimizedDir, req.path);
  if (!imagePath) {
    res.status(400).json({ error: "Invalid image path" });
    return;
  }

  const now = Date.now();

  // Check cache first
  const cached = imageCache.get(imagePath);
  if (cached && now - cached.timestamp < IMAGE_CACHE_MAX_AGE) {
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Cache", "HIT");
    res.send(cached.data);
    return;
  }

  // Read from disk
  fs.readFile(imagePath, (err, data) => {
    if (err) {
      return next(); // Fall through to express.static
    }

    // Limit cache size (LRU-style: remove oldest if at limit)
    if (imageCache.size >= IMAGE_CACHE_MAX_ITEMS) {
      const oldestKey = imageCache.keys().next().value;
      if (oldestKey) imageCache.delete(oldestKey);
    }

    // Determine content type from file extension
    const ext = path.extname(imagePath).toLowerCase();
    const contentType =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
        ? "image/webp"
        : "image/jpeg";

    // Store in cache
    imageCache.set(imagePath, {
      data: data,
      contentType: contentType,
      timestamp: now,
    });

    const cacheRelativePath = path.relative(
      path.resolve(optimizedDir),
      imagePath
    );
    const sizeType = cacheRelativePath.startsWith(`thumbnail${path.sep}`)
      ? "thumbnail"
      : "modal";
    debug(
      `[Cache] Cached ${sizeType}: ${path.basename(imagePath)} (${(
        data.length / 1024
      ).toFixed(1)} KB, total: ${imageCache.size})`
    );

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Cache", "MISS");
    res.send(data);
  });
};

// Middleware to check album published state and share links for optimized images
const checkAlbumPublishedMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Extract album from path: /optimized/{size}/{album}/{filename}
  const pathParts = req.path.split('/').filter(p => p);
  
  if (pathParts.length >= 2) {
    let album: string;

    try {
      album = decodeURIComponent(pathParts[1]); // Second part is the album name (URL decode it!)
    } catch {
      res.status(400).json({ error: "Invalid image path" });
      return;
    }

    const access = getAlbumAccess(req, album);
    
    // Return 404 if album doesn't exist at all
    if (!access.exists) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    
    if (!access.allowed) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const albumState = access.albumState!;

    if (pathParts[0] === "download" && !albumState.downloads_enabled && !isRequestAuthenticated(req)) {
      res.status(403).json({ error: "Downloads disabled" });
      return;
    }
  }
  
  next();
};

// Import download tracker and milestone tracker
import { downloadTrackingMiddleware } from './services/download-tracker.js';
import { startMilestoneTracking } from './services/milestone-tracker.js';

// Serve optimized photos with caching and CORS headers
app.use(
  "/optimized",
  checkAlbumPublishedMiddleware,
  cacheImageMiddleware,
  downloadTrackingMiddleware, // Track downloads before serving files
  express.static(optimizedDir, {
    maxAge: "1y",
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
      // Add 'immutable' for better iOS Safari caching
      // This tells the browser the content will never change at this URL
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      // Add Vary header to help with cache key generation
      res.setHeader("Vary", "Accept-Encoding");
    },
  })
);

// Serve logs.html for /logs route (requires admin authentication)
app.get("/logs", requireAdmin, (req, res) => {
  const logsPath = path.join(__dirname, "../../backend/public/logs.html");
  verbose(`[Logs] Serving logs.html from: ${logsPath}`);
  res.sendFile(logsPath);
});

// Store directory paths in app for use in routes
app.set("photosDir", photosDir);
app.set("optimizedDir", optimizedDir);
app.set("videoDir", videoDir);
app.set("appRoot", path.resolve(__dirname, "../../"));

// Register route handlers
// Note: CSRF protection is applied inside individual routers that need it
app.use("/api/setup", setupRouter);
// Mount authentication routes
// Legacy Passport-based routes (Google OAuth, status, logout)
app.use("/api/auth", authRouter);
// Extended auth routes (MFA, passkeys, user management, credentials)
app.use("/api/auth-extended", authExtendedRouter);
app.use("/api/external-links", externalLinksRouter);
app.use("/api/branding", brandingRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/image-optimization", imageOptimizationRouter);
app.use("/api/video-optimization", videoOptimizationRouter);
app.use("/api/config", configRouter);
app.use("/api/image-metadata", imageMetadataRouter);
app.use("/api/ai-titles", aiTitlesRouter);
app.use("/api/system", systemRouter);
app.use("/api/share-links", shareLinksRouter);
app.use("/api/optimization-stream", optimizationStreamRouter);
app.use("/api/preview-grid", previewGridRouter);
app.use("/api/static-json", staticJsonRouter);
app.use("/api/video", videoRouter);
app.use("/api/push-notifications", pushNotificationsRouter);
app.use("/api/notification-preferences", notificationPreferencesRouter);
app.use(albumsRouter);
app.use("/api/albums", albumManagementRouter);
app.use("/api/folders", folderManagementRouter);
app.use(externalPagesRouter);
app.use(healthRouter);
app.use("/api/analytics", analyticsRouter);
app.use(sitemapRouter);
app.use(yearRouter);

// 404 handler - must come after all routes
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler - must be last
app.use((err: any, req: any, res: any, next: any) => {
  error("[Server] Server error:", err);

  // Don't leak error details in production (HTTPS = production)
  const isProduction = config.frontend.apiUrl.startsWith("https://");
  const message = isProduction
    ? "Internal server error"
    : err.message || "Internal server error";

  res.status(err.status || 500).json({
    error: message,
  });
});

// Start the server after i18n initialization
// For localhost, bind to 127.0.0.1 to avoid macOS permission issues
// For remote dev/production, bind to 0.0.0.0 to accept external connections
// Allow HOST environment variable to override
const isLocalhost = config.frontend.apiUrl.includes("localhost");
const bindHost = process.env.HOST || (isLocalhost ? "127.0.0.1" : "0.0.0.0");

// Wait for i18n to initialize before starting server
i18nInitPromise.then(() => {
  const server = app.listen(PORT, bindHost, () => {
    info(`Server is running on ${bindHost}:${PORT}`);
    info(`API URL: ${config.frontend.apiUrl}`);
    debug(`Photos directory: ${photosDir}`);

  // Signal PM2 that app is ready (for zero-downtime reloads)
  if (process.send) {
    process.send("ready");
  }

  // Regenerate static JSON files on startup (non-blocking)
  if (getConfigExists()) {
    info("[Startup] Regenerating static JSON files...");
    const appRoot = path.resolve(__dirname, "../../");
    generateStaticJSONFiles(appRoot)
      .then((result) => {
        if (result.success) {
          info(
            `[Startup] ✓ Static JSON files updated (${result.albumCount} albums)`
          );
        } else {
          error("[Startup] ✗ Failed to generate static JSON:", result.error);
        }
      })
      .catch((error) => {
        error("[Startup] ✗ Failed to generate static JSON:", error);
      });
  }
  });

  // Set server timeout to 2 hours for large file uploads and long-running SSE connections
  // This allows uploading very large videos without timing out
  server.timeout = 7200000; // 2 hours
  server.keepAliveTimeout = 7210000; // Slightly longer than timeout
  server.headersTimeout = 7220000; // Slightly longer than keepAliveTimeout

  // Start milestone tracking service (only after setup is complete)
  if (getConfigExists()) {
    startMilestoneTracking();
  }

  // Start share link expiry tracking service (only after setup is complete)
  if (getConfigExists()) {
    import('./services/share-link-expiry-tracker.js').then(({ startShareLinkExpiryTracking }) => {
      startShareLinkExpiryTracking();
    }).catch((err) => {
      error('[Startup] Failed to start share link expiry tracking:', err);
    });
  }

  // Handle server errors
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      error(
        `Port ${PORT} is already in use. Please free the port or use a different one.`
      );
    } else if (err.code === "EACCES") {
      error(
        `Permission denied to bind to port ${PORT}. Try using a port above 1024.`
      );
    } else {
      error("[Server] Server error:", err);
    }
    process.exit(1);
  });
}).catch((err) => {
  error('[Server] Failed to initialize i18n:', err);
  process.exit(1);
});
