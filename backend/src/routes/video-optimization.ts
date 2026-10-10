/**
 * Video optimization routes for regenerating video playlists and settings.
 */

import express from "express";
import { spawn } from "child_process";
import { csrfProtection } from "../security.js";
import path from "path";
import { fileURLToPath } from "url";
import { error, warn, info } from '../utils/logger.js';
import { requireManager } from '../auth/middleware.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';

const router = express.Router();

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Track running optimization job
interface RunningJob {
  process: any;
  output: string[];
  clients: Set<any>;
  startTime: number;
  isComplete: boolean;
  videoCount?: { generated: number; skipped: number; errors: number };
}

let runningVideoOptimizationJob: RunningJob | null = null;

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

/**
 * POST /api/video-optimization/regenerate
 * Regenerate video master playlists with current configuration
 * Streams progress via SSE
 */
router.post('/regenerate', requireManager, (req, res) => {
  // Set up SSE headers FIRST
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable nginx buffering
  });
  res.setTimeout(0); // Disable timeout for long-running operation

  // Check if a job is already running
  if (runningVideoOptimizationJob && !runningVideoOptimizationJob.isComplete) {
    info('[VideoOptimization] Client connecting to existing job');
    
    // Send existing output history to new client
    runningVideoOptimizationJob.output.forEach(line => {
      res.write(`data: ${line}\n\n`);
    });
    
    // Add this client to the set
    runningVideoOptimizationJob.clients.add(res);
    
    // Remove client when they disconnect
    req.on('close', () => {
      if (runningVideoOptimizationJob) {
        runningVideoOptimizationJob.clients.delete(res);
        info(`[VideoOptimization] Client disconnected, ${runningVideoOptimizationJob.clients.size} remaining`);
      }
    });
    
    return;
  }

  // Create new job tracking object IMMEDIATELY
  runningVideoOptimizationJob = {
    process: null,
    output: [],
    clients: new Set([res]),
    startTime: Date.now(),
    isComplete: false,
    videoCount: { generated: 0, skipped: 0, errors: 0 }
  };

  info('[VideoOptimization] Starting video playlist regeneration');

  const scriptPath = path.resolve(__dirname, '../../../scripts/generate-master-playlists.js');
  
  // Spawn the script
  const child = spawn('node', [scriptPath], {
    cwd: path.resolve(__dirname, '../../../'),
    env: { ...process.env, TERM: 'dumb' } // Disable terminal colors/animations
  });
  
  runningVideoOptimizationJob.process = child;
  
  // Remove client when they disconnect
  req.on('close', () => {
    if (runningVideoOptimizationJob) {
      runningVideoOptimizationJob.clients.delete(res);
      info(`[VideoOptimization] Client disconnected, ${runningVideoOptimizationJob.clients.size} remaining`);
    }
  });

  // Capture stdout
  child.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const output = JSON.stringify({ type: 'stdout', message: line });
        info(`[VideoOptimization] ${line}`);
        
        // Parse video counts from script output
        if (runningVideoOptimizationJob?.videoCount) {
          const generatedMatch = line.match(/✅ Generated: (\d+)/);
          const skippedMatch = line.match(/⏭️  Skipped: (\d+)/);
          const errorsMatch = line.match(/❌ Errors: (\d+)/);
          
          if (generatedMatch) runningVideoOptimizationJob.videoCount.generated = parseInt(generatedMatch[1], 10);
          if (skippedMatch) runningVideoOptimizationJob.videoCount.skipped = parseInt(skippedMatch[1], 10);
          if (errorsMatch) runningVideoOptimizationJob.videoCount.errors = parseInt(errorsMatch[1], 10);
        }
        
        // Store output and broadcast to all clients
        if (runningVideoOptimizationJob) {
          runningVideoOptimizationJob.output.push(output);
          broadcastToClients(runningVideoOptimizationJob, output);
        }
      }
    });
  });

  // Capture stderr
  child.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const errorOutput = JSON.stringify({ type: 'stderr', message: line });
        warn(`[VideoOptimization] ${line}`);
        
        // Store output and broadcast to all clients
        if (runningVideoOptimizationJob) {
          runningVideoOptimizationJob.output.push(errorOutput);
          broadcastToClients(runningVideoOptimizationJob, errorOutput);
        }
      }
    });
  });

  // Handle process completion
  child.on('close', async (code: number) => {
    const duration = Date.now() - (runningVideoOptimizationJob?.startTime || Date.now());
    const totalSeconds = Math.floor(duration / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const timeStr = minutes > 0 
      ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`
      : `${seconds} second${seconds !== 1 ? 's' : ''}`;
    
    const counts = runningVideoOptimizationJob?.videoCount;
    const videoCountStr = counts 
      ? ` • ${counts.generated} processed${counts.skipped > 0 ? `, ${counts.skipped} skipped` : ''}${counts.errors > 0 ? `, ${counts.errors} failed` : ''}`
      : '';
    
    const message = code === 0 
      ? `✓ Video playlist regeneration complete (${timeStr})${videoCountStr}`
      : `✗ Video playlist regeneration failed with code ${code}`;
    
    const notificationBody = code === 0
      ? `Completed in ${timeStr}${videoCountStr}`
      : `Failed with code ${code}`;
    
    info(`[VideoOptimization] ${message}`);
    
    if (runningVideoOptimizationJob) {
      const completeOutput = JSON.stringify({
        type: 'complete',
        exitCode: code,
        message
      });
      runningVideoOptimizationJob.output.push(completeOutput);
      broadcastToClients(runningVideoOptimizationJob, completeOutput);
      runningVideoOptimizationJob.isComplete = true;
      
      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const titleKey = code === 0 ? 'notifications.backend.videoProcessingComplete' : 'notifications.backend.videoProcessingFailed';
        const bodyKey = code === 0 ? 'notifications.backend.videoProcessingCompleteBody' : 'notifications.backend.videoProcessingFailedBody';
        
        const variables = code === 0 
          ? { videoName: (runningVideoOptimizationJob as any).filename || 'Unknown', albumName: (runningVideoOptimizationJob as any).album || 'Unknown' }
          : { videoName: (runningVideoOptimizationJob as any).filename || 'Unknown', error: (runningVideoOptimizationJob as any).error || `Exit code ${code}` };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'video-optimization',
          requireInteraction: false
        }).catch(err => {
          warn('[VideoOptimization] Failed to send push notification:', err);
        });
      }
      
      // Clean up after 5 minutes — only clear if no newer job replaced us
      const jobRef = runningVideoOptimizationJob;
      setTimeout(() => {
        if (runningVideoOptimizationJob === jobRef) {
          info('[VideoOptimization] Cleaning up completed job');
          runningVideoOptimizationJob = null;
        }
      }, 5 * 60 * 1000);
    }
  });

  child.on('error', (err: Error) => {
    error('[VideoOptimization] Failed to start script:', err);
    const message = `✗ Failed to start video playlist regeneration: ${err.message}`;
    
    if (runningVideoOptimizationJob) {
      const errorOutput = JSON.stringify({
        type: 'error',
        message
      });
      runningVideoOptimizationJob.output.push(errorOutput);
      broadcastToClients(runningVideoOptimizationJob, errorOutput);
      runningVideoOptimizationJob.isComplete = true;
    }
  });
});

/**
 * POST /api/video-optimization/reprocess
 * Re-encode all videos with current quality settings
 * Streams progress via SSE
 */
router.post('/reprocess', requireManager, (req, res) => {
  // Set up SSE headers FIRST
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable nginx buffering
  });
  res.setTimeout(0); // Disable timeout for long-running operation

  // Check if a job is already running
  if (runningVideoOptimizationJob && !runningVideoOptimizationJob.isComplete) {
    info('[VideoReprocessing] Client connecting to existing job');
    
    // Send existing output history to new client
    runningVideoOptimizationJob.output.forEach(line => {
      res.write(`data: ${line}\n\n`);
    });
    
    // Add this client to the set
    runningVideoOptimizationJob.clients.add(res);
    
    // Remove client when they disconnect
    req.on('close', () => {
      if (runningVideoOptimizationJob) {
        runningVideoOptimizationJob.clients.delete(res);
        info(`[VideoReprocessing] Client disconnected, ${runningVideoOptimizationJob.clients.size} remaining`);
      }
    });
    
    return;
  }

  // Create new job tracking object IMMEDIATELY
  runningVideoOptimizationJob = {
    process: null,
    output: [],
    clients: new Set([res]),
    startTime: Date.now(),
    isComplete: false
  };

  info('[VideoReprocessing] Starting video reprocessing with current settings');

  const projectRoot = path.resolve(__dirname, '../../../');
  const scriptPath = path.join(projectRoot, 'scripts/reprocess_all_videos.js');
  const tsNodeLoader = path.join(projectRoot, 'node_modules/ts-node/esm.mjs');
  
  // Spawn the script with ts-node loader to handle TypeScript imports
  const child = spawn('node', ['--no-warnings', '--loader', tsNodeLoader, scriptPath], {
    cwd: projectRoot,
    env: { ...process.env, TERM: 'dumb', TS_NODE_PROJECT: path.join(projectRoot, 'backend/tsconfig.json') }
  });
  
  runningVideoOptimizationJob.process = child;
  
  // Remove client when they disconnect
  req.on('close', () => {
    if (runningVideoOptimizationJob) {
      runningVideoOptimizationJob.clients.delete(res);
      info(`[VideoReprocessing] Client disconnected, ${runningVideoOptimizationJob.clients.size} remaining`);
    }
  });

  // Capture stdout
  child.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const output = JSON.stringify({ type: 'stdout', message: line });
        info(`[VideoReprocessing] ${line}`);
        
        // Store output and broadcast to all clients
        if (runningVideoOptimizationJob) {
          runningVideoOptimizationJob.output.push(output);
          broadcastToClients(runningVideoOptimizationJob, output);
        }
      }
    });
  });

  // Capture stderr
  child.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const errorOutput = JSON.stringify({ type: 'stderr', message: line });
        warn(`[VideoReprocessing] ${line}`);
        
        // Store output and broadcast to all clients
        if (runningVideoOptimizationJob) {
          runningVideoOptimizationJob.output.push(errorOutput);
          broadcastToClients(runningVideoOptimizationJob, errorOutput);
        }
      }
    });
  });

  // Handle process completion
  child.on('close', async (code: number) => {
    const duration = Date.now() - (runningVideoOptimizationJob?.startTime || Date.now());
    const totalSeconds = Math.floor(duration / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const timeStr = minutes > 0 
      ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`
      : `${seconds} second${seconds !== 1 ? 's' : ''}`;
    
    const message = code === 0 
      ? `✓ Video reprocessing complete (${timeStr})`
      : `✗ Video reprocessing failed with code ${code}`;
    
    const notificationBody = code === 0
      ? `Completed in ${timeStr}`
      : `Failed with code ${code}`;
    
    info(`[VideoReprocessing] ${message}`);
    
    if (runningVideoOptimizationJob) {
      const completeOutput = JSON.stringify({
        type: 'complete',
        exitCode: code,
        message
      });
      runningVideoOptimizationJob.output.push(completeOutput);
      broadcastToClients(runningVideoOptimizationJob, completeOutput);
      runningVideoOptimizationJob.isComplete = true;
      
      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const titleKey = code === 0 ? 'notifications.backend.videoReprocessingComplete' : 'notifications.backend.videoReprocessingFailed';
        const bodyKey = code === 0 ? 'notifications.backend.videoReprocessingCompleteBody' : 'notifications.backend.videoReprocessingFailedBody';
        
        const variables = code === 0 
          ? { videoName: (runningVideoOptimizationJob as any).filename || 'Unknown', albumName: (runningVideoOptimizationJob as any).album || 'Unknown' }
          : { videoName: (runningVideoOptimizationJob as any).filename || 'Unknown', error: (runningVideoOptimizationJob as any).error || `Exit code ${code}` };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'video-reprocessing',
          requireInteraction: false
        }).catch(err => {
          warn('[VideoReprocessing] Failed to send push notification:', err);
        });
      }
      
      // Clean up after 5 minutes — only clear if no newer job replaced us
      const jobRef = runningVideoOptimizationJob;
      setTimeout(() => {
        if (runningVideoOptimizationJob === jobRef) {
          info('[VideoReprocessing] Cleaning up completed job');
          runningVideoOptimizationJob = null;
        }
      }, 5 * 60 * 1000);
    }
  });

  child.on('error', (err: Error) => {
    error('[VideoReprocessing] Failed to start script:', err);
    const errorMessage = err?.message || err?.toString() || 'Unknown error';
    const message = `✗ Failed to start video reprocessing: ${errorMessage}`;
    
    if (runningVideoOptimizationJob) {
      const errorOutput = JSON.stringify({
        type: 'error',
        message
      });
      runningVideoOptimizationJob.output.push(errorOutput);
      broadcastToClients(runningVideoOptimizationJob, errorOutput);
      runningVideoOptimizationJob.isComplete = true;
    }
  });
});

