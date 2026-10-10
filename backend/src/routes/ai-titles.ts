/**
 * AI Titles Generation Route
 * Provides endpoint for generating AI titles for all images
 */

import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { csrfProtection } from '../security.js';
import { getDatabase } from '../database.js';
import { requireAuth, requireAdmin, requireManager } from '../auth/middleware.js';
import { DATA_DIR } from '../config.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Apply CSRF protection to all routes
router.use(csrfProtection);

/**
 * Convert text to title case
 * Capitalizes first letter of each word, except for common small words (unless first/last)
 */
function toTitleCase(str: string): string {
  const smallWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'
  ]);
  
  const words = str.split(' ');
  
  return words.map((word, index) => {
    // Always capitalize first and last word
    if (index === 0 || index === words.length - 1) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    
    // Keep small words lowercase
    const lowerWord = word.toLowerCase();
    if (smallWords.has(lowerWord)) {
      return lowerWord;
    }
    
    // Capitalize other words
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

// Track running jobs
interface RunningJob {
  process: any;
  output: string[];
  clients: Set<any>; // All connected SSE clients
  startTime: number;
  isComplete: boolean;
}

const runningJobs = {
  aiTitles: null as RunningJob | null,
  optimization: null as RunningJob | null
};

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
 * GET /api/ai-titles/status
 * Check if AI title generation is currently running
 */
router.get('/status', requireAuth, (req, res) => {
  if (runningJobs.aiTitles) {
    res.json({ 
      running: true, 
      output: runningJobs.aiTitles.output,
      isComplete: runningJobs.aiTitles.isComplete
    });
  } else {
    res.json({ running: false });
  }
});

/**
 * GET /api/ai-titles/check-missing
 * Check if there are images with missing titles
 */
router.get('/check-missing', requireAuth, (req, res) => {
  try {
    const db = getDatabase();
    
    // Count images without titles
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM image_metadata
      WHERE title IS NULL OR title = ''
    `).get() as { count: number };
    
    res.json({ 
      hasMissingTitles: result.count > 0,
      missingCount: result.count
    });
  } catch (err: any) {
    error('[AITitles] Failed to check missing titles:', err);
    res.status(500).json({ error: 'Failed to check missing titles' });
  }
});

/**
 * POST /api/ai-titles/stop
 * Stop running AI titles generation job
 */
router.post('/stop', requireManager, (req: any, res: any) => {
  if (!runningJobs.aiTitles || runningJobs.aiTitles.isComplete) {
    return res.json({ success: false, message: 'No running job to stop' });
  }
  
  try {
    // Kill the process
    if (runningJobs.aiTitles.process) {
      runningJobs.aiTitles.process.kill('SIGTERM');
      info('[AITitles] Job stopped by user');
    }
    
    // Mark as complete and broadcast to all clients
    const stopMsg = '__ERROR__ Job stopped by user';
    runningJobs.aiTitles.output.push(stopMsg);
    runningJobs.aiTitles.isComplete = true;
    broadcastToClients(runningJobs.aiTitles, stopMsg);
    
    // Close all client connections
    runningJobs.aiTitles.clients.forEach(client => {
      try {
        client.end();
      } catch (err) {
        // Ignore errors
      }
    });
    runningJobs.aiTitles.clients.clear();
    
    res.json({ success: true, message: 'Job stopped successfully' });
  } catch (err: any) {
    error('[AITitles] Failed to stop job:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/ai-titles/generate-single
 * Generate AI title for a single photo
 * Returns the title synchronously
 */
const generateSinglePhotoTitle = async (req: any, res: any) => {
  try {
    const { album, filename, language = 'en' } = req.body;
    
    if (!album || !filename) {
      return res.status(400).json({ error: 'Album and filename are required' });
    }
    
    // Load config to get OpenAI API key
    const configPath = path.join(DATA_DIR, 'config.json');
    let config: any = {};
    try {
      const configData = await fs.promises.readFile(configPath, 'utf-8');
      config = JSON.parse(configData);
    } catch (err) {
      error('[AITitles] Failed to load config:', err);
      return res.status(500).json({ error: 'Failed to load configuration' });
    }
    
    if (!config.openai?.apiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }
    
    // Use thumbnail for faster uploads to OpenAI
    const projectRoot = path.resolve(__dirname, '../../..');
    const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
    const optimizedDir = path.join(dataDir, 'optimized');
    
    // For videos, use the .jpg thumbnail; for photos, use the original filename
    const isVideo = filename.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm)$/);
    const thumbnailFilename = isVideo ? filename.replace(/\.[^.]+$/, '.jpg') : filename;
    
    // Try thumbnail first, fall back to original if not found
    let imagePath = path.join(optimizedDir, 'thumbnail', album, thumbnailFilename);
    if (!fs.existsSync(imagePath)) {
      info('[AITitles] Thumbnail not found, falling back to original');
      const photosDir = path.join(dataDir, 'photos');
      imagePath = path.join(photosDir, album, filename);
      
      if (!fs.existsSync(imagePath)) {
        error('[AITitles] Image not found:', imagePath);
        return res.status(404).json({ error: 'Image not found' });
      }
    }
    
    if (isVideo) {
      info('[AITitles] Processing video - using extracted thumbnail for AI analysis');
    }
    
    // Initialize OpenAI
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    
    // Read the image and convert to base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const extension = path.extname(filename).toLowerCase().substring(1);
    const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
    
    info(`[AITitles] Using image: ${imagePath} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
    
    // Language names for prompt
    const languageNames: Record<string, string> = {
      en: 'English',
      ja: 'Japanese',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
      it: 'Italian',
      pt: 'Portuguese',
      ru: 'Russian',
      zh: 'Chinese',
      ko: 'Korean',
      nl: 'Dutch',
      pl: 'Polish',
      tr: 'Turkish',
      sv: 'Swedish',
      no: 'Norwegian',
      ro: 'Romanian',
      vi: 'Vietnamese',
      id: 'Indonesian',
      tl: 'Tagalog'
    };
    
    const languageName = languageNames[language] || 'English';
    const promptText = `Generate a concise, descriptive title for this image in ${languageName}. The title should be 3-8 words and capture the essence of the image. Output ONLY the title in ${languageName}, nothing else.`;
    
    // Call OpenAI Vision API (same prompt as upload flow)
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: "low"
              }
            }
          ]
        }
      ],
      max_tokens: 50
    });
    
    let title = response.choices[0]?.message?.content?.trim();
    
    if (!title) {
      return res.status(500).json({ error: 'Failed to generate title (empty response)' });
    }
    
    // Clean the title: remove quotes and convert to title case
    title = title.replace(/^["']|["']$/g, '');
    title = title.trim();
    title = toTitleCase(title);
    
    // Save to database
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO image_metadata (album, filename, title, description)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(album, filename) 
      DO UPDATE SET 
        title = excluded.title,
        updated_at = CURRENT_TIMESTAMP
    `);
    
    stmt.run(album, filename, title);
    
    info(`[AITitles] Generated title for ${album}/${filename}: "${title}"`);
    
    res.json({ success: true, title });
  } catch (err: any) {
    error('[AITitles] Failed to generate single title:', err);
    res.status(500).json({ 
      error: 'Failed to generate title',
      message: err.message 
    });
  }
};

router.post('/generate-single', requireManager, generateSinglePhotoTitle);
router.post('/retry-photo', requireManager, generateSinglePhotoTitle);

/**
 * POST /api/ai-titles/generate
 * Generate AI titles for all images
 * Streams output using Server-Sent Events
 */
router.post('/generate', requireManager, (req, res) => {
  const forceRegenerate = req.query.forceRegenerate === 'true';
  
  // If already running, reconnect to existing job
  if (runningJobs.aiTitles && !runningJobs.aiTitles.isComplete) {
    info('[AITitles] Reconnecting to existing job');
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering
    res.setTimeout(0); // Disable timeout for this response
    
    // Send all previous output
    runningJobs.aiTitles.output.forEach(line => {
      res.write(`data: ${line}\n\n`);
    });
    
    // Add this client to the broadcast list
    runningJobs.aiTitles.clients.add(res);
    
    // Remove client when they disconnect
    req.on('close', () => {
      if (runningJobs.aiTitles) {
        runningJobs.aiTitles.clients.delete(res);
      }
    });
    
    return;
  }

  // Create job tracking IMMEDIATELY to prevent race condition
  runningJobs.aiTitles = {
    process: null,
    output: [],
    clients: new Set([res]),
    startTime: Date.now(),
    isComplete: false
  };

  // Set headers for Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering
  res.setTimeout(0); // Disable timeout for this response

  // Get the project root directory (3 levels up from this file)
  const projectRoot = path.resolve(__dirname, '../../..');
  const scriptPath = path.join(projectRoot, 'scripts', 'generate-ai-titles.js');

  info('[AITitles] Starting generation...');
  info('[AITitles] Force regenerate:', forceRegenerate);
  info('[AITitles] Script path:', scriptPath);
  info('[AITitles] Working directory:', projectRoot);

  // Build script arguments
  const scriptArgs = [scriptPath];
  if (forceRegenerate) {
    scriptArgs.push('--force');
  }

  // Spawn the Node.js process to run the script
  const child = spawn('node', scriptArgs, {
    cwd: projectRoot,
    env: { ...process.env },
  });
  
  runningJobs.aiTitles.process = child;
  
  // Remove client when they disconnect
  req.on('close', () => {
    if (runningJobs.aiTitles) {
      runningJobs.aiTitles.clients.delete(res);
    }
  });

  // Send stdout data as SSE events
  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter((line: string) => line.trim());
    lines.forEach((line: string) => {
      info('[AITitles]', line);
      
      let output = '';
      
      // Parse waiting status like: WAITING:5
      const waitingMatch = line.match(/^WAITING:(\d+)$/);
      if (waitingMatch) {
        const seconds = parseInt(waitingMatch[1]);
        output = JSON.stringify({ 
          type: 'waiting',
          seconds: seconds
        });
      } 
      // Parse progress from lines like: [150/3000] (5%) Album/image.jpg
      else {
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
        } else {
          output = line;
        }
      }
      
      // Store output and broadcast to all clients
      if (runningJobs.aiTitles) {
        runningJobs.aiTitles.output.push(output);
        broadcastToClients(runningJobs.aiTitles, output);
      }
    });
  });

  // Send stderr data as SSE events (errors)
  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter((line: string) => line.trim());
    lines.forEach((line: string) => {
      error('[AI Titles Error]', line);
      const errorOutput = `ERROR: ${line}`;
      
      // Store output and broadcast to all clients
      if (runningJobs.aiTitles) {
        runningJobs.aiTitles.output.push(errorOutput);
        broadcastToClients(runningJobs.aiTitles, errorOutput);
      }
    });
  });

  // Handle process completion
  child.on('close', async (code) => {
    info(`[AITitles] Process exited with code ${code}`);
    
    const completeMsg = code === 0 ? '__COMPLETE__' : `__ERROR__ Process exited with code ${code}`;
    
    if (runningJobs.aiTitles) {
      runningJobs.aiTitles.output.push(completeMsg);
      runningJobs.aiTitles.isComplete = true;
      
      // If successful, regenerate static JSON since titles changed
      if (code === 0) {
        info('[AITitles] Regenerating static JSON after title generation...');
        const staticJsonScript = path.join(projectRoot, 'scripts', 'generate-static-json.js');
        const staticJsonProcess = spawn('node', [staticJsonScript], {
          cwd: projectRoot,
          env: { ...process.env }
        });
        
        staticJsonProcess.on('close', (jsonCode) => {
          if (jsonCode === 0) {
            info('[AITitles] Static JSON regenerated successfully');
          } else {
            warn('[AITitles] Static JSON regeneration failed with code', jsonCode);
          }
        });
        
        staticJsonProcess.on('error', (err) => {
          error('[AITitles] Failed to regenerate static JSON:', err);
        });
      }
      
      // Broadcast to all clients and close connections
      broadcastToClients(runningJobs.aiTitles, completeMsg);
      runningJobs.aiTitles.clients.forEach(client => {
        try {
          client.end();
        } catch (err) {
          // Ignore errors
        }
      });
      runningJobs.aiTitles.clients.clear();
      
      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const duration = Date.now() - runningJobs.aiTitles.startTime;
        const durationMin = (duration / 1000 / 60).toFixed(1);
        
        const titleKey = code === 0 ? 'notifications.backend.aiTitlesComplete' : 'notifications.backend.aiTitlesFailed';
        const bodyKey = code === 0 ? 'notifications.backend.aiTitlesCompleteBody' : 'notifications.backend.aiTitlesFailedBody';
        
        const variables = code === 0 
          ? { albumName: (runningJobs.aiTitles as any).album || 'Unknown', titlesGenerated: (runningJobs.aiTitles as any).generatedCount || 0 }
          : { albumName: (runningJobs.aiTitles as any).album || 'Unknown', error: (runningJobs.aiTitles as any).error || 'Unknown error' };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'ai-titles',
          requireInteraction: false
        }).catch(err => {
          warn('[AITitles] Failed to send push notification:', err);
        });
      }
      
      // Clean up after 5 minutes — only if this job is still the tracked one
      // (a later POST /generate may have replaced runningJobs.aiTitles)
      const jobRef = runningJobs.aiTitles;
      setTimeout(() => {
        if (runningJobs.aiTitles === jobRef) {
          runningJobs.aiTitles = null;
        }
      }, 5 * 60 * 1000);
    }
  });

  // Handle errors
  child.on('error', (err) => {
    error('[AITitles] Failed to start process:', err);
    const errorMsg = `__ERROR__ ${err.message}`;
    
    if (runningJobs.aiTitles) {
      runningJobs.aiTitles.output.push(errorMsg);
      runningJobs.aiTitles.isComplete = true;
      
      // Broadcast to all clients and close connections
      broadcastToClients(runningJobs.aiTitles, errorMsg);
      runningJobs.aiTitles.clients.forEach(client => {
        try {
          client.end();
        } catch (err) {
          // Ignore errors
        }
      });
      runningJobs.aiTitles.clients.clear();
    }
  });
});

export default router;
