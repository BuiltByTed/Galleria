/**
 * Setup Routes
 * Handles initial setup and configuration for first-time users
 */

import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { publicApiUrl, publicSiteUrl, requestOrigin, normalizeOrigin } from "../../../shared/deployment.js";
import multer from "multer";
import sharp from "sharp";
import https from "https";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { sendInstallationEvent } from '../utils/installation-analytics.js';

const router = Router();
let initializing = false;

// Configure multer for avatar uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images only (including HEIC which will be converted to PNG)
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type SetupChecks = {
  configExists: boolean;
  databaseExists: boolean;
  photosDirExists: boolean;
  optimizedDirExists: boolean;
  hasPhotos: boolean;
  isConfigured: boolean;
};

function getSetupState(): { setupComplete: boolean; checks: SetupChecks } {
  const projectRoot = path.join(__dirname, "../../../");
  const dataDir = process.env.DATA_DIR || path.join(projectRoot, "data");
  const configPath = path.join(dataDir, "config.json");
  const dbPath = path.join(dataDir, "gallery.db");
  const photosDir = path.join(dataDir, "photos");
  const optimizedDir = path.join(dataDir, "optimized");

  const checks = {
    configExists: fs.existsSync(configPath),
    databaseExists: fs.existsSync(dbPath),
    photosDirExists: fs.existsSync(photosDir),
    optimizedDirExists: fs.existsSync(optimizedDir),
    hasPhotos: false,
    isConfigured: false,
  };

  // Check if photos directory has any albums
  if (checks.photosDirExists) {
    const entries = fs.readdirSync(photosDir, { withFileTypes: true });
    checks.hasPhotos = entries.some((entry) => entry.isDirectory());
  }

  // Check if config is properly configured (not just example values)
  if (checks.configExists) {
    try {
      const configContent = fs.readFileSync(configPath, "utf8");
      const config = JSON.parse(configContent);

      const hasValidAuth =
        config.environment?.auth?.sessionSecret &&
        config.environment.auth.sessionSecret !== "your-session-secret-here";
      const hasValidBranding =
        config.branding?.siteName && config.branding.siteName !== "Your Name";

      checks.isConfigured = hasValidAuth && hasValidBranding;
    } catch (err) {
      checks.isConfigured = false;
    }
  }

  const setupComplete =
    checks.configExists && checks.databaseExists && checks.isConfigured;

  return { setupComplete, checks };
}

function rejectIfSetupComplete(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { setupComplete } = getSetupState();

  if (setupComplete) {
    res.status(409).json({ error: "Setup is already complete" });
    return;
  }

  next();
}

/**
 * Download GeoIP database for location lookup
 * Uses DB-IP's free database (no registration required)
 */
