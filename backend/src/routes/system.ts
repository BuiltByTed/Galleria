/**
 * Route handler for system operations.
 * This file provides endpoints for system management like restart.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../auth/middleware.js';
import { csrfProtection } from '../security.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Restart endpoint - admin only (system settings); CSRF like other mutating routes
router.post('/restart', csrfProtection, requireAdmin, (req, res) => {
  try {
    // Get user info for logging
    const userId = (req.session as any)?.userId;
    const sessionUser = (req.session as any)?.user;
    const userEmail = sessionUser?.email || (req.user as any)?.email || 'unknown user';
    
    info('Server restart initiated by:', userEmail);
    info('[Restart] Session info:', {
      userId,
      hasSessionUser: !!sessionUser,
      sessionId: req.sessionID,
    });

    // Send response immediately before restarting
    res.json({ success: true, message: 'Server restart initiated' });

    // Small delay to ensure response is sent, then restart
    setTimeout(() => {
      const projectRoot = path.resolve(__dirname, '../../..');
      const logDir = path.join(projectRoot, 'data/logs');
      const logFile = path.join(logDir, 'restart.log');
      
      // Ensure logs directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      const timestamp = new Date().toISOString();
      
      // Check if PM2 is available (works in both Docker and non-Docker)
      const pm2Available = require('child_process').spawnSync('which', ['pm2']).status === 0;
      
      if (pm2Available) {
        // PM2 mode: Restart PM2 processes (works in Docker and non-Docker)
        logStream.write(`\n\n=== PM2 Restart initiated at ${timestamp} ===\n`);
        logStream.write(`User: ${userEmail}\n`);
        logStream.write(`Reason: Config reload\n\n`);

        const restart = spawn('pm2', ['restart', 'all'], {
          cwd: projectRoot,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Pipe output to log file
        if (restart.stdout) {
          restart.stdout.pipe(logStream, { end: false });
        }
        if (restart.stderr) {
          restart.stderr.pipe(logStream, { end: false });
        }

        // Handle process events for logging
        restart.on('error', (err) => {
          logStream.write(`\nERROR: Failed to restart PM2: ${err.message}\n`);
          logStream.end();
          error('Failed to restart PM2:', err);
        });

        restart.on('exit', (code, signal) => {
          logStream.write(`\nPM2 restart completed with code ${code} and signal ${signal}\n`);
          logStream.end();
        });

        // Unref the child process so it continues running independently
        restart.unref();

        info('✅ PM2 restart initiated');
        info('⏳ Services will reload configuration and restart');
        info(`📝 Restart output logged to: ${logFile}`);
      } else {
        // Fallback: Exit process (Docker will restart container, PM2 will restart process)
        logStream.write(`\n\n=== Process Restart initiated at ${timestamp} ===\n`);
        logStream.write(`User: ${userEmail}\n`);
        logStream.write(`Reason: Config reload\n\n`);
        logStream.end();
        
        info('✅ Process restart - exiting');
        info('⏳ Process manager will restart the process');
        info(`📝 Restart logged to: ${logFile}`);
        
        // Exit gracefully - PM2/Docker will restart
        process.exit(0);
      }
    }, 500);
  } catch (err) {
    error('Failed to initiate restart:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate restart' 
    });
  }
});

export default router;
