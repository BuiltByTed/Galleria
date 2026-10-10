/**
 * Image optimization routes for managing optimization settings and running optimization scripts.
 */

import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { csrfProtection } from "../security.js";
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const router = express.Router();

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

// Track running optimization job
interface RunningJob {
  process: any;
  output: string[];
  clients: Set<any>;
  startTime: number;
  isComplete: boolean;
}

let runningOptimizationJob: RunningJob | null = null;

// Broadcast message to all connected clients
function broadcastToClients(job: RunningJob | null, message: string) {
  if (!job) return;
  
  job.clients.forEach(client => {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (err) {
      // Client disconnected, will be cleaned up
    }
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { DATA_DIR, reloadConfig } from '../config.js';
import { requireAuth, requireAdmin, requireManager } from '../auth/middleware.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { broadcastOptimizationUpdate, queueOptimizationJob } from './optimization-stream.js';

// Path to config.json
const configPath = path.join(DATA_DIR, 'config.json');

function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\');
}

// GET /api/image-optimization/settings - Get current optimization settings
router.get('/settings', requireAuth, (req, res) => {
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    const settings = {
      concurrency: config.environment?.optimization?.concurrency || 4,
      images: config.environment?.optimization?.images || {
        thumbnail: { quality: 60, maxDimension: 512 },
        modal: { quality: 90, maxDimension: 2048 },
        download: { quality: 100, maxDimension: 4096 }
      }
    };
    
    res.json(settings);
  } catch (err) {
    error('[ImageOptimization] Failed to read optimization settings:', err);
    res.status(500).json({ error: 'Failed to read optimization settings' });
  }
});

// PUT /api/image-optimization/settings - Update optimization settings
router.put('/settings', requireAdmin, (req, res) => {
  try {
    const { concurrency, images } = req.body;
    
    // Validate input - accept either nested (images.thumbnail) or flat (thumbnail) format
    const thumbnail = images?.thumbnail || req.body.thumbnail;
    const modal = images?.modal || req.body.modal;
    const download = images?.download || req.body.download;
    
    if (!thumbnail || !modal || !download) {
      res.status(400).json({ error: 'Missing required settings' });
      return;
    }
    
    // Read current config
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Ensure the optimization path exists
    if (!config.environment.optimization) {
      config.environment.optimization = {};
    }
    
    // Update concurrency
    if (concurrency !== undefined) {
      config.environment.optimization.concurrency = Math.max(1, Math.min(16, parseInt(concurrency) || 4));
    }
    
    // Update image settings
    config.environment.optimization.images = {
      thumbnail: {
        quality: Math.max(0, Math.min(100, parseInt(thumbnail.quality) || 60)),
        maxDimension: Math.max(128, Math.min(4096, parseInt(thumbnail.maxDimension) || 512))
      },
      modal: {
        quality: Math.max(0, Math.min(100, parseInt(modal.quality) || 90)),
        maxDimension: Math.max(512, Math.min(8192, parseInt(modal.maxDimension) || 2048))
      },
      download: {
        quality: Math.max(0, Math.min(100, parseInt(download.quality) || 100)),
        maxDimension: Math.max(1024, Math.min(16384, parseInt(download.maxDimension) || 4096))
      }
    };
    
    // Write back to config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Reload config cache in memory
    reloadConfig();
    info("[ImageOptimization] Config reloaded after optimization settings update");
    
    res.json({ success: true, settings: config.environment.optimization });
  } catch (err) {
    error('[ImageOptimization] Failed to update optimization settings:', err);
    res.status(500).json({ error: 'Failed to update optimization settings' });
  }
});

// GET /api/image-optimization/status - Check if optimization is running
router.get('/status', requireAuth, (req, res) => {
  if (runningOptimizationJob) {
    res.json({ 
      running: true, 
      output: runningOptimizationJob.output,
      isComplete: runningOptimizationJob.isComplete
    });
  } else {
    res.json({ running: false });
  }
});

// POST /api/image-optimization/retry-photo - Retry optimization for one photo
router.post('/retry-photo', requireManager, (req, res) => {
  const { album, filename } = req.body;

  if (!isSafePathSegment(album) || !isSafePathSegment(filename)) {
    res.status(400).json({ error: 'Valid album and filename are required' });
    return;
  }

  const sourcePath = path.join(DATA_DIR, 'photos', album, filename);
  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: 'Photo not found' });
    return;
  }

  const projectRoot = path.resolve(__dirname, '../../../');
  const scriptPath = path.join(projectRoot, 'scripts', 'optimize_new_image.js');
  if (!fs.existsSync(scriptPath)) {
    res.status(500).json({ error: 'Optimization script not found' });
    return;
  }

  const jobId = `${album}/${filename}`;
  queueOptimizationJob(
    jobId,
    album,
    filename,
    scriptPath,
    projectRoot,
    (progress) => {
      broadcastOptimizationUpdate(jobId, {
        album,
        filename,
        progress,
        state: 'optimizing'
      });
    },
    () => {
      broadcastOptimizationUpdate(jobId, {
        album,
        filename,
        progress: 100,
        state: 'complete'
      });
    },
    (optimizationError) => {
      broadcastOptimizationUpdate(jobId, {
        album,
        filename,
        progress: 0,
        state: 'error',
        error: optimizationError
      });
    }
  );

  info(`[ImageOptimization] Queued photo retry for ${jobId}`);
  res.status(202).json({ success: true, message: 'Photo optimization queued' });
});

