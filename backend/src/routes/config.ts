/**
 * Configuration Management Routes
 * Provides endpoints for reading and updating configuration
 */

import express from "express";
import { publicApiUrl } from "../../../shared/deployment.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { csrfProtection } from "../security.js";
import { requireAdmin } from "../auth/middleware.js";
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { getAllUsers } from '../database-users.js';
import { DATA_DIR, reloadConfig, getLogLevel } from "../config.js";
import { sendTestEmail } from "../email.js";
import { initLogger } from '../utils/logger.js';
import {
  maskSensitiveFields,
  restoreSensitiveFields,
} from "../utils/config-secrets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * Helper to send push notification to all admin users
 */
async function notifyAllAdmins(title: string, body: string, tag: string, notificationType?: any, variables?: Record<string, any>): Promise<void> {
  try {
    const admins = getAllUsers().filter(u => u.role === 'admin');
    
    for (const admin of admins) {
      const translatedTitle = await translateNotification(title, variables);
      const translatedBody = await translateNotification(body, variables);
      
      await sendNotificationToUser(admin.id, {
        title: translatedTitle,
        body: translatedBody,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        requireInteraction: false
      }, notificationType);
    }
  } catch (err) {
    error('[Config] Failed to send admin notification:', err);
  }
}

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LOGS_DIR = path.join(DATA_DIR, "logs");

/**
 * GET /api/config/runtime
 * Get runtime configuration for frontend (public endpoint for OOBE support)
 * Returns API URL auto-detected from request headers when config doesn't exist
 */
router.get("/runtime", (req, res) => {
  try {
    const configExists = fs.existsSync(CONFIG_PATH);
    const environment = configExists ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).environment : {};
    res.json({ apiUrl: publicApiUrl(environment), configExists });
  } catch (err) {
    error("[Config] Failed to read runtime config:", err);
    res.status(500).json({ error: "Failed to read runtime configuration" });
  }
});

// Apply CSRF protection to all other routes
router.use(csrfProtection);

/**
 * GET /api/config
 * Admin only. Sensitive secrets are masked (not returned in cleartext).
 */
router.get("/", requireAdmin, (req, res) => {
  try {
    const configData = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(configData);

    res.json(maskSensitiveFields(config));
  } catch (err) {
    error("[Config] Failed to read config:", err);
    res.status(500).json({ error: "Failed to read configuration" });
  }
});

/**
 * POST /api/config/validate-openai-key
 * Validate OpenAI API key
 */
router.post(
  "/validate-openai-key",
  requireAdmin,
  express.json(),
  async (req, res) => {
    try {
      const { apiKey } = req.body;

      if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
        res.json({ valid: true }); // Empty key is considered valid (for removal)
        return;
      }

      info("[OpenAI Validation] Testing API key...");

      // Test the API key by calling OpenAI's models endpoint
      const response = await fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      info("[OpenAI Validation] Response status:", response.status);
      info("[OpenAI Validation] Response ok:", response.ok);

      // If not ok, log the error details
      if (!response.ok) {
        const errorText = await response.text();
        error("[OpenAI Validation] Error response:", errorText);
      }

      res.json({ valid: response.ok });
    } catch (err) {
      error("[OpenAI Validation] Exception:", err);
      res.json({ valid: false });
    }
  }
);

/**
 * PUT /api/config
 * Update configuration
 */
