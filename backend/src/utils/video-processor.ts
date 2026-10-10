/**
 * Video Processing Module
 * Handles video rotation, HLS encoding, and thumbnail generation
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { info, error, warn } from './logger.js';

const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const access = promisify(fs.access);
const writeFile = promisify(fs.writeFile);

/**
 * Hardware encoder types supported
 */
export enum HardwareEncoder {
  NONE = 'none',
  NVIDIA = 'h264_nvenc',
  INTEL_QSV = 'h264_qsv',
  AMD = 'h264_amf',
  VIDEOTOOLBOX = 'h264_videotoolbox',
  VAAPI = 'h264_vaapi'
}

// Cache for detected hardware encoder
let detectedEncoder: HardwareEncoder | null = null;

export interface VideoResolution {
  name: string;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
}

export interface VideoProcessingProgress {
  stage: 'rotation' | '240p' | '360p' | '720p' | '1080p' | 'thumbnail' | 'modal-preview';
  progress: number;
  message: string;
}

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  rotation: number;
}

/**
 * Get video metadata using ffprobe
 */
export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration,rotation',
      '-show_entries', 'format=duration',
      '-of', 'json',
      videoPath
    ];

    const ffprobe = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Reject on spawn failure (e.g. ffprobe missing / ENOENT) so callers do not hang
    ffprobe.on('error', (err) => {
      reject(new Error(`ffprobe spawn failed: ${err.message}`));
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0];
        if (!stream) {
          reject(new Error('ffprobe returned no video stream'));
          return;
        }
        const format = data.format;

        resolve({
          width: stream.width || 1920,
          height: stream.height || 1080,
          duration: parseFloat(stream.duration || format?.duration || '0'),
          rotation: stream.rotation || 0
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err}`));
      }
    });
  });
}

/**
 * Detect available hardware encoder on the system
 * Checks in priority order: NVIDIA > Intel QSV > AMD > VideoToolbox > VA-API
 */
export async function detectHardwareEncoder(): Promise<HardwareEncoder> {
  // Return cached result if already detected
  if (detectedEncoder !== null) {
    return detectedEncoder;
  }

  info('[VideoProcessor] Detecting available hardware encoders...');

  // List of encoders to check in priority order
  const encodersToCheck: HardwareEncoder[] = [
    HardwareEncoder.NVIDIA,
    HardwareEncoder.INTEL_QSV,
    HardwareEncoder.AMD,
    HardwareEncoder.VIDEOTOOLBOX,
    HardwareEncoder.VAAPI
  ];

  for (const encoder of encodersToCheck) {
    try {
      const isAvailable = await checkEncoderAvailable(encoder);
      if (isAvailable) {
        info(`[VideoProcessor] Hardware encoder detected: ${encoder}`);
        detectedEncoder = encoder;
        return encoder;
      }
    } catch (err) {
      // Continue checking other encoders
    }
  }

  info('[VideoProcessor] No hardware encoder available, using software encoding');
  detectedEncoder = HardwareEncoder.NONE;
  return HardwareEncoder.NONE;
}

/**
 * Check if a specific hardware encoder is available
 */
async function checkEncoderAvailable(encoder: HardwareEncoder): Promise<boolean> {
  return new Promise((resolve) => {
    // Run ffmpeg with the encoder to see if it's supported
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-encoders']);
    let stdout = '';

    ffmpeg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffmpeg.on('close', () => {
      // Check if encoder is listed in available encoders
      const encoderRegex = new RegExp(`\\s${encoder}\\s`, 'i');
      resolve(encoderRegex.test(stdout));
    });

    ffmpeg.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Reset the cached hardware encoder detection (useful for testing)
 */
export function resetHardwareEncoderCache(): void {
  detectedEncoder = null;
}

/**
 * Rotate video if needed (based on metadata)
 */
export async function rotateVideo(
  inputPath: string,
  outputPath: string,
  metadata: VideoMetadata,
  onProgress?: (progress: number) => void
): Promise<void> {
  // If no rotation needed, just copy the file
  if (!metadata.rotation || metadata.rotation === 0) {
    info('[VideoProcessor] No rotation needed, copying file');
    await fs.promises.copyFile(inputPath, outputPath);
    if (onProgress) onProgress(100);
    return;
  }

  return new Promise((resolve, reject) => {
    let transpose = '';
    
    // Convert rotation to transpose filter
    // 90 degrees clockwise = transpose=1
    // 90 degrees counter-clockwise = transpose=2
    // 180 degrees = transpose=1,transpose=1
    switch (metadata.rotation) {
      case 90:
        transpose = 'transpose=1';
        break;
      case -90:
      case 270:
        transpose = 'transpose=2';
        break;
      case 180:
      case -180:
        transpose = 'transpose=1,transpose=1';
        break;
      default:
        // Unknown rotation, just copy
        fs.promises.copyFile(inputPath, outputPath)
          .then(() => resolve())
          .catch(reject);
        return;
    }

    const args = [
      '-i', inputPath,
      '-vf', transpose,
      '-c:a', 'copy',
      '-metadata:s:v:0', 'rotate=0',
      '-y',
      outputPath
    ];

    info(`[VideoProcessor] Rotating video ${metadata.rotation} degrees`);
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      
      // Parse progress from ffmpeg output
      if (onProgress && metadata.duration > 0) {
        const timeMatch = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          const currentTime = hours * 3600 + minutes * 60 + seconds;
          const progress = Math.min(99, (currentTime / metadata.duration) * 100);
          onProgress(progress);
        }
      }
    });

    // Reject on spawn failure (e.g. ffmpeg missing / ENOENT) so callers do not hang
    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        error('[VideoProcessor] Rotation failed:', stderr);
        reject(new Error(`Video rotation failed: ${stderr}`));
      } else {
        if (onProgress) onProgress(100);
        resolve();
      }
    });
  });
}

/**
 * Generate HLS playlist for a specific resolution
 */
export async function generateHLS(
  inputPath: string,
  outputDir: string,
  resolution: VideoResolution,
  segmentDuration: number = 4,
  hardwareAcceleration: boolean = false,
  onProgress?: (progress: number) => void
): Promise<void> {
  // Create output directory
  await mkdir(outputDir, { recursive: true });

  return new Promise(async (resolve, reject) => {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const segmentPattern = path.join(outputDir, 'segment%03d.ts');

    // Calculate GOP size to match segment duration
    // Assuming 30fps (typical for most videos), GOP should be segmentDuration * 30
    // This ensures one keyframe per segment, preventing buffer holes
    const fps = 30;
    const gopSize = segmentDuration * fps;

    // Detect hardware encoder if hardware acceleration is enabled
    let encoder = 'libx264'; // Default software encoder
    let encoderArgs: string[] = [];
    
    if (hardwareAcceleration) {
      const hwEncoder = await detectHardwareEncoder();
      
      if (hwEncoder !== HardwareEncoder.NONE) {
        encoder = hwEncoder;
        info(`[VideoProcessor] Using hardware encoder: ${encoder}`);
        
        // Configure encoder-specific arguments
        switch (hwEncoder) {
          case HardwareEncoder.NVIDIA:
            // NVIDIA NVENC settings optimized for HLS streaming
            // Critical: Use CBR + no B-frames for smooth HLS playback
            encoderArgs = [
              '-preset', 'p4', // p1 (fastest) to p7 (slowest), p4 is balanced
              '-tune', 'hq', // High quality tuning
              '-profile:v', 'main', // Main profile (baseline/main for HLS compatibility)
              '-rc', 'cbr', // Constant bitrate for predictable streaming
              '-b:v', resolution.videoBitrate,
              '-maxrate', resolution.videoBitrate,
              '-bufsize', `${parseInt(resolution.videoBitrate) * 2}k`,
              '-spatial-aq', '1', // Spatial adaptive quantization
              '-temporal-aq', '1', // Temporal adaptive quantization
              '-forced-idr', '1', // Force IDR frames at every keyframe for HLS seeking
              '-bf', '0', // NO B-frames - prevents stuttering in HLS
              '-no-scenecut', '1', // Disable scenecut detection to prevent unexpected keyframes
            ];
            break;
            
          case HardwareEncoder.INTEL_QSV:
            // Intel Quick Sync Video settings
            encoderArgs = [
              '-preset', 'medium',
              '-global_quality', resolution.height >= 1080 ? '23' : resolution.height >= 720 ? '25' : '28',
              '-b:v', resolution.videoBitrate,
              '-maxrate', resolution.videoBitrate,
              '-bufsize', `${parseInt(resolution.videoBitrate) * 2}k`,
            ];
            break;
            
          case HardwareEncoder.AMD:
            // AMD AMF settings
            encoderArgs = [
              '-quality', 'balanced',
              '-rc', 'vbr_latency',
              '-qp_i', resolution.height >= 1080 ? '23' : resolution.height >= 720 ? '25' : '28',
              '-b:v', resolution.videoBitrate,
              '-maxrate', resolution.videoBitrate,
              '-bufsize', `${parseInt(resolution.videoBitrate) * 2}k`,
            ];
            break;
            
          case HardwareEncoder.VIDEOTOOLBOX:
            // Apple VideoToolbox settings
            encoderArgs = [
              '-b:v', resolution.videoBitrate,
              '-maxrate', resolution.videoBitrate,
              '-bufsize', `${parseInt(resolution.videoBitrate) * 2}k`,
            ];
            break;
            
          case HardwareEncoder.VAAPI:
            // VA-API settings (Linux)
            encoderArgs = [
              '-qp', resolution.height >= 1080 ? '23' : resolution.height >= 720 ? '25' : '28',
              '-b:v', resolution.videoBitrate,
              '-maxrate', resolution.videoBitrate,
              '-bufsize', `${parseInt(resolution.videoBitrate) * 2}k`,
            ];
            break;
        }
      } else {
        warn('[VideoProcessor] Hardware acceleration enabled but no hardware encoder detected, falling back to software encoding');
      }
    }
    
    // Use software encoder settings if not using hardware
    if (encoder === 'libx264') {
      encoderArgs = [
        '-preset', resolution.height >= 720 ? 'medium' : 'fast',
        '-crf', resolution.height >= 1080 ? '23' : resolution.height >= 720 ? '25' : '28',
        '-b:v', resolution.videoBitrate,
        '-maxrate', resolution.videoBitrate,
        '-bufsize', `${parseInt(resolution.videoBitrate) * 2}k`,
      ];
    }

    // Build ffmpeg arguments
    const args = [];
    
    // Add hardware acceleration input flags if using NVIDIA encoder
    if (hardwareAcceleration && encoder === HardwareEncoder.NVIDIA) {
      // Use CUDA for hardware decoding and keep frames in GPU memory
      args.push(
        '-hwaccel', 'cuda',
        '-hwaccel_output_format', 'cuda',
        '-extra_hw_frames', '2' // Pre-allocate GPU frames for smoother pipeline
      );
    }
    
    // Input and encoding arguments
    args.push(
      '-i', inputPath,
      '-c:v', encoder,
      ...encoderArgs
    );
    
    // For NVIDIA, use GPU-accelerated scaling filter
    if (hardwareAcceleration && encoder === HardwareEncoder.NVIDIA) {
      args.push('-vf', `scale_cuda=-2:${resolution.height}`);
    } else {
      args.push('-vf', `scale=-2:${resolution.height}`);
    }
    
    // Add remaining arguments
    args.push(
      // Force keyframes at segment boundaries to prevent buffer holes
      '-g', gopSize.toString(), // GOP size = segment duration * fps
      '-keyint_min', gopSize.toString(), // Minimum keyframe interval
      '-sc_threshold', '0', // Disable scene change detection (prevents extra keyframes)
      '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`, // Force keyframes every N seconds
      '-c:a', 'aac',
      '-b:a', resolution.audioBitrate,
      '-ac', '2',
      // Bitstream filter: Convert to Annex B format (required for HLS/MPEG-TS)
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'hls',
      '-hls_time', segmentDuration.toString(),
      '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      '-hls_segment_type', 'mpegts', // Explicitly use MPEG-TS segments
      '-start_number', '0',
      '-hls_flags', 'independent_segments+split_by_time', // Independent segments for HLS
      '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
      '-vsync', 'cfr', // Constant frame rate - prevents timing issues
      '-y',
      playlistPath
    );

    if (hardwareAcceleration && encoder === HardwareEncoder.NVIDIA) {
      info(`[VideoProcessor] Generating ${resolution.name} HLS playlist with CUDA hardware decode + ${encoder} encode`);
    } else {
      info(`[VideoProcessor] Generating ${resolution.name} HLS playlist with ${encoder}`);
    }
    
    // Log the exact ffmpeg command for debugging
    info(`[VideoProcessor] Running ffmpeg command: ffmpeg ${args.join(' ')}`);
    
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    let duration = 0;

    ffmpeg.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      
      // Extract duration from ffmpeg output (only check once)
      if (duration === 0) {
        const durationMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseFloat(durationMatch[3]);
          duration = hours * 3600 + minutes * 60 + seconds;
        }
      }
      
      // Parse progress from the LATEST chunk (not entire stderr buffer)
      // This ensures we report the most recent progress, not the first match
      if (onProgress && duration > 0) {
        const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          const currentTime = hours * 3600 + minutes * 60 + seconds;
          const progress = Math.min(99, (currentTime / duration) * 100);
          onProgress(progress);
        }
      }
    });

    // Reject on spawn failure (e.g. ffmpeg missing / ENOENT) so callers do not hang
    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        error(`[VideoProcessor] HLS generation failed for ${resolution.name}:`, stderr);
        reject(new Error(`HLS generation failed: ${stderr}`));
      } else {
        if (onProgress) onProgress(100);
        info(`[VideoProcessor] ${resolution.name} HLS playlist generated successfully`);
        resolve();
      }
    });
  });
}