// POST /api/image-optimization/stop - Stop running optimization job
router.post('/stop', requireManager, (req: any, res: any) => {
  if (!runningOptimizationJob || runningOptimizationJob.isComplete) {
    return res.json({ success: false, message: 'No running job to stop' });
  }
  
  try {
    // Kill the process
    if (runningOptimizationJob.process) {
      runningOptimizationJob.process.kill('SIGTERM');
      info('[Optimization] Job stopped by user');
    }
    
    // Mark as complete and broadcast to all clients
    const stopMsg = JSON.stringify({ type: 'error', message: 'Job stopped by user' });
    runningOptimizationJob.output.push(stopMsg);
    runningOptimizationJob.isComplete = true;
    broadcastToClients(runningOptimizationJob, stopMsg);
    
    // Close all client connections
    runningOptimizationJob.clients.forEach(client => {
      try {
        client.end();
      } catch (err) {
        // Ignore errors
      }
    });
    runningOptimizationJob.clients.clear();
    
    res.json({ success: true, message: 'Job stopped successfully' });
  } catch (err: any) {
    error('[Optimization] Error stopping job:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/image-optimization/optimize - Run optimization script with SSE
router.post('/optimize', requireManager, (req, res) => {
  const { force } = req.body;
  
  // If already running, reconnect to existing job
  if (runningOptimizationJob && !runningOptimizationJob.isComplete) {
    info('[Optimization] Reconnecting to existing job');
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering
    res.setTimeout(0); // Disable timeout for this response
    res.flushHeaders();
    
    // Send all previous output
    runningOptimizationJob.output.forEach(line => {
      res.write(`data: ${line}\n\n`);
    });
    
    // Add this client to the broadcast list
    runningOptimizationJob.clients.add(res);
    
    // Remove client when they disconnect
    req.on('close', () => {
      if (runningOptimizationJob) {
        runningOptimizationJob.clients.delete(res);
      }
    });
    
    return;
  }
  
  // Create job tracking IMMEDIATELY to prevent race condition
  runningOptimizationJob = {
    process: null,
    output: [],
    clients: new Set([res]),
    startTime: Date.now(),
    isComplete: false
  };
  
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering
  res.setTimeout(0); // Disable timeout for this response
  res.flushHeaders();
  
  // Send initial connection message
  const connectMsg = '{"type":"connected","message":"Connected to optimization stream"}';
  res.write(`data: ${connectMsg}\n\n`);
  runningOptimizationJob.output.push(connectMsg);
  
  // Build command
  const scriptPath = path.resolve(__dirname, '../../../scripts/optimize_all_images.js');
  const args = force ? ['--force'] : [];
  
  // Check if script exists
  if (!fs.existsSync(scriptPath)) {
    res.write(`data: {"type":"error","message":"Optimization script not found"}\n\n`);
    res.end();
    return;
  }
  
  // Spawn the optimization script
  const child = spawn('node', [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '../../../'),
    env: { ...process.env, TERM: 'dumb' } // Disable terminal colors/animations
  });
  
  runningOptimizationJob.process = child;
  
  // Remove client when they disconnect
  req.on('close', () => {
    if (runningOptimizationJob) {
      runningOptimizationJob.clients.delete(res);
    }
  });
  
  // Stream stdout
  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        let output = '';
        
        // Parse progress from lines like: [150/3000] (5%) Album/image.jpg [type]
        const progressMatch = line.match(/^\[(\d+)\/(\d+)\]\s*\((\d+)%\)/);
        if (progressMatch) {
          const [, current, total, percent] = progressMatch;
          output = JSON.stringify({ 
            type: 'progress', 
            current: parseInt(current),
            total: parseInt(total),
            percent: parseInt(percent),
            message: line 
          });
          // Log progress to file (verbose level)
          verbose(`[Optimization] ${line}`);
        } else {
          output = JSON.stringify({ type: 'stdout', message: line });
          // Log stdout to file (info level)
          info(`[Optimization] ${line}`);
        }
        
        // Store output and broadcast to all clients
        if (runningOptimizationJob) {
          runningOptimizationJob.output.push(output);
          broadcastToClients(runningOptimizationJob, output);
        }
      }
    });
  });
  
  // Stream stderr
  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const errorOutput = JSON.stringify({ type: 'stderr', message: line });
        
        // Log stderr to file (warn level)
        warn(`[Optimization] ${line}`);
        
        // Store output and broadcast to all clients
        if (runningOptimizationJob) {
          runningOptimizationJob.output.push(errorOutput);
          broadcastToClients(runningOptimizationJob, errorOutput);
        }
      }
    });
  });
  
  // Handle process completion
  child.on('close', async (code) => {
    info(`[Optimization] Process completed with exit code ${code}`);
    
    const completeMsg = JSON.stringify({ 
      type: 'complete', 
      message: `Process exited with code ${code}`,
      exitCode: code 
    });
    
    if (runningOptimizationJob) {
      runningOptimizationJob.output.push(completeMsg);
      runningOptimizationJob.isComplete = true;
      
      // Broadcast to all clients and close connections
      broadcastToClients(runningOptimizationJob, completeMsg);
      runningOptimizationJob.clients.forEach(client => {
        try {
          client.end();
        } catch (err) {
          // Ignore errors
        }
      });
      runningOptimizationJob.clients.clear();
      
      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const duration = Date.now() - runningOptimizationJob.startTime;
        const durationMin = (duration / 1000 / 60).toFixed(1);
        
        const titleKey = code === 0 ? 'notifications.backend.imageOptimizationComplete' : 'notifications.backend.imageOptimizationFailed';
        const bodyKey = code === 0 ? 'notifications.backend.imageOptimizationCompleteBody' : 'notifications.backend.imageOptimizationFailedBody';
        
        const variables = code === 0 
          ? { imagesOptimized: (runningOptimizationJob as any).totalImages || 0 }
          : { error: (runningOptimizationJob as any).error || `Exit code ${code}` };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'image-optimization',
          requireInteraction: false
        }).catch(err => {
          warn('[Optimization] Failed to send push notification:', err);
        });
      }
      
      // Clean up after 5 minutes
      setTimeout(() => {
        runningOptimizationJob = null;
      }, 5 * 60 * 1000);
    }
  });
  
  // Handle errors
  child.on('error', (err) => {
    error(`[Optimization] Failed to start process:`, err);
    
    const errorMsg = JSON.stringify({ 
      type: 'error', 
      message: `Failed to start process: ${err.message}` 
    });
    
    if (runningOptimizationJob) {
      runningOptimizationJob.output.push(errorMsg);
      runningOptimizationJob.isComplete = true;
      
      // Broadcast to all clients and close connections
      broadcastToClients(runningOptimizationJob, errorMsg);
      runningOptimizationJob.clients.forEach(client => {
        try {
          client.end();
        } catch (err) {
          // Ignore errors
        }
      });
      runningOptimizationJob.clients.clear();
    }
  });
});

export default router;