router.put("/", requireAdmin, express.json(), async (req, res) => {
  try {
    const newConfig = req.body;

    // Validate that we have a valid config object
    if (!newConfig || typeof newConfig !== "object") {
      res.status(400).json({ error: "Invalid configuration data" });
      return;
    }

    // Read current config to preserve structure
    const currentConfigData = fs.readFileSync(CONFIG_PATH, "utf8");
    const currentConfig = JSON.parse(currentConfigData);

    // Merge new config with current (preserving any fields not sent)
    const updatedConfig = {
      ...currentConfig,
      ...newConfig,
    };

    // Do not wipe secrets when the client re-sends mask tokens from GET
    restoreSensitiveFields(updatedConfig, currentConfig);

    // Write updated config back to file
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(updatedConfig, null, 2),
      "utf8"
    );

    // Reload configuration cache so changes take effect immediately
    reloadConfig();

    // If log level was changed, log it BEFORE changing (so it's always visible)
    if (updatedConfig.environment?.logging?.level) {
      info(`[Config] Changing log level to: ${updatedConfig.environment.logging.level}`);
      initLogger(updatedConfig.environment.logging.level);
    }

    verbose("[Config] Configuration updated by:", req.user);

    // Detect which settings changed for specific notifications
    const smtpChanged = JSON.stringify(currentConfig.email) !== JSON.stringify(updatedConfig.email);
    const brandingChanged = JSON.stringify(currentConfig.branding) !== JSON.stringify(updatedConfig.branding);

    if (smtpChanged) {
      await notifyAllAdmins(
        'notifications.backend.smtpSettingsChangedTitle',
        'notifications.backend.smtpSettingsChangedBody',
        'smtp-settings-changed',
        'smtpSettingsChanged',
        {
          updatedBy: (req.user as any).name || (req.user as any).email
        }
      ).catch(err => error('[Config] Failed to send SMTP change notification:', err));
    }

    if (brandingChanged) {
      await notifyAllAdmins(
        'notifications.backend.brandingUpdatedTitle',
        'notifications.backend.brandingUpdatedBody',
        'branding-updated',
        'brandingUpdated',
        {
          updatedBy: (req.user as any).name || (req.user as any).email
        }
      ).catch(err => error('[Config] Failed to send branding change notification:', err));
    }

    // General config update notification if nothing specific matched
    if (!smtpChanged && !brandingChanged) {
      // Detect which specific settings changed
      const changedSettings: string[] = [];
      
      // Helper to format a value for display (hide sensitive data)
      const formatValue = (value: any, isSensitive: boolean): string => {
        if (value === undefined || value === null) return 'null';
        if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
        if (typeof value === 'number') return String(value);
        if (typeof value === 'string') {
          if (isSensitive) {
            // For sensitive values like API keys, show last 4 chars only
            return value.length > 4 ? `***${value.slice(-4)}` : '***';
          }
          // Truncate long strings
          return value.length > 50 ? `${value.slice(0, 47)}...` : value;
        }
        if (Array.isArray(value)) return `[${value.length} items]`;
        if (typeof value === 'object') return '[object]';
        return String(value);
      };
      
      // Helper function to find changed fields recursively
      const findChangedFields = (oldObj: any, newObj: any, prefix = ''): Array<{path: string, oldVal: any, newVal: any}> => {
        const changes: Array<{path: string, oldVal: any, newVal: any}> = [];
        const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
        
        for (const key of allKeys) {
          const oldVal = oldObj?.[key];
          const newVal = newObj?.[key];
          const path = prefix ? `${prefix}.${key}` : key;
          
          // Skip if both are undefined
          if (oldVal === undefined && newVal === undefined) continue;
          
          // If values are objects, recurse
          if (typeof oldVal === 'object' && typeof newVal === 'object' && oldVal !== null && newVal !== null && !Array.isArray(oldVal) && !Array.isArray(newVal)) {
            changes.push(...findChangedFields(oldVal, newVal, path));
          } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
            changes.push({ path, oldVal, newVal });
          }
        }
        
        return changes;
      };
      
      // Friendly names for config paths
      const friendlyNames: Record<string, string> = {
        'pushNotifications.vapidPublicKey': 'Push Notifications → Public Key',
        'pushNotifications.vapidPrivateKey': 'Push Notifications → Private Key',
        'openAI.apiKey': 'OpenAI → API Key',
        'openAI.model': 'OpenAI → Model',
        'environment.logging.level': 'Environment → Log Level',
        'environment.timezone': 'Environment → Timezone',
        'analytics.enabled': 'Analytics → Enabled',
        'analytics.trackVisitors': 'Analytics → Track Visitors',
        'analytics.trackDownloads': 'Analytics → Track Downloads',
        'imageOptimization.quality': 'Image Optimization → Quality',
        'imageOptimization.thumbnailSize': 'Image Optimization → Thumbnail Size',
        'imageOptimization.modalSize': 'Image Optimization → Modal Size',
        'imageOptimization.downloadSize': 'Image Optimization → Download Size',
        'videoOptimization.enabled': 'Video Optimization → Enabled',
        'videoOptimization.quality': 'Video Optimization → Quality',
      };
      
      // Sensitive fields that should be partially hidden
      const sensitiveFields = new Set([
        'pushNotifications.vapidPublicKey',
        'pushNotifications.vapidPrivateKey',
        'openAI.apiKey',
      ]);
      
      // Find all changed fields
      const allChangedFields = findChangedFields(currentConfig, updatedConfig);
      
      // Convert to friendly names with old/new values
      for (const change of allChangedFields) {
        const isSensitive = sensitiveFields.has(change.path);
        const oldDisplay = formatValue(change.oldVal, isSensitive);
        const newDisplay = formatValue(change.newVal, isSensitive);
        
        let fieldName: string;
        if (friendlyNames[change.path]) {
          fieldName = friendlyNames[change.path];
        } else {
          // Fallback: capitalize and format the path
          fieldName = change.path.split('.').map(part => 
            part.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())
          ).join(' → ');
        }
        
        changedSettings.push(`${fieldName}: ${oldDisplay} → ${newDisplay}`);
      }
      
      // Build descriptive message
      const settingsDescription = changedSettings.length > 0 
        ? changedSettings.join('; ')
        : 'system configuration';
      
      await notifyAllAdmins(
        'notifications.backend.configUpdatedTitle',
        'notifications.backend.configUpdatedBody',
        'config-updated',
        'configUpdated',
        {
          updatedBy: (req.user as any).name || (req.user as any).email,
          settings: settingsDescription
        }
      ).catch(err => error('[Config] Failed to send config update notification:', err));
    }

    res.json({
      success: true,
      message: "Configuration updated successfully",
    });
  } catch (err) {
    error("[Config] Failed to update config:", err);
    res.status(500).json({ error: "Failed to update configuration" });
  }
});