/**
 * Extract a thumbnail from the video
 */
export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  size: number,
  onProgress?: (progress: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', `scale=${size}:-2`,
      '-y',
      outputPath
    ];

    info(`[VideoProcessor] Extracting ${size}px thumbnail`);
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      if (onProgress) onProgress(50); // Simple progress indication
    });

    // Reject on spawn failure (e.g. ffmpeg missing / ENOENT) so callers do not hang
    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        error('[VideoProcessor] Thumbnail extraction failed:', stderr);
        reject(new Error(`Thumbnail extraction failed: ${stderr}`));
      } else {
        if (onProgress) onProgress(100);
        info(`[VideoProcessor] ${size}px thumbnail extracted successfully`);
        resolve();
      }
    });
  });
}

/**
 * Process a video: rotate, generate HLS playlists, and extract thumbnails
 */
export async function processVideo(
  inputPath: string,
  album: string,
  filename: string,
  dataDir: string,
  onProgress?: (update: VideoProcessingProgress) => void
): Promise<void> {
  const videoDir = path.join(dataDir, 'video', album, filename);
  const optimizedDir = path.join(dataDir, 'optimized');
  
  // Create directories
  await mkdir(videoDir, { recursive: true });
  await mkdir(path.join(optimizedDir, 'thumbnail', album), { recursive: true });
  await mkdir(path.join(optimizedDir, 'modal', album), { recursive: true });

  try {
    // Step 1: Get video metadata
    info('[VideoProcessor] Getting video metadata');
    const metadata = await getVideoMetadata(inputPath);
    
    // Step 2: Rotate video if needed
    if (onProgress) {
      onProgress({
        stage: 'rotation',
        progress: 0,
        message: 'Checking rotation...'
      });
    }
    
    const rotatedPath = path.join(videoDir, 'original.mp4');
    await rotateVideo(inputPath, rotatedPath, metadata, (progress) => {
      if (onProgress) {
        onProgress({
          stage: 'rotation',
          progress,
          message: 'Rotating video...'
        });
      }
    });

    // Step 3: Generate HLS playlists for different resolutions
    // Load resolution settings, segment duration, and hardware acceleration from config
    const configPath = path.join(dataDir, 'config.json');
    let resolutionConfig: any = null;
    let segmentDuration = 4; // Default
    let hardwareAcceleration = false; // Default
    
    try {
      const configData = await fs.promises.readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);
      resolutionConfig = config.environment?.optimization?.video?.resolutions;
      segmentDuration = config.environment?.optimization?.video?.segmentDuration || 4;
      hardwareAcceleration = config.environment?.optimization?.video?.hardwareAcceleration || false;
    } catch (err) {
      warn('[VideoProcessor] Could not load video config from config.json, trying defaults');
    }

    // If config.json doesn't have video settings, try config.defaults.json
    if (!resolutionConfig) {
      try {
        const defaultsPath = path.join(dataDir, '..', 'config', 'config.defaults.json');
        const defaultsData = await fs.promises.readFile(defaultsPath, 'utf-8');
        const defaults = JSON.parse(defaultsData);
        resolutionConfig = defaults.environment?.optimization?.video?.resolutions;
        segmentDuration = defaults.environment?.optimization?.video?.segmentDuration || 4;
        hardwareAcceleration = defaults.environment?.optimization?.video?.hardwareAcceleration || false;
        info('[VideoProcessor] Using default video config from config.defaults.json');
      } catch (err) {
        error('[VideoProcessor] Failed to load video config from defaults:', err);
        throw new Error('Video configuration not found in config.json or config.defaults.json');
      }
    }

    if (!resolutionConfig) {
      throw new Error('No video resolutions configured');
    }
    
    info(`[VideoProcessor] Hardware acceleration: ${hardwareAcceleration ? 'enabled' : 'disabled'}`);

    // Build resolutions array from config (only enabled resolutions)
    const resolutions: VideoResolution[] = [];
    for (const [name, config] of Object.entries(resolutionConfig)) {
      const resConfig = config as any;
      // Only include enabled resolutions that are <= source resolution
      if (resConfig.enabled && resConfig.height <= metadata.height) {
        resolutions.push({
          name,
          height: resConfig.height,
          videoBitrate: resConfig.videoBitrate,
          audioBitrate: resConfig.audioBitrate
        });
      }
    }

    // Sort by height ascending
    resolutions.sort((a, b) => a.height - b.height);

    if (resolutions.length === 0) {
      throw new Error('No video resolutions enabled in configuration or all resolutions exceed source video height');
    }

    for (const resolution of resolutions) {
      const resolutionDir = path.join(videoDir, resolution.name);
      const stage = resolution.name as '240p' | '360p' | '720p' | '1080p';
      
      if (onProgress) {
        onProgress({
          stage,
          progress: 0,
          message: `Encoding ${resolution.name}...`
        });
      }

      await generateHLS(rotatedPath, resolutionDir, resolution, segmentDuration, hardwareAcceleration, (progress) => {
        if (onProgress) {
          onProgress({
            stage,
            progress,
            message: `Encoding ${resolution.name}...`
          });
        }
      });
    }

    // Step 3.5: Generate master playlist for adaptive streaming
    info('[VideoProcessor] Generating master HLS playlist');
    const masterPlaylistPath = path.join(videoDir, 'master.m3u8');
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
    
    for (const resolution of resolutions) {
      // Calculate total bandwidth (video + audio bitrate in bps)
      const videoBitrateKbps = parseInt(resolution.videoBitrate);
      const audioBitrateKbps = parseInt(resolution.audioBitrate);
      const totalBandwidth = (videoBitrateKbps + audioBitrateKbps) * 1000;
      
      // Calculate width based on 16:9 aspect ratio
      const width = Math.round(resolution.height * (16 / 9));
      
      masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${totalBandwidth},RESOLUTION=${width}x${resolution.height}\n`;
      masterContent += `${resolution.name}/playlist.m3u8\n\n`;
    }
    
    await writeFile(masterPlaylistPath, masterContent, 'utf-8');
    info(`[VideoProcessor] Master playlist created with ${resolutions.length} quality levels`);

    // Step 4: Extract thumbnails
    if (onProgress) {
      onProgress({
        stage: 'thumbnail',
        progress: 0,
        message: 'Extracting thumbnail...'
      });
    }

    const thumbnailPath = path.join(optimizedDir, 'thumbnail', album, filename.replace(/\.[^.]+$/, '.jpg'));
    await extractThumbnail(rotatedPath, thumbnailPath, 512, (progress) => {
      if (onProgress) {
        onProgress({
          stage: 'thumbnail',
          progress,
          message: 'Extracting thumbnail...'
        });
      }
    });

    // Step 5: Extract modal-sized preview
    if (onProgress) {
      onProgress({
        stage: 'modal-preview',
        progress: 0,
        message: 'Extracting preview image...'
      });
    }

    const modalPath = path.join(optimizedDir, 'modal', album, filename.replace(/\.[^.]+$/, '.jpg'));
    await extractThumbnail(rotatedPath, modalPath, 2048, (progress) => {
      if (onProgress) {
        onProgress({
          stage: 'modal-preview',
          progress,
          message: 'Extracting preview image...'
        });
      }
    });

    // Keep rotated file for thumbnail extraction
    // Don't delete rotatedPath - it's needed for thumbnail updates via the admin panel
    info(`[VideoProcessor] Keeping original.mp4 for thumbnail extraction`);

    info(`[VideoProcessor] Video processing complete: ${album}/${filename}`);
  } catch (err) {
    error('[VideoProcessor] Video processing failed:', err);
    throw err;
  }
}

/**
 * Check if ffmpeg is available
 */
export async function checkFFmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    
    ffmpeg.on('close', (code) => {
      resolve(code === 0);
    });
    
    ffmpeg.on('error', () => {
      resolve(false);
    });
  });
}
