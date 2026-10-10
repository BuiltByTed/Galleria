/**
 * Security utilities and configuration management
 * Handles sensitive data and security-related functions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requestOrigin } from '../../shared/deployment.js';
import config, { getAllowedOrigins } from './config.js';
import { info, warn, error, debug, verbose, trace } from './utils/logger.js';
import { originsEqual } from './utils/origins-equal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load configuration with environment variable overrides for sensitive data
 */
export function loadSecureConfig() {
  // Use DATA_DIR from environment or default to project_root/data
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
  const configPath = path.join(dataDir, 'config.json');
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  const envConfig = rawConfig.environment;
  
  // Merge root-level config (analytics, branding, etc.) with environment config
  const fullConfig = {
    ...envConfig,
    analytics: rawConfig.analytics,
    branding: rawConfig.branding,
    externalLinks: rawConfig.externalLinks
  };
  
  // Override sensitive data with environment variables if available
  if (process.env.GOOGLE_CLIENT_SECRET) {
    fullConfig.auth.google.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  }
  
  if (process.env.SESSION_SECRET) {
    fullConfig.auth.sessionSecret = process.env.SESSION_SECRET;
  }
  
  if (process.env.ANALYTICS_USERNAME) {
    fullConfig.analytics.openobserve.username = process.env.ANALYTICS_USERNAME;
  }
  
  if (process.env.ANALYTICS_PASSWORD) {
    fullConfig.analytics.openobserve.password = process.env.ANALYTICS_PASSWORD;
  }
  
  if (process.env.ANALYTICS_SERVICE_TOKEN) {
    fullConfig.analytics.openobserve.serviceToken = process.env.ANALYTICS_SERVICE_TOKEN;
  }
  
  return fullConfig;
}

/**
 * Validate that required security configuration is present in production
 */
export function validateProductionSecurity() {
  const secureConfig = loadSecureConfig();
  
  // Skip validation if we're in setup mode (temporary session secret)
  const sessionSecret = secureConfig.auth?.sessionSecret;
  if (!sessionSecret || sessionSecret === 'CHANGE_ME_IN_PRODUCTION_OR_SETUP_WILL_GENERATE_ONE') {
    info('⚠️  Skipping security validation (setup mode)');
    return;
  }
  
  const isProduction = secureConfig.frontend?.apiUrl?.startsWith('https://');
  
  if (isProduction) {
    // Load the config to check if required values are present
    const requiredChecks = [
      { name: 'SESSION_SECRET', value: secureConfig.auth?.sessionSecret }
    ];
    if (secureConfig.auth?.google?.enabled) {
      requiredChecks.push({ name: 'GOOGLE_CLIENT_SECRET', value: secureConfig.auth.google.clientSecret });
    }
    
    // Only check analytics credentials if analytics is enabled
    const analyticsEnabled = secureConfig.analytics?.enabled;
    if (analyticsEnabled) {
      requiredChecks.push(
        { name: 'ANALYTICS_USERNAME', value: secureConfig.analytics?.openobserve?.username },
        { name: 'ANALYTICS_PASSWORD', value: secureConfig.analytics?.openobserve?.password }
      );
    }
    
    const missing = requiredChecks.filter(check => !check.value);
    
    if (missing.length > 0) {
      error('❌ SECURITY ERROR: Missing required security configuration in production:');
      missing.forEach(check => error(`  - ${check.name}`));
      error('\nPlease ensure these values are properly configured in config.json.');
      process.exit(1);
    }
  }
}

/**
 * Sanitize user input to prevent XSS and injection attacks
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  
  return input
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/['"]/g, '') // Remove quotes that could break JSON
    .trim()
    .substring(0, 1000); // Limit length
}

/**
 * Validate file upload security
 */
export function validateFileUpload(file: Express.Multer.File): { valid: boolean; error?: string } {
  // Check file size (50MB max)
  if (file.size > 50 * 1024 * 1024) {
    return { valid: false, error: 'File too large (max 50MB)' };
  }
  
  // Check MIME type
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid file type' };
  }
  
  // Check file extension
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return { valid: false, error: 'Invalid file extension' };
  }
  
  // Check for suspicious filenames
  if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\')) {
    return { valid: false, error: 'Invalid filename' };
  }
  
  return { valid: true };
}

/**
 * Simple CSRF protection middleware
 * For state-changing operations, require a valid session
 */
export function csrfProtection(req: any, res: any, next: any) {
  // Skip CSRF for GET, HEAD, OPTIONS requests
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  
  // For POST/PUT/DELETE, require authentication (check both Passport and credential sessions)
  const isPassportAuth = req.isAuthenticated && req.isAuthenticated();
  const isCredentialAuth = !!(req.session as any)?.userId;
  
  if (!isPassportAuth && !isCredentialAuth) {
    trace('[CSRF] Authentication required - not authenticated via any method');
    return res.status(401).json({ error: 'Authentication required for this operation' });
  }
  
  // Additional check: ensure the request comes from an allowed origin
  // Use Origin header, fallback to Referer
  let origin = req.get('Origin');
  if (!origin) {
    const referer = req.get('Referer');
    if (referer) {
      // Extract origin from referer URL
      try {
        const refererUrl = new URL(referer);
        origin = `${refererUrl.protocol}//${refererUrl.host}`;
      } catch (e) {
        // Invalid referer, skip origin check
      }
    }
  }
  
  if (origin) {
    // Get dynamic allowed origins (includes config.json values)
    const allowedOrigins = getAllowedOrigins();
    
    // Exact origin match (not startsWith — confusable subdomain bypass)
    let isAllowedOrigin = allowedOrigins.some((allowed: string) => originsEqual(origin, allowed));
    // The WebUI proxy preserves the public Host and protocol, including custom
    // Unraid ports. Only an exact same-origin request bypasses the CORS list.
    try { isAllowedOrigin ||= originsEqual(origin, requestOrigin(req)); } catch { /* reject malformed hosts */ }
    
    // If not in allowed list, check for localhost
    if (!isAllowedOrigin) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
          isAllowedOrigin = true;
        }
        
        // Check for IP addresses on ports 3000 or 3001 (Docker/Unraid direct access)
        if (!isAllowedOrigin) {
          const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);
          const ipPattern = /^\d+\.\d+\.\d+\.\d+$/;
          const isIpAddress = ipPattern.test(url.hostname);
          
          if (isIpAddress && (port === 3000 || port === 3001)) {
            isAllowedOrigin = true;
            trace(`[CSRF] Allowing IP-based access: ${origin}`);
          }
        }
      } catch (e) {
        // Invalid URL, reject
      }
    }
    
    if (!isAllowedOrigin) {
      warn('[CSRF] Origin not allowed:', origin);
      trace('[CSRF] Allowed origins:', allowedOrigins);
      return res.status(403).json({ error: 'Request origin not allowed' });
    }
  }
  
  trace('[CSRF] ✅ Protection passed for', req.method, req.path);
  next();
}
