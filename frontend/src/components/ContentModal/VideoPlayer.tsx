/**
 * Simple Video Player Component
 * Uses native browser controls + HLS.js for adaptive streaming
 */

import React, { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import { API_URL } from '../../config';
import { trackVideoQualityChange } from '../../utils/analytics';

interface VideoPlayerProps {
  album: string;
  filename: string;
  videoTitle?: string;
  posterUrl?: string;
  onLoadStart?: () => void;
  onLoaded?: () => void;
  secretKey?: string;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  album,
  filename,
  videoTitle = '',
  posterUrl,
  onLoadStart,
  onLoaded,
  secretKey
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const initializingRef = useRef(false);
  const videoId = `${album}/${filename}`;
  
  // Store callbacks in refs to avoid triggering effect on every render
  const onLoadStartRef = useRef(onLoadStart);
  const onLoadedRef = useRef(onLoaded);
  
  useEffect(() => {
    onLoadStartRef.current = onLoadStart;
    onLoadedRef.current = onLoaded;
  }, [onLoadStart, onLoaded]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || initializingRef.current) return;
    
    initializingRef.current = true;
    console.log('[VideoPlayer] Initializing for', filename);

    if (onLoadStartRef.current) onLoadStartRef.current();

    // Construct master playlist URL
    const masterPlaylistUrl = `${API_URL}/api/video/${encodeURIComponent(album)}/${encodeURIComponent(filename)}/master.m3u8`;
    console.log('[VideoPlayer] Master playlist URL:', masterPlaylistUrl);

    if (Hls.isSupported()) {
      console.log('[VideoPlayer] Using HLS.js');
      
      // Custom loader to append secretKey to all requests
      class CustomLoader extends Hls.DefaultConfig.loader {
        constructor(config: any) {
          super(config);
          const load = this.load.bind(this);
          this.load = function(context: any, config: any, callbacks: any) {
            // Add secretKey to all video API requests
            if (secretKey && context.url && context.url.includes('/api/video/')) {
              const separator = context.url.includes('?') ? '&' : '?';
              context.url = `${context.url}${separator}key=${secretKey}`;
            }
            return load(context, config, callbacks);
          };
        }
      }

      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30, // Buffer 30 seconds ahead (increased)
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        backBufferLength: 90,
        maxBufferHole: 0.5, // Tolerate buffer holes up to 0.5s
        maxFragLookUpTolerance: 0.25,
        nudgeMaxRetry: 10, // Try harder to recover from stalls
        loader: CustomLoader,
        xhrSetup: (xhr: XMLHttpRequest) => {
          xhr.withCredentials = true;
        },
      });

      hlsRef.current = hls;
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[VideoPlayer] Loaded:', hls.levels.map(l => l.height + 'p'));
        
        // Set default quality to 720p if available (do this once on load)
        const preferredHeight = 720;
        const levelIndex = hls.levels.findIndex(level => level.height === preferredHeight);
        
        if (levelIndex !== -1) {
          hls.loadLevel = levelIndex; // Use loadLevel to set initial quality without interrupting playback
          console.log(`[VideoPlayer] Starting at ${preferredHeight}p`);
        } else {
          // If 720p not available, use highest quality
          hls.loadLevel = hls.levels.length - 1;
          console.log(`[VideoPlayer] 720p not available, using highest quality: ${hls.levels[hls.levels.length - 1].height}p`);
        }
        
        if (onLoadedRef.current) onLoadedRef.current();
      });
      
      hls.loadSource(masterPlaylistUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls.levels[data.level];
        const quality = `${level.height}p`;
        console.log(`[VideoPlayer] Level switched to ${quality}`);
        trackVideoQualityChange(videoId, album, videoTitle, quality, true);
      });
      
      hls.on(Hls.Events.LEVEL_SWITCHING, (_event, data) => {
        console.log(`[VideoPlayer] Level switching to ${hls.levels[data.level].height}p`);
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.error('[VideoPlayer] HLS Error:', data.type, data.details, 'fatal:', data.fatal, data);
        
        // Handle non-fatal buffer errors gracefully
        if (!data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (data.details === 'bufferSeekOverHole' || data.details === 'bufferStalledError') {
            console.log('[VideoPlayer] Ignoring non-fatal buffer error, HLS.js will recover');
            return;
          }
        }
        
        if (data.fatal) {
          console.error('[VideoPlayer] Fatal error:', data);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[VideoPlayer] Attempting to recover from network error');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[VideoPlayer] Attempting to recover from media error');
              hls.recoverMediaError();
              break;
            default:
              console.error('[VideoPlayer] Unrecoverable error, destroying HLS');
              hls.destroy();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      console.log('[VideoPlayer] Using native HLS (Safari)');
      // Native HLS has no CustomLoader — append share key so unpublished albums authorize
      let nativeSrc = masterPlaylistUrl;
      if (secretKey) {
        const separator = nativeSrc.includes('?') ? '&' : '?';
        nativeSrc = `${nativeSrc}${separator}key=${secretKey}`;
      }
      video.src = nativeSrc;
      video.addEventListener('loadedmetadata', () => {
        if (onLoadedRef.current) onLoadedRef.current();
      });
    } else {
      console.error('[VideoPlayer] HLS not supported');
    }

    return () => {
      initializingRef.current = false;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [album, filename, videoTitle, secretKey]);

  const posterUrlFull = posterUrl ? `${API_URL}${posterUrl}${secretKey ? `?key=${secretKey}` : ''}` : undefined;

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      preload="metadata"
      poster={posterUrlFull}
      onPlay={() => console.log('[VideoPlayer] Video PLAY event')}
      onPause={() => console.log('[VideoPlayer] Video PAUSE event')}
      onPlaying={() => console.log('[VideoPlayer] Video PLAYING event')}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        objectFit: 'contain',
        backgroundColor: '#000'
      }}
    />
  );
};

export default VideoPlayer;
