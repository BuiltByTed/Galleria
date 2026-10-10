/**
 * Optimization Stream Handlers
 * Connects to single SSE endpoint for all optimization updates
 */

import { UploadingImage } from '../types';
import { API_URL } from '../../../../config';
import { trackPhotoUploaded } from '../../../../utils/analytics';
import { error as logError, warn, info } from '../../../../utils/logger';
import { applyCompleteOptimizationUpdate } from './optimizationStreamState';


interface OptimizationStreamHandlersProps {
  setUploadingImages: React.Dispatch<React.SetStateAction<UploadingImage[]>>;
  uploadingAlbumRef: React.MutableRefObject<string>;
}

export const createOptimizationStreamHandlers = (props: OptimizationStreamHandlersProps) => {
  const { setUploadingImages, uploadingAlbumRef } = props;

  let eventSource: EventSource | null = null;

  /**
   * Connect to optimization stream SSE endpoint
   */
  const connectOptimizationStream = () => {
    // Don't reconnect if already connected or connecting
    if (eventSource) {
      if (eventSource.readyState === EventSource.OPEN) {
        info('[Optimization Stream] Already connected, skipping reconnection');
        return;
      } else if (eventSource.readyState === EventSource.CONNECTING) {
        info('[Optimization Stream] Connection in progress, skipping reconnection');
        return;
      } else {
        // Connection is closed, clean it up
        info('[Optimization Stream] Closing stale connection');
        eventSource.close();
        eventSource = null;
      }
    }

    info('[Optimization Stream] Establishing new connection...');
    
    eventSource = new EventSource(`${API_URL}/api/optimization-stream`, {
      withCredentials: true
    });

    eventSource.onopen = () => {
      info('[Optimization Stream] ✅ Connected successfully');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'initial-state') {
          // Server sent current state of all jobs
          info(`[Optimization Stream] Received ${data.jobs?.length || 0} active jobs`);
          // TODO: Could sync with existing uploadingImages if needed
        } else if (data.type === 'optimization-update') {
          // Update for a specific photo/video
          const { jobId, album, filename, progress, state, error, title, message } = data;

          info(`[Optimization Stream] Update received: ${jobId} - ${state} (${progress}%) - Album: "${album}" vs Uploading: "${uploadingAlbumRef.current}"`);

          // Only update if it's for the currently uploading album
          if (album !== uploadingAlbumRef.current) {
            info(`[Optimization Stream] Skipping update - album mismatch`);
            return;
          }

          setUploadingImages((prev: UploadingImage[]) => {
            const imageExists = prev.some(img => img.filename === filename);
            if (!imageExists) {
              warn(`[Optimization Stream] Image "${filename}" not found in uploadingImages array. Current images: [${prev.map(img => `"${img.filename}"`).join(', ')}]`);
              return prev; // Return unchanged if image not found
            }
            
            return prev.map((img: UploadingImage) => {
              if (img.filename !== filename) return img;

              // Map video processing states to 'optimizing'
              if (state === 'rotation' || state === '240p' || state === '360p' || state === '720p' || state === '1080p' || state === 'thumbnail' || state === 'modal-preview') {
                // Calculate overall progress across all stages
                // Video processing stages: rotation → resolutions (240p, 360p, 720p, 1080p) → thumbnail → modal-preview
                const allStages = ['rotation', '240p', '360p', '720p', '1080p', 'thumbnail', 'modal-preview'];
                const currentStageIndex = allStages.indexOf(state);
                const totalStages = allStages.length;
                
                // Overall progress = (completed stages + current stage progress) / total stages
                const overallProgress = currentStageIndex >= 0 
                  ? Math.round(((currentStageIndex * 100 + progress) / totalStages))
                  : progress;

                return {
                  ...img,
                  state: 'optimizing',
                  optimizeProgress: overallProgress, // Overall progress for the circle
                  videoStage: state, // Track the specific video stage
                  videoStageProgress: progress, // Individual stage progress
                  message
                };
              }

              // Update progress for regular photo optimization
              if (state === 'optimizing') {
                return {
                  ...img,
                  state: 'optimizing',
                  optimizeProgress: progress
                };
              }

              // Update to AI generating
              if (state === 'generating-title') {
                return {
                  ...img,
                  state: 'generating-title'
                };
              }

              // Complete
              if (state === 'complete') {
                info(`[Optimization Stream] ✅ Marking ${filename} as complete`);

                trackPhotoUploaded(album, 1, [filename]);

                return applyCompleteOptimizationUpdate(img, {
                  state,
                  album,
                  filename,
                  title,
                  error
                });
              }

              // Error
              if (state === 'error') {
                // Check if this is an optimization error or if we don't have a photo yet
                if (!img.photo) {
                  return {
                    ...img,
                    state: 'error',
                    error: error || 'Unknown error'
                  };
                } else {
                  // We have a photo, mark it complete with error
                  return {
                    ...img,
                    state: 'complete',
                    photo: {
                      ...img.photo,
                      optimizationError: error
                    }
                  };
                }
              }

              return img;
            });
          });
        }
      } catch (err) {
        logError('[Optimization Stream] Parse error:', err);
      }
    };

    eventSource.onerror = (err) => {
      logError('[Optimization Stream] Connection error', err);
      if (eventSource) {
        info('[Optimization Stream] EventSource readyState:', eventSource.readyState);
        eventSource.close();
        eventSource = null;
      }
      // Don't auto-reconnect - the parent component will reconnect if needed
    };
  };

  /**
   * Disconnect from optimization stream
   */
  const disconnectOptimizationStream = () => {
    if (eventSource) {
      info('[Optimization Stream] 🔌 Disconnecting...');
      eventSource.close();
      eventSource = null;
    } else {
      info('[Optimization Stream] Already disconnected');
    }
  };

  return {
    connectOptimizationStream,
    disconnectOptimizationStream
  };
};