async function downloadGeoIPDatabase(dataDir: string): Promise<boolean> {
  try {
    const dbPath = path.join(dataDir, 'GeoLite2-City.mmdb');
    
    // Skip if already exists
    if (fs.existsSync(dbPath)) {
      info('[Setup] GeoIP database already exists, skipping download');
      return true;
    }
    
    info('[Setup] Downloading GeoIP database...');
    
    // Get current year and month for DB-IP URL
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    
    // DB-IP free database URL (updated monthly)
    const dbipUrl = `https://download.db-ip.com/free/dbip-city-lite-${year}-${month}.mmdb.gz`;
    
    return new Promise((resolve) => {
      https.get(dbipUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            info('[Setup] Following redirect to:', redirectUrl);
            https.get(redirectUrl, (redirectResponse) => {
              if (redirectResponse.statusCode === 200) {
                const gunzip = createGunzip();
                const fileStream = createWriteStream(dbPath);
                
                redirectResponse.pipe(gunzip).pipe(fileStream);
                
                fileStream.on('finish', () => {
                  info('[Setup] GeoIP database downloaded successfully');
                  resolve(true);
                });
                
                fileStream.on('error', (err) => {
                  error('[Setup] Failed to write GeoIP database:', err);
                  // Clean up partial file
                  if (fs.existsSync(dbPath)) {
                    fs.unlinkSync(dbPath);
                  }
                  resolve(false);
                });
              } else {
                warn('[Setup] Failed to download GeoIP database (redirect response):', redirectResponse.statusCode);
                resolve(false);
              }
            }).on('error', (err) => {
              warn('[Setup] Failed to download GeoIP database (redirect):', err);
              resolve(false);
            });
          } else {
            warn('[Setup] No redirect location provided');
            resolve(false);
          }
        } else if (response.statusCode === 200) {
          const gunzip = createGunzip();
          const fileStream = createWriteStream(dbPath);
          
          response.pipe(gunzip).pipe(fileStream);
          
          fileStream.on('finish', () => {
            info('[Setup] GeoIP database downloaded successfully');
            resolve(true);
          });
          
          fileStream.on('error', (err) => {
            error('[Setup] Failed to write GeoIP database:', err);
            // Clean up partial file
            if (fs.existsSync(dbPath)) {
              fs.unlinkSync(dbPath);
            }
            resolve(false);
          });
        } else {
          warn('[Setup] Failed to download GeoIP database, status:', response.statusCode);
          warn('[Setup] This is optional - location lookup will show "Location unknown"');
          resolve(false);
        }
      }).on('error', (err) => {
        warn('[Setup] Failed to download GeoIP database:', err);
        warn('[Setup] This is optional - location lookup will show "Location unknown"');
        resolve(false);
      });
    });
  } catch (err) {
    warn('[Setup] GeoIP database download failed:', err);
    warn('[Setup] This is optional - location lookup will show "Location unknown"');
    return false;
  }
}

/**
 * Check if initial setup is complete
 */
router.get("/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const { setupComplete, checks } = getSetupState();

    // Only send installation_started event if setup is NOT complete (actual OOBE)
    if (!setupComplete) {
      // Capture origin URL - prefer referer (shows frontend domain) over host (shows API domain)
      let origin = 'unknown';
      const refererHeader = req.headers.referer || req.headers.referrer;
      const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;

      if (referer) {
        // Extract origin from referer URL (e.g., "https://www-docker.tedcharles.net/")
        try {
          const refererUrl = new URL(referer);
          origin = refererUrl.origin; // Gets protocol + host
        } catch (err) {
          warn('[Setup] Failed to parse referer URL:', referer);
        }
      }

      // Fallback to host header if no referer
      if (origin === 'unknown') {
        const protocol = req.headers["x-forwarded-proto"] ||
                        (req.headers["x-forwarded-ssl"] === "on" ? "https" : undefined) ||
                        (req.secure ? "https" : "http");
        const hostHeader = req.headers["x-forwarded-host"] ||
                          req.headers["x-original-host"] ||
                          req.headers["host"];
        if (hostHeader) {
          const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
          origin = `${protocol}://${host}`;
        }
      }

      info(`[Setup] Sending installation_started event from origin: ${origin}`);

      sendInstallationEvent('installation_started', {
        origin_url: origin,
        referrer: req.headers.referer || req.headers.referrer || 'direct',
      }).catch(err => {
        warn('[Setup] Failed to send installation_started event:', err);
      });
    }

    res.json({
      setupComplete,
      checks,
    });
  } catch (err) {
    error("Setup status check failed:", err);
    res.status(500).json({
      error: "Failed to check setup status",
      setupComplete: false,
    });
  }
});

/**
 * Initialize configuration with user-provided values
 */