/**
 * POST /api/video-optimization/stop
 * Stop the running video optimization job
 */
router.post('/stop', requireManager, (req, res) => {
  if (!runningVideoOptimizationJob || runningVideoOptimizationJob.isComplete) {
    res.json({ success: false, message: 'No video optimization job running' });
    return;
  }

  try {
    runningVideoOptimizationJob.process.kill('SIGTERM');
    
    const message = '⏹ Video reprocessing stopped by user';
    runningVideoOptimizationJob.output.push(message);
    broadcastToClients(runningVideoOptimizationJob, message);
    runningVideoOptimizationJob.isComplete = true;
    
    info('[VideoOptimization] Job stopped by user');
    res.json({ success: true, message: 'Video optimization stopped' });
  } catch (err) {
    error('[VideoOptimization] Failed to stop job:', err);
    res.status(500).json({ success: false, message: 'Failed to stop video optimization' });
  }
});

/**
 * POST /api/video-optimization/test-gpu
 * Test NVIDIA GPU hardware acceleration support
 * Streams diagnostic output via SSE
 */
router.post('/test-gpu', requireManager, (req, res) => {
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.setTimeout(0);

  info('[GPU Test] Starting NVIDIA GPU diagnostic test');

  const scriptPath = path.resolve(__dirname, '../../../scripts/test-nvidia-hardware.sh');
  
  // Spawn the diagnostic script
  const child = spawn('/bin/bash', [scriptPath], {
    cwd: path.resolve(__dirname, '../../../'),
    env: { ...process.env }
  });

  // Capture stdout
  child.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const output = JSON.stringify({ type: 'stdout', message: line });
        info(`[GPU Test] ${line}`);
        res.write(`data: ${output}\n\n`);
      }
    });
  });

  // Capture stderr
  child.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    lines.forEach((line: string) => {
      if (line.trim()) {
        const output = JSON.stringify({ type: 'stderr', message: line });
        warn(`[GPU Test] ${line}`);
        res.write(`data: ${output}\n\n`);
      }
    });
  });

  // Handle completion
  child.on('close', (code: number | null) => {
    const exitCode = code || 0;
    const completeMessage = JSON.stringify({
      type: 'complete',
      exitCode,
      message: exitCode === 0 
        ? '✓ GPU diagnostic test completed' 
        : '✗ GPU diagnostic test completed with errors'
    });
    
    info(`[GPU Test] Diagnostic completed with exit code: ${exitCode}`);
    res.write(`data: ${completeMessage}\n\n`);
    res.end();
  });

  // Handle errors
  child.on('error', (err: Error) => {
    error('[GPU Test] Failed to start diagnostic script:', err);
    const errorOutput = JSON.stringify({
      type: 'error',
      message: `Failed to start GPU test: ${err.message}`
    });
    res.write(`data: ${errorOutput}\n\n`);
    res.end();
  });

  // Clean up when client disconnects
  req.on('close', () => {
    info('[GPU Test] Client disconnected, cleaning up');
    try {
      child.kill('SIGTERM');
    } catch (err) {
      // Ignore cleanup errors
    }
  });
});

export default router;

