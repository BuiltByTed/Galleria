import express from "express";
import { publicApiUrl, publicSiteUrl, requestOrigin } from "../shared/deployment.js";
import { backendProxy } from "./proxy.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { error, info, warn, debug } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory cache for JSON files
const jsonCache = new Map();
const JSON_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

// In-memory cache for pre-rendered homepage HTML
let homepageHTMLCache = null;
let homepageHTMLCacheTime = 0;

// In-memory cache for header avatar base64
let headerAvatarBase64Cache = null;

// Configuration paths and defaults
const dataDir = process.env.DATA_DIR || path.join(__dirname, "../data");
const configPath = path.join(dataDir, "config.json");
const photosDir = path.join(dataDir, "photos");
const backendTarget = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:3001";

// Load initial configuration
let configFile;
let config;
let isSetupMode = false;

/**
 * Load header avatar as base64 data URL
 */
function loadHeaderAvatarBase64() {
  const headerAvatarPath = path.join(photosDir, "avatar-header.webp");
  if (fs.existsSync(headerAvatarPath)) {
    try {
      const avatarBuffer = fs.readFileSync(headerAvatarPath);
      headerAvatarBase64Cache = `data:image/webp;base64,${avatarBuffer.toString("base64")}`;
      info("[Frontend] Header avatar loaded as base64 (" + Math.round(headerAvatarBase64Cache.length / 1024) + "KB)");
    } catch (err) {
      error("[Frontend] Failed to load header avatar:", err);
      headerAvatarBase64Cache = null;
    }
  } else {
    headerAvatarBase64Cache = null;
  }
}

/**
 * Load configuration from disk
 */
function loadConfig() {
  if (fs.existsSync(configPath)) {
    configFile = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config = configFile.environment;

    // Override API URL from environment if provided
    config.frontend.apiUrl = publicApiUrl(config);
    isSetupMode = false;

    // Reload header avatar base64 (in case avatar was updated)
    loadHeaderAvatarBase64();

    info("[Frontend] Configuration reloaded");
  }
}

// Load initial config
if (fs.existsSync(configPath)) {
  loadConfig();
} else {
  // Setup mode - use defaults
  info("[Frontend] config.json not found - using defaults for setup mode");
  isSetupMode = true;
  configFile = {
    analytics: {},
  };
  config = {
    frontend: {
      port: 3000,
      apiUrl: publicApiUrl(),
    },
    security: {
      allowedHosts: ["localhost:3000", "127.0.0.1:3000"],
      redirectFrom: [],
      redirectTo: null,
    },
  };
}

/**
 * Build inline script that applies theme immediately (before React hydrates)
 * This prevents flash of unstyled/wrong-themed content
 */
function buildThemeScript(apiUrl, brandingData) {
  return `window.__RUNTIME_API_URL__ = ${JSON.stringify(apiUrl).replace(/</g, "\\u003c")}; window.__RUNTIME_BRANDING__ = ${JSON.stringify(brandingData)}; (function(){var b=window.__RUNTIME_BRANDING__;if(b){document.documentElement.setAttribute("data-header-theme",b.headerTheme||"light");document.documentElement.setAttribute("data-header-dropdown-theme",b.headerDropdownTheme||"light");document.documentElement.setAttribute("data-photo-grid-theme",b.photoGridTheme||"dark");if(b.headerTheme==="custom"){var s=document.documentElement.style;s.setProperty("--header-bg-color",b.headerBackgroundColor||"#e7e7e7");s.setProperty("--header-text-color",b.headerTextColor||"#1e1e1e");s.setProperty("--header-opacity",b.headerOpacity??1);s.setProperty("--header-blur",b.headerBlur??0);s.setProperty("--header-border-color",b.headerBorderColor||"#1e1e1e");s.setProperty("--header-border-opacity",b.headerBorderOpacity??0.2)}}})();`;
}

// watchFile also notices a config created by OOBE and atomic replacements.
fs.watchFile(configPath, { interval: 1000 }, () => {
  try { if (fs.existsSync(configPath)) loadConfig(); }
  catch (err) { error("[Frontend] Failed to reload config:", err); }
});

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || config.frontend.port;

// Security headers middleware (except CSP which needs runtime API URL)
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Enable XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions policy
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
  // CSP is set in catch-all route to use runtime API URL
  next();
});

function allowedHosts() {
  const hosts = [...(config.security?.allowedHosts || [])];
  const site = publicSiteUrl(config);
  if (site) hosts.push(new URL(site).host);
  return hosts;
}

