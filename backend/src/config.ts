/**
 * Backend configuration - reads from config/config.json
 * This is the ONLY source of truth for all configuration
 */

// Load environment variables from .env file first (before any other imports)
import dotenv from "dotenv";
import crypto from 'node:crypto';
import { normalizeOrigin } from '../../shared/deployment.js';
dotenv.config();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { info, warn, error, trace } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Centralized data directory for all persistent data
// This allows easy Docker volume mounting at /data
export const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "../../data");

// Load config.json (the single source of truth)
const configPath = path.join(DATA_DIR, "config.json");

// Default configuration for when config.json doesn't exist yet
const defaultConfig = {
  environment: {
    frontend: {
      port: 3000,
      apiUrl: "",
    },
    backend: {
      port: 3001,
      allowedOrigins: ["http://localhost:3000"],
    },
    security: {
      allowedHosts: ["localhost:3000"],
      rateLimitWindowMs: 1000,
      rateLimitMaxRequests: 100,
    },
    logging: {
      level: "info",
    },
    auth: {
      google: {
        enabled: false,
        clientId: "",
        clientSecret: "",
      },
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      authorizedEmails: [],
    },
  },
  branding: {
    siteName: "Galleria",
    avatarPath: "/photos/avatar.png",
    primaryColor: "#4ade80",
    secondaryColor: "#22c55e",
    metaDescription: "Galleria",
    metaKeywords: "photography, portfolio",
    faviconPath: "/favicon.ico",
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
};

// Configuration state that can be reloaded
let fullConfig: any;
let configExists = false;

// Function to load/reload configuration
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      fullConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      configExists = true;
      // Use console.log here since logger might not be initialized yet
      info("[Config] Loaded configuration from config.json");
      return true;
    } else {
      warn("[Config] config.json not found - using defaults for setup mode");
      fullConfig = defaultConfig;
      configExists = false;
      return false;
    }
  } catch (err) {
    error("[Config] Failed to load config.json, using defaults:", err);
    fullConfig = defaultConfig;
    configExists = false;
    return false;
  }
}

// Load config on startup
loadConfig();

// Export hardcoded data directory paths (no longer configurable)
export const PHOTOS_DIR = path.join(DATA_DIR, "photos");
export const OPTIMIZED_DIR = path.join(DATA_DIR, "optimized");
export const DB_PATH = path.join(DATA_DIR, "gallery.db");

// Helper function to check if env var is actually set (not empty or sentinel values)
// Exported for use in other modules
export function isEnvSet(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  // Treat common "not set" sentinel values as unset
  return (
    trimmed !== "" &&
    trimmed !== "-" &&
    trimmed !== "notset" &&
    trimmed !== "none" &&
    trimmed !== "null"
  );
}

// Export dynamic getters for config values that can change
export function getAllowedOrigins(): string[] {
  const origins: string[] = [];
  const domain = normalizeOrigin(process.env.DOMAIN);
  if (domain) origins.push(domain);
  const siteUrl = fullConfig.environment.frontend.siteUrl;
  if (siteUrl) origins.push(siteUrl);

  trace("[CORS Debug] Environment variables:");
  trace("  FRONTEND_DOMAIN:", process.env.FRONTEND_DOMAIN || "(not set)");
  trace("  BACKEND_DOMAIN:", process.env.BACKEND_DOMAIN || "(not set)");
  trace("  ALLOWED_ORIGINS:", process.env.ALLOWED_ORIGINS || "(not set)");

  // Add FRONTEND_DOMAIN if provided (supports http:// and https://)
  if (isEnvSet(process.env.FRONTEND_DOMAIN)) {
    const frontendDomain = process.env.FRONTEND_DOMAIN!.trim();
    if (
      frontendDomain.startsWith("http://") ||
      frontendDomain.startsWith("https://")
    ) {
      origins.push(frontendDomain);
      trace("[CORS Debug] Added FRONTEND_DOMAIN:", frontendDomain);
    } else {
      // Auto-detect protocol based on BACKEND_DOMAIN or default to https
      const protocol =
        isEnvSet(process.env.BACKEND_DOMAIN) &&
        process.env.BACKEND_DOMAIN!.startsWith("https://")
          ? "https"
          : "https";
      const fullUrl = `${protocol}://${frontendDomain}`;
      origins.push(fullUrl);
      trace("[CORS Debug] Added FRONTEND_DOMAIN with protocol:", fullUrl);
    }
  }

  // Add BACKEND_DOMAIN if provided (for same-origin requests)
  if (isEnvSet(process.env.BACKEND_DOMAIN)) {
    const backendDomain = process.env.BACKEND_DOMAIN!.trim();
    if (
      backendDomain.startsWith("http://") ||
      backendDomain.startsWith("https://")
    ) {
      origins.push(backendDomain);
      trace("[CORS Debug] Added BACKEND_DOMAIN:", backendDomain);
    } else {
      const protocol = backendDomain.includes("localhost") ? "http" : "https";
      const fullUrl = `${protocol}://${backendDomain}`;
      origins.push(fullUrl);
      trace("[CORS Debug] Added BACKEND_DOMAIN with protocol:", fullUrl);
    }
  }

  // Always allow localhost on any port (for development)
  origins.push("http://localhost:3000");
  origins.push("http://localhost:3001");
  origins.push("http://127.0.0.1:3000");
  origins.push("http://127.0.0.1:3001");

  // Allow internal IPs on ports 3000 and 3001 (for Docker networking)
  // Pattern: http://<any-ip>:3000 or http://<any-ip>:3001
  // We'll handle this dynamically in the CORS middleware

  // Add ALLOWED_ORIGINS from environment if provided
  if (process.env.ALLOWED_ORIGINS) {
    const envOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o: string) =>
      o.trim()
    );
    origins.push(...envOrigins);
  }

  // Add origins from config.json (if exists and not overridden)
  if (
    !isEnvSet(process.env.ALLOWED_ORIGINS) &&
    !isEnvSet(process.env.FRONTEND_DOMAIN)
  ) {
    const configOrigins = fullConfig.environment.backend.allowedOrigins || [];
    origins.push(...configOrigins);
    trace("[CORS Debug] Added origins from config.json:", configOrigins);
  }

  // Remove duplicates
  const uniqueOrigins = [...new Set(origins)];
  trace("[CORS Debug] Final allowed origins:", uniqueOrigins);
  return uniqueOrigins;
}