router.post(
  "/initialize",
  rejectIfSetupComplete,
  (req, res, next) => {
    if (initializing) { res.status(409).json({ error: "Setup is already in progress" }); return; }
    initializing = true;
    next();
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        siteName,
        authorizedEmail,
        adminUsername,
        authMethod,
        adminName,
        adminPassword,
        googleClientId,
        googleClientSecret,
        metaDescription,
        language,
      } = req.body;

      if (typeof siteName !== "string" || !siteName.trim() || !["password", "google"].includes(authMethod)) {
        res.status(400).json({ error: "Site name and a supported authentication method are required" });
        return;
      }
      // Keep accepting the old password-setup email payload for existing clients.
      // The legacy email column stores the login identifier; local usernames do
      // not require a schema migration or a fabricated email address.
      const identifier = (authMethod === "password" ? adminUsername ?? authorizedEmail : authorizedEmail);
      const login = typeof identifier === "string" ? identifier.trim() : "";
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login);
      if (authMethod === "password") {
        if (adminUsername !== undefined ? !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(login) : !validEmail) {
          res.status(400).json({ error: "Username must be 3–64 characters: letters, numbers, dots, underscores or hyphens" });
          return;
        }
        if (typeof adminName !== "string" || !adminName.trim() || typeof adminPassword !== "string" || adminPassword.length < 8 || Buffer.byteLength(adminPassword) > 72) {
          res.status(400).json({ error: "Name and a password of at least 8 characters (at most 72 bytes) are required" });
          return;
        }
      } else if (!validEmail || typeof googleClientId !== "string" || !googleClientId.trim() || typeof googleClientSecret !== "string" || !googleClientSecret.trim()) {
        res.status(400).json({ error: "A valid email, Google Client ID and Secret are required for Google authentication" });
        return;
      }

      // No domain guessing: a blank API URL means the current browser origin.
      // Explicit legacy variables still select a separate backend.
      const backendUrl = publicApiUrl();
      const frontendUrl = publicSiteUrl({}, process.env, normalizeOrigin(req.get("origin")) || requestOrigin(req));
      const frontendHost = new URL(frontendUrl).host;

      const projectRoot = path.join(__dirname, "../../../");
      const dataDir = process.env.DATA_DIR || path.join(projectRoot, "data");
      const configPath = path.join(dataDir, "config.json");
      const configDefaultsPath = path.join(
        projectRoot,
        "config/config.defaults.json"
      );

      // Create config directory if it doesn't exist
      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Load defaults config as template
      let config;
      if (fs.existsSync(configDefaultsPath)) {
        const defaultsContent = fs.readFileSync(configDefaultsPath, "utf8");
        config = JSON.parse(defaultsContent);
        // Override URLs with auto-detected values
        config.environment.frontend.apiUrl = backendUrl;
        config.environment.backend.allowedOrigins = [frontendUrl];
        config.environment.security.allowedHosts = [frontendHost];
      } else {
        // Fallback: create minimal config structure
        config = {
          environment: {
            features: {
              useGridSettings: true
            },
            frontend: {
              port: 3000,
              apiUrl: backendUrl,
            },
            backend: {
              port: 3001,
              photosDir: "photos",
              allowedOrigins: [frontendUrl],
            },
            optimization: {
              concurrency: 4,
              images: {
                thumbnail: { quality: 60, maxDimension: 512 },
                modal: { quality: 90, maxDimension: 2048 },
                download: { quality: 100, maxDimension: 4096 },
              },
            },
            security: {
              allowedHosts: [frontendHost],
              rateLimitWindowMs: 1000,
              rateLimitMaxRequests: 30,
              redirectFrom: [],
              redirectTo: "",
            },
            logging: {
              level: "error",
            },
            auth: {
              google: {
                enabled: false,
                clientId: "",
                clientSecret: "",
              },
              sessionSecret: "",
              authorizedEmails: [],
            },
          },
          branding: {
            siteName: "",
            avatarPath: "/photos/avatar.png",
            primaryColor: "#4ade80",
            secondaryColor: "#22c55e",
            metaDescription: "",
            metaKeywords: "",
            faviconPath: "/favicon.ico",
            language: "en",
          },
          analytics: {
            scriptPath: "",
            openobserve: {
              enabled: false,
              endpoint: "",
              organization: "",
              stream: "website",
              username: "",
              password: "",
            },
          },
          externalLinks: [],
          openai: {
            apiKey: "",
          },
          ai: {
            autoGenerateTitlesOnUpload: false,
          },
        };
      }

      // Generate secure session secret
      const sessionSecret = crypto.randomBytes(32).toString("hex");

      // Update config with user-provided values
      config.branding.siteName = siteName;
      config.branding.metaDescription =
        metaDescription || `Photography portfolio by ${siteName}`;
      config.branding.metaKeywords = `photography, portfolio, ${siteName.toLowerCase()}`;
      config.branding.language = language || "en";

      config.environment.auth.sessionSecret = sessionSecret;
      config.environment.auth.authorizedEmails = authMethod === "google" ? [login] : [];
      config.environment.frontend.siteUrl = frontendUrl;

      // Configure Google OAuth if using Google auth method
      if (authMethod === "google" && googleClientId && googleClientSecret) {
        config.environment.auth.google.enabled = true;
        config.environment.auth.google.clientId = googleClientId;
        config.environment.auth.google.clientSecret = googleClientSecret;
      } else {
        // Disable Google auth for password-based setup
        config.environment.auth.google.enabled = false;
      }

      // Publish config only after the admin account has been created successfully.

      // Create necessary directories
      const photosDir = path.join(dataDir, "photos");
      const optimizedDir = path.join(dataDir, "optimized");

      info("Creating directories:");
      info("  Photos:", photosDir);
      info("  Optimized:", optimizedDir);

      if (!fs.existsSync(photosDir)) {
        fs.mkdirSync(photosDir, { recursive: true });
        info("  Created photos directory");
      }
      if (!fs.existsSync(optimizedDir)) {
        fs.mkdirSync(optimizedDir, { recursive: true });
        info("  Created optimized directory");
      }

      // Initialize the database to create gallery.db
      try {
        const { initializeDatabase } = await import("../database.js");
        const db = initializeDatabase();
        info("  Database initialized");

        // Create users table if it doesn't exist
        info("  📝 Creating users table...");
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

        // Create indexes for users table
        db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
      `);
        db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)
      `);
        db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users(invite_token)
      `);
        db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token)
      `);

        info("  Users table created");
      } catch (err) {
        error("Failed to initialize database:", err);
        // Continue anyway - database will be created on first access
      }

      // Create the first admin user
      info("\n👤 Creating admin user...");
      try {
        const { createUser, getUserByEmail } = await import(
          "../database-users.js"
        );

        // Check if user already exists
        const existingUser = getUserByEmail(login);
        if (existingUser) {
          info("  ⚠️ User already exists, skipping user creation");
        } else {
          // Prepare auth methods array
          const authMethods =
            authMethod === "password" ? ["credentials"] : ["google"];

          // Create the user
          const userData: {
            email: string;
            password?: string;
            auth_methods: string[];
            name?: string;
            email_verified: boolean;
            role: string;
          } = {
            email: login,
            auth_methods: authMethods,
            email_verified: authMethod === "google",
            role: "admin", // First user is always admin
          };

          if (authMethod === "password") {
            userData.password = adminPassword;
            userData.name = adminName;
          }

          const user = createUser(userData);
          info("  Admin user created:", user.email);
        }
      } catch (err) {
        error("  Failed to create admin user:", err);
        res.status(500).json({
          error: "Failed to create admin user",
          details: err instanceof Error ? err.message : "Unknown error",
        });
        return;
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

      // Reload backend configuration
      info("\nReloading backend configuration...");
      try {
        const { reloadConfig } = await import("../config.js");
        const reloadResult = reloadConfig();
        if (reloadResult.success) {
          info("  Configuration reloaded successfully");
        }
      } catch (err) {
        error("  Failed to reload configuration:", err);
      }

      // Initialize Google OAuth strategy with new config
      info("\n🔐 Initializing Google OAuth...");
      try {
        const { initializeGoogleStrategy } = await import("./auth.js");
        const oauthInitialized = initializeGoogleStrategy();
        if (oauthInitialized) {
          info("  Google OAuth strategy initialized from setup");
        } else {
          info("  ⚠️ Google OAuth initialization returned false");
        }
      } catch (err) {
        error("  Failed to initialize Google OAuth:", err);
      }

      // Set up default avatar if none will be uploaded
      // This copies the default Galleria logo as the avatar
      info("\n🖼️ Setting up default avatar...");
      try {
        const photosDir = path.join(dataDir, "photos");
        const iconsDir = path.join(dataDir, "icons");
        const avatarPath = path.join(photosDir, "avatar.png");

        // Create icons directory if it doesn't exist
        if (!fs.existsSync(iconsDir)) {
          fs.mkdirSync(iconsDir, { recursive: true });
        }

        // Use the default Galleria logo (icon-512.png for best quality)
        const defaultIconPath = path.join(projectRoot, "config/icons/icon-512.png");

        if (fs.existsSync(defaultIconPath) && !fs.existsSync(avatarPath)) {
          // Copy as avatar.png
          await sharp(defaultIconPath)
            .resize(512, 512, { fit: 'cover' })
            .png()
            .toFile(avatarPath);

          // Generate all icon variants
          const icon192Path = path.join(iconsDir, 'icon-192.png');
          const icon512Path = path.join(iconsDir, 'icon-512.png');
          const appleTouchIconPath = path.join(iconsDir, 'apple-touch-icon.png');
          const faviconPngPath = path.join(iconsDir, 'favicon.png');
          const faviconIcoPath = path.join(iconsDir, 'favicon.ico');

          await sharp(defaultIconPath)
            .resize(192, 192, { fit: 'cover' })
            .png()
            .toFile(icon192Path);

          await sharp(defaultIconPath)
            .resize(512, 512, { fit: 'cover' })
            .png()
            .toFile(icon512Path);

          await sharp(defaultIconPath)
            .resize(192, 192, { fit: 'cover' })
            .png()
            .toFile(appleTouchIconPath);

          await sharp(defaultIconPath)
            .resize(512, 512, { fit: 'cover' })
            .png()
            .toFile(faviconPngPath);

          await sharp(defaultIconPath)
            .resize(32, 32, { fit: 'cover' })
            .toFormat('png')
            .toFile(faviconIcoPath);

          // Update config with avatar path
          config.branding.avatarPath = "/photos/avatar.png";
          config.branding.faviconPath = "/favicon.ico";
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

          info("  ✓ Default avatar and icons set up successfully");
        } else if (fs.existsSync(avatarPath)) {
          info("  Custom avatar already exists, preserving it");
        } else {
          warn("  ⚠️ Default icon not found at:", defaultIconPath);
        }
      } catch (err) {
        warn("  Failed to set up default avatar:", err);
        // Non-fatal - continue with setup
      }

      // Download GeoIP database in the background (don't block setup completion)
      info("\n🌍 Downloading GeoIP database for location lookup...");
      downloadGeoIPDatabase(dataDir).then(success => {
        if (success) {
          info("  ✓ GeoIP database downloaded successfully");
        } else {
          info("  ⚠️ GeoIP database download failed (location lookup will show 'Location unknown')");
        }
      }).catch(err => {
        warn("  GeoIP database download error:", err);
      });

      // Only restart if Google OAuth is selected (needs OAuth strategy initialization)
      // Password auth doesn't need restart - config reloaded dynamically
      const requiresRestart = authMethod === "google";

      // Send setup_complete event with origin URL
      const origin = requestOrigin(req);
      sendInstallationEvent('setup_complete', {
        auth_method: authMethod,
        site_name: siteName,
        origin_url: origin,
        frontend_url: frontendUrl,
        backend_url: backendUrl,
      }).catch(err => {
        warn('[Setup] Failed to send setup_complete event:', err);
      });

      res.json({
        success: true,
        message: "Configuration initialized successfully",
        requiresRestart,
      });

      if (requiresRestart) {
        // Gracefully restart the backend after sending response
        // This ensures Google OAuth strategy is properly initialized
        info(
          "\nTriggering backend restart to initialize Google OAuth..."
        );
        setTimeout(() => {
          info("Setup complete - exiting for restart");
          process.exit(0); // Exit cleanly - PM2/Docker will restart the process
        }, 500); // Wait 500ms to ensure response is sent, then restart immediately
      } else {
        info("\nSetup complete - no restart needed for password auth");
      }
    } catch (err) {
      error("Setup initialization failed:", err);
      res.status(500).json({
        error: "Failed to initialize configuration",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      initializing = false;
    }
  }
);

