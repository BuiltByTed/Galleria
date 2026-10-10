/**
 * Optimization Stream Route
 * Provides a single SSE endpoint for tracking all photo optimizations
 */

import express from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { requireAuth } from '../auth/middleware.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const router = express.Router();

// Track ongoing optimization jobs
interface OptimizationJob {
  album: string;
  filename: string;
  progress: number;
  state: 'queued' | 'optimizing' | 'generating-title' | 'complete' | 'error' | 'rotation' | '240p' | '360p' | '720p' | '1080p' | 'thumbnail' | 'modal-preview';
  error?: string;
  title?: string;
  message?: string;
  startTime: number;
}

// Map of jobId -> OptimizationJob
const optimizationJobs = new Map<string, OptimizationJob>();

// Set of all connected SSE clients
const clients = new Set<express.Response>();

// Job queue for sequential optimization
interface QueuedJob {
  jobId: string;
  album: string;
  filename: string;
  scriptPath: string;
  projectRoot: string;
  onProgress: (progress: number) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

const optimizationQueue: QueuedJob[] = [];
const activeJobs: Set<ChildProcess> = new Set();
const MAX_CONCURRENT_JOBS = 4; // Reduced from 8 to prevent memory exhaustion

/**
 * Broadcast update to all connected clients
 */
export function broadcastOptimizationUpdate(jobId: string, update: Partial<OptimizationJob>) {
  const job = optimizationJobs.get(jobId);
  if (job) {
    Object.assign(job, update);
  } else {
    // Create new job if it doesn't exist
    optimizationJobs.set(jobId, {
      album: update.album!,
      filename: update.filename!,
      progress: update.progress || 0,
      state: update.state || 'optimizing',
      startTime: Date.now(),
      ...update
    });
  }
  
  // Broadcast to all clients
  const message = JSON.stringify({
    type: 'optimization-update',
    jobId,
    ...optimizationJobs.get(jobId)
  });
  
  clients.forEach(client => {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (err) {
      // Client disconnected, will be cleaned up
    }
  });
}

/**
 * Process the optimization queue (up to MAX_CONCURRENT_JOBS at a time)
 */
async function processQueue() {
  // Process jobs while we have space and jobs in queue
  while (activeJobs.size < MAX_CONCURRENT_JOBS && optimizationQueue.length > 0) {
    const job = optimizationQueue.shift()!;

    // info(`[OptimizationStream] Starting ${job.jobId} (${activeJobs.size + 1}/${MAX_CONCURRENT_JOBS} active, ${optimizationQueue.length} queued)`);

    // Update job state to optimizing
    broadcastOptimizationUpdate(job.jobId, {
      album: job.album,
      filename: job.filename,
      progress: 0,
      state: 'optimizing'
    });

    // Spawn optimization process with DATA_DIR environment variable
    const childProcess = spawn('node', [job.scriptPath, job.album, job.filename], {
      cwd: job.projectRoot,
      env: {
        ...process.env,
        DATA_DIR: process.env.DATA_DIR || path.join(job.projectRoot, 'data')
      }
    });

    activeJobs.add(childProcess);

    // Only one terminal path may call onError/onComplete + processQueue.
    // Timeout kill still emits `close`; without this flag both paths double-fire.
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finishJob = (handler: () => void) => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      activeJobs.delete(childProcess);
      handler();
      processQueue();
    };

    // Add timeout to prevent hung processes (5 minutes)
    timeout = setTimeout(() => {
      error(`[OptimizationStream] Job ${job.jobId} timed out after 5 minutes, killing process`);
      // Kill first so the process begins exiting; finishJob guards the subsequent close.
      childProcess.kill('SIGTERM');
      finishJob(() => {
        job.onError('Optimization timed out');
      });
    }, 5 * 60 * 1000);

    // Handle stdout for progress updates
    childProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line: string) => {
        if (line.trim() && line.startsWith('PROGRESS:')) {
          const parts = line.substring(9).split(':');
          const progress = parseInt(parts[0]);
          job.onProgress(progress);
        }
      });
    });

    // Handle stderr
    childProcess.stderr?.on('data', (data) => {
      const errorOutput = data.toString().trim();
      if (errorOutput) {
        error(`[${job.album}/${job.filename}] Optimization stderr:`, errorOutput);
      }
    });

    // Handle completion
    childProcess.on('close', (code) => {
      finishJob(() => {
        if (code === 0) {
          job.onComplete();
          // info(`[OptimizationStream] Completed ${job.jobId} (${activeJobs.size}/${MAX_CONCURRENT_JOBS} active, ${optimizationQueue.length} queued)`);
        } else {
          job.onError(`Optimization failed with code ${code}`);
          error(`[OptimizationStream] Failed ${job.jobId} with code ${code} (${activeJobs.size}/${MAX_CONCURRENT_JOBS} active, ${optimizationQueue.length} queued)`);
        }
      });
    });

    // Handle errors
    childProcess.on('error', (err) => {
      finishJob(() => {
        error(`[OptimizationStream] Error in job ${job.jobId}:`, err);
        job.onError(err.message);
      });
    });
  }
}

/**
 * Add optimization job to queue
 */
export function queueOptimizationJob(
  jobId: string,
  album: string,
  filename: string,
  scriptPath: string,
  projectRoot: string,
  onProgress: (progress: number) => void,
  onComplete: () => void,
  onError: (error: string) => void
) {
  // Add to queue
  optimizationQueue.push({
    jobId,
    album,
    filename,
    scriptPath,
    projectRoot,
    onProgress,
    onComplete,
    onError
  });

  // Set initial state as queued
  broadcastOptimizationUpdate(jobId, {
    album,
    filename,
    progress: 0,
    state: 'queued'
  });

  // info(`[OptimizationStream] Added ${jobId} to queue (position: ${optimizationQueue.length})`);

  // Start processing if not already running
  processQueue();
}

/**
 * Clean up completed jobs after 5 minutes
 */
function cleanupOldJobs() {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  
  for (const [jobId, job] of optimizationJobs.entries()) {
    if ((job.state === 'complete' || job.state === 'error') && job.startTime < fiveMinutesAgo) {
      optimizationJobs.delete(jobId);
    }
  }
}

// Cleanup old jobs every minute
setInterval(cleanupOldJobs, 60 * 1000);

/**
 * GET /api/optimization-stream
 * SSE endpoint for optimization updates
 */
router.get('/', requireAuth, (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setTimeout(0);
  res.flushHeaders();

  // Add client to set
  clients.add(res);
  // info(`[Optimization Stream] Client connected (${clients.size} total)`);

  // Send current state of all active jobs
  const activeJobs = Array.from(optimizationJobs.entries()).map(([jobId, job]) => ({
    jobId,
    ...job
  }));
  
  if (activeJobs.length > 0) {
    res.write(`data: ${JSON.stringify({ 
      type: 'initial-state',
      jobs: activeJobs
    })}\n\n`);
  }

  // Touch session to keep it alive
  if (req.session) {
    req.session.touch();
  }

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
    if (req.session) {
      req.session.touch();
    }
  }, 30000); // Every 30 seconds

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    // info(`[Optimization Stream] Client disconnected (${clients.size} remaining)`);
  });
});

export default router;