// HTTPS redirect middleware (only in production)
app.use((req, res, next) => {
  const host = req.get("host");

  // Skip host validation during setup mode (OOBE)
  if (!isSetupMode && publicApiUrl(config)) {
    // Validate host to prevent open redirect attacks
    // Allow IP addresses for direct container access (e.g., Unraid WebUI)
    const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
    const isIpAddress = ipPattern.test(host);
    const isLocalhost =
      host && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));

    if (!allowedHosts().includes(host) && !isIpAddress && !isLocalhost) {
      warn(`[Security] Invalid host header: ${host}`);
      warn(`[Security] Allowed hosts: ${allowedHosts().join(", ")}`);
      return res.status(400).send("Invalid host header");
    }
  }

  // Redirect to HTTPS if apiUrl uses https (production/remote dev)
  // Skip HTTPS redirect for IP addresses (e.g., direct Docker access)
  const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
  const isIpAddress = ipPattern.test(host);
  const isProduction = publicSiteUrl(config).startsWith("https://");
  if (
    isProduction &&
    req.headers["x-forwarded-proto"] !== "https" &&
    !isIpAddress
  ) {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
});

// Domain redirect middleware (optional, for redirecting old domains)
app.use((req, res, next) => {
  const host = req.get("host");
  const redirectFrom = config.security.redirectFrom || [];
  const redirectTo = config.security.redirectTo;

  if (redirectFrom.length > 0 && redirectFrom.includes(host) && redirectTo) {
    return res.redirect(301, `https://${redirectTo}${req.originalUrl}`);
  }
  next();
});

// Serve primes page BEFORE React app (prevents React router from catching it)
// Handle both /primes and /primes/ with directory index support
app.use(
  "/primes",
  express.static(path.join(__dirname, "dist", "primes"), {
    index: "index.html",
  })
);

// Serve albums-data JSON files with no caching (must always be fresh)
// Express 5 changed wildcard syntax - use parameter instead
app.get("/albums-data/:filename", (req, res, next) => {
  // Only allow .json files
  if (!req.params.filename.endsWith('.json')) {
    return next();
  }
  
  const jsonPath = path.join(__dirname, "dist", "albums-data", req.params.filename);

  // Always read fresh from disk (no caching)
  fs.readFile(jsonPath, "utf8", (err, data) => {
    if (err) {
      return next(); // Fall through to express.static
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); // Never cache
    res.setHeader("X-Cache", "NONE");
    res.send(data);
  });
});

// Health check endpoint (must come before static files to avoid conflicts)
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Frontend server is running" });
});

// All browser-facing backend routes are available through the WebUI port.
app.use(["/api", "/photos", "/optimized", "/videos", "/sitemap.xml", "/robots.txt", "/logs"], backendProxy(backendTarget));
app.use("/notifications", backendProxy(backendTarget, url => url.replace(/^\/notifications(?=\/|\?|$)/, '/api/push-notifications')));