/**
 * POST /api/config/test-email
 * Send a test email to verify SMTP configuration
 */
router.post(
  "/test-email",
  requireAdmin,
  express.json(),
  async (req, res) => {
    try {
      const { email } = req.body;

      if (!email || typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "Valid email address is required" });
        return;
      }

      info(`[Test Email] Sending test email to ${email}...`);

      // Reload config from disk to get latest language setting
      const { reloadConfig, getCurrentConfig } = await import('../config.js');
      reloadConfig();
      const currentConfig = getCurrentConfig();
      const siteLanguage = (currentConfig as any).branding?.language || 'en';
      info(`[Test Email] Using site language: ${siteLanguage}`);

      const success = await sendTestEmail(email, siteLanguage);

      if (success) {
        res.json({
          success: true,
          message: `Test email sent successfully to ${email}`,
        });
      } else {
        res.status(500).json({
          error: "Failed to send test email. Please check your SMTP configuration.",
        });
      }
    } catch (err) {
      error("[Test Email] Error:", err);
      res.status(500).json({ error: "Failed to send test email" });
    }
  }
);

/**
 * GET /api/config/logs/stream
 * Stream logs via SSE (admin only) - combines frontend and backend logs (stdout + stderr)
 */
router.get(
  "/logs/stream",
  requireAdmin,
  (req, res) => {
    const backendOutPath = path.join(LOGS_DIR, 'backend-out-0.log');
    const backendErrPath = path.join(LOGS_DIR, 'backend-error-0.log');
    const frontendOutPath = path.join(LOGS_DIR, 'frontend-out.log');
    const frontendErrPath = path.join(LOGS_DIR, 'frontend-error.log');

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setTimeout(0);

    info(`[Log Stream] Client connected - streaming combined logs`);

    // Send initial logs (last 100 lines combined from all sources)
    const allLogs: Array<{ timestamp: Date; line: string }> = [];
    
    // Helper to read and parse logs
    const readLogs = (logPath: string, prefix: string) => {
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, 'utf-8');
        const lines = logContent.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}):/);
          const timestamp = timestampMatch ? new Date(timestampMatch[1]) : new Date(0);
          allLogs.push({ timestamp, line: `${prefix} ${line}` });
        });
      }
    };

    readLogs(backendOutPath, '[BE]');
    readLogs(backendErrPath, '[BE-ERR]');
    readLogs(frontendOutPath, '[FE]');
    readLogs(frontendErrPath, '[FE-ERR]');

    // Sort by timestamp and take last 100
    allLogs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const lastLines = allLogs.slice(-100).map(log => log.line);
    
    res.write(`data: ${JSON.stringify({ type: 'init', logs: lastLines })}\n\n`);

    // Track file sizes for all log files
    const fileSizes = {
      backendOut: fs.existsSync(backendOutPath) ? fs.statSync(backendOutPath).size : 0,
      backendErr: fs.existsSync(backendErrPath) ? fs.statSync(backendErrPath).size : 0,
      frontendOut: fs.existsSync(frontendOutPath) ? fs.statSync(frontendOutPath).size : 0,
      frontendErr: fs.existsSync(frontendErrPath) ? fs.statSync(frontendErrPath).size : 0,
    };

    // Helper to watch a log file
    const watchLogFile = (logPath: string, prefix: string, sizeKey: keyof typeof fileSizes) => {
      fs.watchFile(logPath, { interval: 500 }, (curr, prev) => {
        if (curr.size > fileSizes[sizeKey]) {
          const stream = fs.createReadStream(logPath, {
            start: fileSizes[sizeKey],
            end: curr.size,
            encoding: 'utf-8'
          });

          let buffer = '';
          stream.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            lines.forEach(line => {
              if (line.trim()) {
                res.write(`data: ${JSON.stringify({ type: 'log', line: `${prefix} ${line}` })}\n\n`);
              }
            });
          });

          stream.on('end', () => {
            fileSizes[sizeKey] = curr.size;
          });
        }
      });
    };

    // Watch all log files
    watchLogFile(backendOutPath, '[BE]', 'backendOut');
    watchLogFile(backendErrPath, '[BE-ERR]', 'backendErr');
    watchLogFile(frontendOutPath, '[FE]', 'frontendOut');
    watchLogFile(frontendErrPath, '[FE-ERR]', 'frontendErr');

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    // Cleanup on client disconnect
    req.on('close', () => {
      info(`[Log Stream] Client disconnected`);
      fs.unwatchFile(backendOutPath);
      fs.unwatchFile(backendErrPath);
      fs.unwatchFile(frontendOutPath);
      fs.unwatchFile(frontendErrPath);
      clearInterval(heartbeat);
      res.end();
    });
  }
);

export default router;