/**
 * Whether a request Origin may be reflected with Access-Control-Allow-Credentials.
 * Mirrors the global CORS origin callback in server.ts so route-level headers
 * cannot bypass the allowlist (credentialed ACAO must never be set for unlisted origins).
 */
export function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) {
    return false;
  }

  // During OOBE (setup mode), allow any HTTPS origin — same as server CORS
  if (!getConfigExists() && origin.startsWith("https://")) {
    return true;
  }

  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.indexOf(origin) !== -1) {
    return true;
  }

  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return true;
    }

    // Docker / Unraid direct access: any IPv4 on ports 3000 or 3001
    const port = url.port
      ? parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80;
    const ipPattern = /^\d+\.\d+\.\d+\.\d+$/;
    if (ipPattern.test(url.hostname) && (port === 3000 || port === 3001)) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

// Export constants
export const PORT = process.env.PORT
  ? parseInt(process.env.PORT)
  : fullConfig.environment.backend.port;
export const RATE_LIMIT_WINDOW_MS =
  fullConfig.environment.security.rateLimitWindowMs;
export const RATE_LIMIT_MAX_REQUESTS =
  fullConfig.environment.security.rateLimitMaxRequests;

// Export function to check if config exists (dynamic, updated after reloadConfig)
export function getConfigExists(): boolean {
  return configExists;
}

// Export function to reload configuration (called after setup wizard completes)
export function reloadConfig() {
  info("🔄 Reloading configuration...");
  const success = loadConfig();
  if (success) {
    info("✅ Configuration reloaded successfully");
  }
  return { success, configExists };
}

// Export log level getter
/**
 * Get log level from environment variable (highest priority) or config.json
 * Priority: LOG_LEVEL env var > config.json > default 'error'
 */
export function getLogLevel(): string {
  // Environment variable takes highest priority (for Docker/.env)
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL.toLowerCase().trim();
  }
  // Fall back to config.json
  if (fullConfig.environment?.logging?.level) {
    return fullConfig.environment.logging.level;
  }
  // Default to error
  return "error";
}

// Export function to get current config (always fresh)
export function getCurrentConfig() {
  return {
    ...fullConfig.environment,
    analytics: fullConfig.analytics,
    branding: fullConfig.branding,
    externalLinks: fullConfig.externalLinks,
    email: fullConfig.email,
    frontend: fullConfig.environment.frontend,
    pushNotifications: fullConfig.pushNotifications,
    notificationPreferences: fullConfig.notificationPreferences,
    configExists,
  };
}

// Export the full config for routes that need it (analytics, sitemap, etc)
export default {
  ...fullConfig.environment,
  analytics: fullConfig.analytics,
  branding: fullConfig.branding,
  externalLinks: fullConfig.externalLinks,
  email: fullConfig.email,
  frontend: fullConfig.environment.frontend,
  pushNotifications: fullConfig.pushNotifications,
};