// Serve dynamic manifest.json with branding values
app.get("/manifest.json", (req, res) => {
  const siteName = configFile.branding?.siteName || "Galleria";
  const avatarPath = configFile.branding?.avatarPath || "/photos/avatar.png";

  // Derive site URL from API URL
  const apiUrl = publicApiUrl(config) || requestOrigin(req);
  const siteUrl = publicSiteUrl(config, process.env, requestOrigin(req));

  // Build full avatar URL
  const avatarUrl = `${apiUrl}${avatarPath}`;

  const manifest = {
    name: siteName,
    short_name: siteName,
    description: `Photography portfolio by ${siteName}`,
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    orientation: "portrait-primary",
    icons: [
      {
        src: avatarUrl,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: avatarUrl,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: avatarUrl,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache"); // Don't cache - always fresh
  res.json(manifest);
});

// Serve dynamic apple-touch-icon for iOS home screen
app.get("/apple-touch-icon.png", (req, res, next) => {
  // Check if custom icon exists in data/icons/
  const customIconPath = path.join(dataDir, "icons", "apple-touch-icon.png");
  if (fs.existsSync(customIconPath)) {
    return res.sendFile(customIconPath);
  }
  // Fall through to static files (defaults from dist/)
  next();
});

// Serve icons from data/icons/ if they exist, otherwise fall through to dist/ defaults
const iconFiles = ["icon-192.png", "icon-512.png", "favicon.ico", "favicon.png"];
iconFiles.forEach((iconFile) => {
  app.get(`/${iconFile}`, (req, res, next) => {
    const customIconPath = path.join(dataDir, "icons", iconFile);
    if (fs.existsSync(customIconPath)) {
      // Set appropriate content type
      const ext = path.extname(iconFile).toLowerCase();
      if (ext === ".png") {
        res.setHeader("Content-Type", "image/png");
      } else if (ext === ".ico") {
        res.setHeader("Content-Type", "image/x-icon");
      }
      res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 1 day
      return res.sendFile(customIconPath);
    }
    // Fall through to static files (defaults from dist/)
    next();
  });
});

// Serve static files from the dist directory
// But exclude index.html so we can inject runtime config
app.use(
  express.static(path.join(__dirname, "dist"), {
    index: false, // Don't serve index.html automatically - let catch-all handle it
  })
);

/**
 * Escape HTML special characters for safe insertion
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replace runtime placeholders with current config values
 */
function replaceRuntimePlaceholders(html, apiUrl, siteUrl = publicSiteUrl(config) || apiUrl) {
  const siteName = configFile.branding?.siteName || "Galleria";
  const avatarPath = configFile.branding?.avatarPath || "/photos/avatar.png";
  const runtimeSiteUrl = siteUrl;

  return html
    .replace(/__RUNTIME_SITE_NAME__/g, escapeHtml(siteName))
    .replace(/__RUNTIME_AVATAR_PATH__/g, escapeHtml(avatarPath))
    .replace(/__RUNTIME_SITE_URL__/g, escapeHtml(runtimeSiteUrl));
}

/**
 * Set Content Security Policy header
 */
function setCSPHeader(res, apiUrl, configFile) {
  const apiDomainHttps = apiUrl.replace("http://", "https://");
  const analyticsScriptPath = configFile.analytics?.scriptPath || "";
  const analyticsScriptHost =
    analyticsScriptPath && analyticsScriptPath.startsWith("http")
      ? new URL(analyticsScriptPath).origin
      : "";

  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      `script-src 'self' 'unsafe-inline'${
        analyticsScriptHost ? " " + analyticsScriptHost : ""
      }; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "worker-src 'self'; " +
      `img-src 'self' ${apiDomainHttps} ${apiUrl} data: blob: https://*.basemaps.cartocdn.com https://www.gravatar.com; ` +
      `media-src 'self' ${apiDomainHttps} ${apiUrl} blob:; ` +
      `connect-src 'self' ${apiDomainHttps} ${apiUrl}; ` +
      "font-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'; " +
      "frame-ancestors 'none';"
  );
}

// Handle client-side routing (catch-all for React routes)
// This must come AFTER all other routes
// Express 5: use regex for catch-all routes
app.get(/^\/.*/, async (req, res) => {
  const indexPath = path.join(__dirname, "dist", "index.html");

  // Check if this is the homepage (root path)
  if (req.path === "/") {
    // Try to serve pre-rendered homepage HTML if it exists
    const prerenderedPath = path.join(__dirname, "dist", "homepage-prerendered.html");
    
    if (fs.existsSync(prerenderedPath)) {
      try {
        // Check if we have cached HTML template in memory
        const fileStats = fs.statSync(prerenderedPath);
        const fileModTime = fileStats.mtimeMs;
        
        let htmlTemplate;
        
        // Use cached template if available and file hasn't changed
        if (homepageHTMLCache && homepageHTMLCacheTime === fileModTime) {
          debug("[SSR] Using pre-rendered homepage template from memory cache");
          htmlTemplate = homepageHTMLCache;
        } else {
          // Read from disk and cache in memory
          htmlTemplate = fs.readFileSync(prerenderedPath, "utf8");
          homepageHTMLCache = htmlTemplate;
          homepageHTMLCacheTime = fileModTime;
          info("[SSR] Loaded pre-rendered homepage HTML template into memory cache");
        }
        
        const runtimeApiUrl = publicApiUrl(config) || requestOrigin(req);

        // Replace placeholder API URL with runtime-detected one
        let html = htmlTemplate
          .replaceAll('__GALLERIA_API_ORIGIN__', escapeHtml(runtimeApiUrl))
          .replaceAll('__GALLERIA_SITE_ORIGIN__', escapeHtml(publicSiteUrl(config, process.env, requestOrigin(req))))
          .replace(
          /"http:\/\/localhost:3001"/g,
          `"${runtimeApiUrl}"`
        );
        
        html = html.replace(/window\.__RUNTIME_API_URL__ = "[^"]*";/g, `window.__RUNTIME_API_URL__ = ${JSON.stringify(runtimeApiUrl)};`);

        // Set CSP and other security headers
        setCSPHeader(res, runtimeApiUrl, configFile);
        
        // Tell browsers NOT to cache (always fetch fresh from server)
        // But server caches template in memory for instant serving
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, private");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("X-Cache", "HIT"); // Indicate this came from server cache
        
        debug(`[SSR] Serving pre-rendered homepage with runtime API URL: ${runtimeApiUrl}`);
        return res.send(html);
      } catch (err) {
        error("[SSR] Failed to read pre-rendered homepage:", err);
        // Clear cache on error
        homepageHTMLCache = null;
        homepageHTMLCacheTime = 0;
        // Fall through to default handling
      }
    } else {
      debug("[SSR] Pre-rendered homepage not found, using default index.html");
      // Fall through to default handling
    }
  }

  // Check if this is a shared album link
  const sharedMatch = req.path.match(/^\/shared\/([a-f0-9]{64})$/i);
  if (sharedMatch) {
    const secretKey = sharedMatch[1];

    try {
      // Fetch shared album data from backend
      const apiUrl = publicApiUrl(config) || requestOrigin(req);
      const response = await fetch(`${backendTarget}/api/shared/${secretKey}`, {
        headers: {
          'X-Meta-Injection': 'true' // Indicate this is for meta tag injection only
        }
      });

      if (response.ok) {
        const data = await response.json();
        const albumName = data.album;
        const photos = data.photos || [];

        // Get first photo as preview image
        const firstPhoto = photos[0];

        if (firstPhoto) {
          const safeAlbumName = escapeHtml(albumName);
          const albumTitleCase =
            albumName.charAt(0).toUpperCase() + albumName.slice(1);

          // Build URLs
          const siteUrl = publicSiteUrl(config, process.env, requestOrigin(req));

          // Use 2x2 grid preview image
          const gridUrl = `${apiUrl}/api/preview-grid/shared/${secretKey}`;
          const pageUrl = `${siteUrl}/shared/${secretKey}`;

          // Log meta tag injection
          debug(`[Meta Injection] Shared album link detected:`);
          debug(`  Album: ${albumName}`);
          debug(`  Secret Key: ${secretKey}`);
          debug(`  Preview Image: ${gridUrl}`);
          debug(`  Page URL: ${pageUrl}`);

          // Get site name from branding
          const siteName = configFile.branding?.siteName || "Galleria";
          const safeSiteName = escapeHtml(siteName);

          // Read and modify index.html
          const html = fs.readFileSync(indexPath, "utf8");
          const modifiedHtml = html
            .replace(
              /<title>.*?<\/title>/,
              `<title>${safeAlbumName} - Shared Album - ${safeSiteName}</title>`
            )
            .replace(
              /<meta name="title" content=".*?" \/>/,
              `<meta name="title" content="${safeAlbumName} - Shared Album" />`
            )
            .replace(
              /<meta name="description" content=".*?" \/>/,
              `<meta name="description" content="View the ${safeAlbumName} album shared. ${
                photos.length
              } photo${photos.length !== 1 ? "s" : ""} available." />`
            )
            .replace(
              /<link rel="canonical" href=".*?" \/>/,
              `<link rel="canonical" href="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:type" content=".*?" \/>/,
              `<meta property="og:type" content="article" />`
            )
            .replace(
              /<meta property="og:url" content=".*?" \/>/,
              `<meta property="og:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:title" content=".*?" \/>/,
              `<meta property="og:title" content="${albumTitleCase} - Shared Album" />`
            )
            .replace(
              /<meta property="og:description" content=".*?" \/>/,
              `<meta property="og:description" content="View the ${albumTitleCase} album shared by. ${
                photos.length
              } photo${photos.length !== 1 ? "s" : ""} available." />`
            )
            .replace(
              /<meta property="og:image" content=".*?" \/>/,
              `<meta property="og:image" content="${gridUrl}" />\n    <meta property="og:image:secure_url" content="${gridUrl.replace(
                "http://",
                "https://"
              )}" />\n    <meta property="og:image:alt" content="${safeAlbumName} - Galleria" />\n    <meta property="og:image:type" content="image/jpeg" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />`
            )
            .replace(
              /<meta property="twitter:url" content=".*?" \/>/,
              `<meta property="twitter:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="twitter:title" content=".*?" \/>/,
              `<meta property="twitter:title" content="${albumTitleCase} - Shared Album" />`
            )
            .replace(
              /<meta property="twitter:description" content=".*?" \/>/,
              `<meta property="twitter:description" content="View the ${albumTitleCase} album shared. ${photos.length} photos available." />`
            )
            .replace(
              /<meta property="twitter:image" content=".*?" \/>/,
              `<meta property="twitter:image" content="${gridUrl}" />`
            );

          // Replace runtime placeholders
          const htmlWithPlaceholders = replaceRuntimePlaceholders(
            modifiedHtml,
            apiUrl
          );
          
          // Inject runtime config and branding
          const brandingData = {
            siteName: configFile.branding?.siteName || "Galleria",
            avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
            headerAvatarPath: configFile.branding?.headerAvatarPath || "/photos/avatar-header.webp",
            headerAvatarBase64: headerAvatarBase64Cache,
            avatarCacheBust: configFile.branding?.avatarCacheBust || 0,
            primaryColor: configFile.branding?.primaryColor || "#4ade80",
            secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
            language: configFile.branding?.language || "en",
            headerTheme: configFile.branding?.headerTheme || "light",
            headerBackgroundColor: configFile.branding?.headerBackgroundColor || "#e7e7e7",
            headerTextColor: configFile.branding?.headerTextColor || "#1e1e1e",
            headerOpacity: configFile.branding?.headerOpacity ?? 1,
            headerBlur: configFile.branding?.headerBlur ?? 0,
            headerBorderColor: configFile.branding?.headerBorderColor || "#1e1e1e",
            headerBorderOpacity: configFile.branding?.headerBorderOpacity ?? 0.2,
            headerDropdownTheme: configFile.branding?.headerDropdownTheme || "light",
            photoGridTheme: configFile.branding?.photoGridTheme || "dark",
            gridColumns0: configFile.branding?.gridColumns0,
            gridColumns600: configFile.branding?.gridColumns600,
            gridColumns900: configFile.branding?.gridColumns900,
            gridColumns1200: configFile.branding?.gridColumns1200,
            gridColumns1600: configFile.branding?.gridColumns1600
          };

          // Inject custom CSS if present
          const customCSS = configFile.branding?.customCSS || "";
          let htmlWithCustomCSS = htmlWithPlaceholders;
          if (customCSS) {
            htmlWithCustomCSS = htmlWithPlaceholders.replace(
              '</head>',
              `<style id="custom-css">${customCSS}</style>\n  </head>`
            );
          }

          const htmlWithBranding = htmlWithCustomCSS.replace(
            '<script type="module"',
            `<script>${buildThemeScript(apiUrl, brandingData)}</script>\n    <script type="module"`
          );

          return res.send(htmlWithBranding);
        }
      }
    } catch (err) {
      error("[MetaInjection] Failed to fetch shared album data:", err);
      // Fall through to default index.html
    }
  }

  // Check if this is an album route
  const urlPath = req.path;
  const photoParam = req.query.photo;
  const albumMatch = urlPath.match(/^\/album\/([^\/]+)$/);

  // Handle album page (without specific photo)
  if (albumMatch && !photoParam) {
    const albumName = albumMatch[1];
    const apiUrl = publicApiUrl(config) || requestOrigin(req);

    try {
      // Fetch album data to get photo count
      const response = await fetch(`${backendTarget}/api/albums/${albumName}/photos`);

      if (response.ok) {
        const photos = await response.json();

        if (photos.length > 0) {
          // Derive site URL
          const siteUrl = publicSiteUrl(config, process.env, requestOrigin(req));

          // Use 2x2 grid preview image
          const gridUrl = `${apiUrl}/api/preview-grid/album/${albumName}`;
          const pageUrl = `${siteUrl}/album/${albumName}`;
          const albumTitleCase =
            albumName.charAt(0).toUpperCase() + albumName.slice(1);

          debug(`[Meta Injection] Album page detected:`);
          debug(`  Album: ${albumName}`);
          debug(`  Photos: ${photos.length}`);
          debug(`  Preview Image: ${gridUrl}`);
          debug(`  Page URL: ${pageUrl}`);

          const safeAlbumName = escapeHtml(albumTitleCase);

          // Get site name from branding
          const siteName = configFile.branding?.siteName || "Galleria";
          const safeSiteName = escapeHtml(siteName);

          // Read and modify HTML
          const html = fs.readFileSync(indexPath, "utf8");
          const modifiedHtml = html
            .replace(
              /<title>.*?<\/title>/,
              `<title>${safeAlbumName} - ${safeSiteName}</title>`
            )
            .replace(
              /<meta name="title" content=".*?" \/>/,
              `<meta name="title" content="${safeAlbumName} - Album" />`
            )
            .replace(
              /<meta name="description" content=".*?" \/>/,
              `<meta name="description" content="Explore ${
                photos.length
              } photo${
                photos.length !== 1 ? "s" : ""
              } from the ${safeAlbumName} album." />`
            )
            .replace(
              /<link rel="canonical" href=".*?" \/>/,
              `<link rel="canonical" href="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:type" content=".*?" \/>/,
              `<meta property="og:type" content="website" />`
            )
            .replace(
              /<meta property="og:url" content=".*?" \/>/,
              `<meta property="og:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:title" content=".*?" \/>/,
              `<meta property="og:title" content="${safeAlbumName} - Album" />`
            )
            .replace(
              /<meta property="og:description" content=".*?" \/>/,
              `<meta property="og:description" content="Explore ${
                photos.length
              } photo${
                photos.length !== 1 ? "s" : ""
              } from the ${safeAlbumName} album." />`
            )
            .replace(
              /<meta property="og:image" content=".*?" \/>/,
              `<meta property="og:image" content="${gridUrl}" />\n    <meta property="og:image:secure_url" content="${gridUrl.replace(
                "http://",
                "https://"
              )}" />\n    <meta property="og:image:alt" content="${safeAlbumName} - Galleria" />\n    <meta property="og:image:type" content="image/jpeg" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />`
            )
            .replace(
              /<meta property="twitter:url" content=".*?" \/>/,
              `<meta property="twitter:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="twitter:title" content=".*?" \/>/,
              `<meta property="twitter:title" content="${safeAlbumName} - Album" />`
            )
            .replace(
              /<meta property="twitter:description" content=".*?" \/>/,
              `<meta property="twitter:description" content="Explore ${
                photos.length
              } photo${
                photos.length !== 1 ? "s" : ""
              } from the ${safeAlbumName} album." />`
            )
            .replace(
              /<meta property="twitter:image" content=".*?" \/>/,
              `<meta property="twitter:image" content="${gridUrl}" />`
            );

          // Replace runtime placeholders
          const htmlWithPlaceholders = replaceRuntimePlaceholders(
            modifiedHtml,
            apiUrl
          );
          
          // Inject runtime config and branding
          const brandingData = {
            siteName: configFile.branding?.siteName || "Galleria",
            avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
            headerAvatarPath: configFile.branding?.headerAvatarPath || "/photos/avatar-header.webp",
            headerAvatarBase64: headerAvatarBase64Cache,
            avatarCacheBust: configFile.branding?.avatarCacheBust || 0,
            primaryColor: configFile.branding?.primaryColor || "#4ade80",
            secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
            language: configFile.branding?.language || "en",
            headerTheme: configFile.branding?.headerTheme || "light",
            headerBackgroundColor: configFile.branding?.headerBackgroundColor || "#e7e7e7",
            headerTextColor: configFile.branding?.headerTextColor || "#1e1e1e",
            headerOpacity: configFile.branding?.headerOpacity ?? 1,
            headerBlur: configFile.branding?.headerBlur ?? 0,
            headerBorderColor: configFile.branding?.headerBorderColor || "#1e1e1e",
            headerBorderOpacity: configFile.branding?.headerBorderOpacity ?? 0.2,
            headerDropdownTheme: configFile.branding?.headerDropdownTheme || "light",
            photoGridTheme: configFile.branding?.photoGridTheme || "dark",
            gridColumns0: configFile.branding?.gridColumns0,
            gridColumns600: configFile.branding?.gridColumns600,
            gridColumns900: configFile.branding?.gridColumns900,
            gridColumns1200: configFile.branding?.gridColumns1200,
            gridColumns1600: configFile.branding?.gridColumns1600
          };

          // Inject custom CSS if present
          const customCSS = configFile.branding?.customCSS || "";
          let htmlWithCustomCSS = htmlWithPlaceholders;
          if (customCSS) {
            htmlWithCustomCSS = htmlWithPlaceholders.replace(
              '</head>',
              `<style id="custom-css">${customCSS}</style>\n  </head>`
            );
          }

          const htmlWithBranding = htmlWithCustomCSS.replace(
            '<script type="module"',
            `<script>${buildThemeScript(apiUrl, brandingData)}</script>\n    <script type="module"`
          );

          return res.send(htmlWithBranding);
        }
      }
    } catch (err) {
      error("[MetaInjection] Failed to fetch album data:", err);
      // Fall through to default handling
    }
  }

  // Handle photo permalink (album route with photo parameter)
  if (albumMatch && photoParam) {
    const albumName = albumMatch[1];
    const photoFilename = photoParam;
    const apiUrl = publicApiUrl(config) || requestOrigin(req);

    try {
      // Fetch album photos to get the actual image title from database
      const response = await fetch(`${backendTarget}/api/albums/${albumName}/photos`);

      if (response.ok) {
        const photos = await response.json();

        // Find the specific photo by filename
        const photo = photos.find(
          (p) => p.id === `${albumName}/${photoFilename}`
        );

        if (photo) {
          // Use the actual title from the database
          const photoTitle = photo.title;
          const safePhotoTitle = escapeHtml(photoTitle);

          // Derive site URL from API URL:
          // Production: https://api.example.com -> https://www.example.com
          // Development: http://localhost:3001 -> http://localhost:3000
          // Dev server: https://api-dev.example.com -> https://www-dev.example.com
          const siteUrl = publicSiteUrl(config, process.env, requestOrigin(req));

          // Ensure thumbnail URL uses HTTPS for production
          // Use full URL with protocol for social media crawlers
          let thumbnailUrl = `${apiUrl}/optimized/thumbnail/${albumName}/${photoFilename}`;

          const pageUrl = `${siteUrl}/album/${albumName}?photo=${encodeURIComponent(
            photoFilename
          )}`;
          const albumTitleCase =
            albumName.charAt(0).toUpperCase() + albumName.slice(1);

          // Log meta tag injection for debugging
          debug(`[Meta Injection] Photo permalink detected:`);
          debug(`  Album: ${albumName}`);
          debug(`  Photo: ${photoFilename}`);
          debug(`  Title: ${photoTitle}`);
          debug(`  OG Image: ${thumbnailUrl}`);
          debug(
            `  OG Image (secure): ${thumbnailUrl.replace(
              "http://",
              "https://"
            )}`
          );
          debug(`  Page URL: ${pageUrl}`);

          // Get site name from branding
          const siteName = configFile.branding?.siteName || "Galleria";
          const safeSiteName = escapeHtml(siteName);

          // Read the index.html file
          const html = fs.readFileSync(indexPath, "utf8");

          // Replace meta tags with photo-specific content
          const modifiedHtml = html
            // Update page title
            .replace(
              /<title>.*?<\/title>/,
              `<title>${safePhotoTitle} - ${albumTitleCase} - ${safeSiteName}</title>`
            )
            // Update meta title
            .replace(
              /<meta name="title" content=".*?" \/>/,
              `<meta name="title" content="${safePhotoTitle} - ${albumTitleCase} - ${safeSiteName}" />`
            )
            // Update meta description
            .replace(
              /<meta name="description" content=".*?" \/>/,
              `<meta name="description" content="'${safePhotoTitle}' from the ${albumTitleCase} album" />`
            )
            // Update canonical URL
            .replace(
              /<link rel="canonical" href=".*?" \/>/,
              `<link rel="canonical" href="${pageUrl}" />`
            )
            // Update og:type to article for individual photos
            .replace(
              /<meta property="og:type" content=".*?" \/>/,
              `<meta property="og:type" content="article" />`
            )
            // Update og:url
            .replace(
              /<meta property="og:url" content=".*?" \/>/,
              `<meta property="og:url" content="${pageUrl}" />`
            )
            // Update og:title
            .replace(
              /<meta property="og:title" content=".*?" \/>/,
              `<meta property="og:title" content="${safePhotoTitle} - ${albumTitleCase}" />`
            )
            // Update og:description
            .replace(
              /<meta property="og:description" content=".*?" \/>/,
              `<meta property="og:description" content="'${safePhotoTitle}' from the ${albumTitleCase} album" />`
            )
            // Update og:image to the photo thumbnail
            .replace(
              /<meta property="og:image" content=".*?" \/>/,
              `<meta property="og:image" content="${thumbnailUrl}" />\n    <meta property="og:image:secure_url" content="${thumbnailUrl.replace(
                "http://",
                "https://"
              )}" />\n    <meta property="og:image:alt" content="${safePhotoTitle} - Galleria" />\n    <meta property="og:image:type" content="image/jpeg" />`
            )
            // Update twitter:url
            .replace(
              /<meta property="twitter:url" content=".*?" \/>/,
              `<meta property="twitter:url" content="${pageUrl}" />`
            )
            // Update twitter:title
            .replace(
              /<meta property="twitter:title" content=".*?" \/>/,
              `<meta property="twitter:title" content="${safePhotoTitle} - ${albumTitleCase}" />`
            )
            // Update twitter:description
            .replace(
              /<meta property="twitter:description" content=".*?" \/>/,
              `<meta property="twitter:description" content="'${safePhotoTitle}' from the ${albumTitleCase} album" />`
            )
            // Update twitter:image to the photo thumbnail
            .replace(
              /<meta property="twitter:image" content=".*?" \/>/,
              `<meta property="twitter:image" content="${thumbnailUrl}" />`
            );

          // Replace runtime placeholders
          const htmlWithPlaceholders = replaceRuntimePlaceholders(
            modifiedHtml,
            apiUrl
          );
          
          // Inject runtime config and branding
          const brandingData = {
            siteName: configFile.branding?.siteName || "Galleria",
            avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
            headerAvatarPath: configFile.branding?.headerAvatarPath || "/photos/avatar-header.webp",
            headerAvatarBase64: headerAvatarBase64Cache,
            avatarCacheBust: configFile.branding?.avatarCacheBust || 0,
            primaryColor: configFile.branding?.primaryColor || "#4ade80",
            secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
            language: configFile.branding?.language || "en",
            headerTheme: configFile.branding?.headerTheme || "light",
            headerBackgroundColor: configFile.branding?.headerBackgroundColor || "#e7e7e7",
            headerTextColor: configFile.branding?.headerTextColor || "#1e1e1e",
            headerOpacity: configFile.branding?.headerOpacity ?? 1,
            headerBlur: configFile.branding?.headerBlur ?? 0,
            headerBorderColor: configFile.branding?.headerBorderColor || "#1e1e1e",
            headerBorderOpacity: configFile.branding?.headerBorderOpacity ?? 0.2,
            headerDropdownTheme: configFile.branding?.headerDropdownTheme || "light",
            photoGridTheme: configFile.branding?.photoGridTheme || "dark",
            gridColumns0: configFile.branding?.gridColumns0,
            gridColumns600: configFile.branding?.gridColumns600,
            gridColumns900: configFile.branding?.gridColumns900,
            gridColumns1200: configFile.branding?.gridColumns1200,
            gridColumns1600: configFile.branding?.gridColumns1600
          };

          // Inject custom CSS if present
          const customCSS = configFile.branding?.customCSS || "";
          let htmlWithCustomCSS = htmlWithPlaceholders;
          if (customCSS) {
            htmlWithCustomCSS = htmlWithPlaceholders.replace(
              '</head>',
              `<style id="custom-css">${customCSS}</style>\n  </head>`
            );
          }

          const htmlWithBranding = htmlWithCustomCSS.replace(
            '<script type="module"',
            `<script>${buildThemeScript(apiUrl, brandingData)}</script>\n    <script type="module"`
          );

          return res.send(htmlWithBranding);
        }
      }
    } catch (err) {
      error("[MetaInjection] Failed to fetch photo data:", err);
      // Fall through to default handling
    }
  }

  // Default: serve the standard index.html
  // Inject runtime API URL for OOBE support
  fs.readFile(indexPath, "utf8", (err, html) => {
    if (err) {
      error("[Frontend] Failed to read index.html:", err);
      return res.sendFile(indexPath);
    }

    const runtimeApiUrl = publicApiUrl(config) || requestOrigin(req);

    // Set Content Security Policy with runtime API URL
    setCSPHeader(res, runtimeApiUrl, configFile);

    // Prevent caching of index.html to ensure placeholders are always fresh
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    // Get site name from branding and update title
    const siteName = configFile.branding?.siteName || "Galleria";
    const safeSiteName = escapeHtml(siteName);

    // Replace title tag with site name
    let modifiedHtml = html.replace(
      /<title>.*?<\/title>/,
      `<title>${safeSiteName}</title>`
    );

    // Replace runtime placeholders with current config values
    modifiedHtml = replaceRuntimePlaceholders(modifiedHtml, runtimeApiUrl);

    // Inject runtime config and branding before other scripts
    const brandingData = {
      siteName: configFile.branding?.siteName || "Galleria",
      avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
      headerAvatarPath: configFile.branding?.headerAvatarPath || "/photos/avatar-header.webp",
      headerAvatarBase64: headerAvatarBase64Cache,
      avatarCacheBust: configFile.branding?.avatarCacheBust || 0,
      primaryColor: configFile.branding?.primaryColor || "#4ade80",
      secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
      language: configFile.branding?.language || "en",
      headerTheme: configFile.branding?.headerTheme || "light",
      headerBackgroundColor: configFile.branding?.headerBackgroundColor || "#e7e7e7",
      headerTextColor: configFile.branding?.headerTextColor || "#1e1e1e",
      headerOpacity: configFile.branding?.headerOpacity ?? 1,
      headerBlur: configFile.branding?.headerBlur ?? 0,
      headerBorderColor: configFile.branding?.headerBorderColor || "#1e1e1e",
      headerBorderOpacity: configFile.branding?.headerBorderOpacity ?? 0.2,
      headerDropdownTheme: configFile.branding?.headerDropdownTheme || "light",
      photoGridTheme: configFile.branding?.photoGridTheme || "dark",
      gridColumns0: configFile.branding?.gridColumns0,
      gridColumns600: configFile.branding?.gridColumns600,
      gridColumns900: configFile.branding?.gridColumns900,
      gridColumns1200: configFile.branding?.gridColumns1200,
      gridColumns1600: configFile.branding?.gridColumns1600
    };

    // Inject custom CSS if present
    const customCSS = configFile.branding?.customCSS || "";
    if (customCSS) {
      modifiedHtml = modifiedHtml.replace(
        '</head>',
        `<style id="custom-css">${customCSS}</style>\n  </head>`
      );
    }

    modifiedHtml = modifiedHtml.replace(
      '<script type="module"',
      `<script>${buildThemeScript(runtimeApiUrl, brandingData)}</script>\n    <script type="module"`
    );

    res.send(modifiedHtml);
  });
});

// Listen on 0.0.0.0 for remote dev/production, 127.0.0.1 for localhost
// Allow HOST environment variable to override
const isLocalhost = config.frontend.apiUrl.includes("localhost");
const bindHost = process.env.HOST || (isLocalhost ? "127.0.0.1" : "0.0.0.0");

app.listen(port, bindHost, () => {
  info(`[Frontend] Server running on ${bindHost}:${port}`);
  info(`[Frontend] API URL: ${config.frontend.apiUrl}`);

  // Signal PM2 that app is ready (for zero-downtime reloads)
  if (process.send) {
    process.send("ready");
  }
});