/**
 * Upload avatar during setup
 */
router.post(
  "/upload-avatar",
  rejectIfSetupComplete,
  upload.single("avatar"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const file = req.file;

      if (!file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const projectRoot = path.join(__dirname, "../../../");
      const dataDir = process.env.DATA_DIR || path.join(projectRoot, "data");
      const photosDir = path.join(dataDir, "photos");
      const iconsDir = path.join(dataDir, "icons");

      // Create directories if they don't exist
      if (!fs.existsSync(photosDir)) {
        fs.mkdirSync(photosDir, { recursive: true });
      }
      if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
      }

      // Always save as PNG
      const avatarPath = path.join(photosDir, "avatar.png");
      const faviconPngPath = path.join(iconsDir, 'favicon.png');
      const faviconIcoPath = path.join(iconsDir, 'favicon.ico');

      // Use Sharp to convert any image format (including HEIC) to PNG and generate favicons
      try {
        // Process and save avatar.png with auto-rotation based on EXIF
        await sharp(file.buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(512, 512, { fit: 'cover' })
          .png()
          .toFile(avatarPath);

        // Update icon files so they stay in sync with avatar
        const icon192Path = path.join(iconsDir, 'icon-192.png');
        const icon512Path = path.join(iconsDir, 'icon-512.png');
        const appleTouchIconPath = path.join(iconsDir, 'apple-touch-icon.png');

        // Generate icon-192.png (192x192)
        await sharp(file.buffer)
          .rotate()
          .resize(192, 192, { fit: 'cover' })
          .png()
          .toFile(icon192Path);

        // Generate icon-512.png (512x512)
        await sharp(file.buffer)
          .rotate()
          .resize(512, 512, { fit: 'cover' })
          .png()
          .toFile(icon512Path);

        // Generate apple-touch-icon.png (192x192)
        await sharp(file.buffer)
          .rotate()
          .resize(192, 192, { fit: 'cover' })
          .png()
          .toFile(appleTouchIconPath);

        // Create favicon.png (same as avatar)
        await sharp(file.buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(512, 512, { fit: 'cover' })
          .png()
          .toFile(faviconPngPath);

        // Generate favicon.ico (32x32) using Sharp
        await sharp(file.buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(32, 32, { fit: 'cover' })
          .toFormat('png')
          .toFile(faviconIcoPath);

        info('[Setup] Generated avatar.png, icon files, and favicons to data/icons/');
      } catch (err) {
        error("Failed to process avatar image:", err);
        res.status(500).json({ error: "Failed to process avatar image" });
        return;
      }

      // Update config.json with avatar and favicon paths
      const configPath = path.join(dataDir, "config.json");
      if (fs.existsSync(configPath)) {
        try {
          const configContent = fs.readFileSync(configPath, "utf8");
          const config = JSON.parse(configContent);
          if (!config.branding) {
            config.branding = {};
          }
          config.branding.avatarPath = "/photos/avatar.png";
          config.branding.faviconPath = "/favicon.ico";
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
          info('[Setup] Updated config with avatar and favicon paths');
        } catch (err) {
          error("Failed to update config with avatar path:", err);
        }
      }

      res.json({
        success: true,
        avatarPath: "/photos/avatar.png",
      });
    } catch (err) {
      error("Avatar upload failed:", err);
      res.status(500).json({
        error: "Failed to upload avatar",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
);

export default router;
