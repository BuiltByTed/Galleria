/**
 * Content Modal Component
 * Main modal orchestrator for displaying photos and videos
 * Combines all sub-components
 */

import React, { useRef, useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { API_URL } from '../../config';
import { trackPhotoNavigation, trackPhotoDownload, trackModalClose } from '../../utils/analytics';
import { fetchWithRateLimitCheck } from '../../utils/fetchWrapper';
import { SITE_URL, cacheBustValue } from '../../config';
import { Photo, ExifData } from './types';
import ModalControls from './ModalControls';
import InfoPanel from './InfoPanel';
import ImageCanvas from './ImageCanvas';
import ModalNavigation from './ModalNavigation';
import './PhotoModal.css';
import { error as logError } from '../../utils/logger';

// Lazy load VideoPlayer (includes hls.js which is 300KB+)
const VideoPlayer = lazy(() => import('./VideoPlayer'));


interface ContentModalProps {
  selectedPhoto: Photo;
  album: string;
  currentIndex: number;
  totalPhotos: number;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  onClose: () => void;
  clickedVideo?: boolean; // Whether user clicked a video (vs navigated to it)
  secretKey?: string; // For share link access
  isHomepage?: boolean; // Whether we're on the homepage
}

const AUTOPLAY_INTERVAL_MS = 5000;

const ContentModal: React.FC<ContentModalProps> = ({
  selectedPhoto,
  album,
  currentIndex: _currentIndex, // Unused but kept for future UI features
  totalPhotos: _totalPhotos, // Unused but kept for future UI features
  onNavigatePrev,
  onNavigateNext,
  onClose,
  clickedVideo: _clickedVideo = false, // Unused - videos now always show player directly
  secretKey,
  isHomepage = false,
}) => {
  // Modal-specific state
  const [modalImageLoaded, setModalImageLoaded] = useState(false);
  const [showModalImage, setShowModalImage] = useState(false);
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [exifData, setExifData] = useState<ExifData | null>(null);
  const [loadingExif, setLoadingExif] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAutoplay, setIsAutoplay] = useState(false);
  const [isHoverPaused, setIsHoverPaused] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [showNavigationHint, setShowNavigationHint] = useState(
    () => !localStorage.getItem('hideNavigationHint')
  );
  const [siteName, setSiteName] = useState<string>('Galleria');
  
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const modalOpenTimeRef = useRef<number | null>(Date.now());
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | null>(null);

  // For image URLs, don't include query strings to improve caching (especially on iOS)
  const imageQueryString = ``;
  
  // Update URL with photo parameter
  const updateURLWithPhoto = useCallback((photo: Photo) => {
    const filename = photo.id.split('/').pop();
    const baseUrl = isHomepage 
      ? '/' 
      : `/album/${encodeURIComponent(photo.album)}`;
    const newUrl = `${baseUrl}?photo=${encodeURIComponent(filename || '')}`;
    window.history.replaceState(null, '', newUrl);
  }, [isHomepage]);

  // Fetch branding data on mount
  useEffect(() => {
    const fetchBranding = async () => {
      try {
        const res = await fetchWithRateLimitCheck(`${API_URL}/api/branding`);
        if (res.ok) {
          const data = await res.json();
          setSiteName(data.siteName || 'Galleria');
        }
      } catch (err) {
        logError('Failed to fetch branding:', err);
      }
    };
    fetchBranding();
  }, []);

  // Get permalink for photo
  const getPhotoPermalink = useCallback((photo: Photo) => {
    const filename = photo.id.split('/').pop();
    const baseUrl = isHomepage 
      ? '/' 
      : `/album/${encodeURIComponent(photo.album)}`;
    return `${SITE_URL}${baseUrl}?photo=${encodeURIComponent(filename || '')}`;
  }, [isHomepage]);


  // Reset state when photo changes
  useEffect(() => {
    setModalImageLoaded(false);
    setShowModalImage(false);
    setThumbnailLoaded(false);
    setExifData(null);
    setIsVideoPlaying(false);
    modalOpenTimeRef.current = Date.now();
    
    // Update URL with photo parameter
    updateURLWithPhoto(selectedPhoto);
  }, [selectedPhoto.id, updateURLWithPhoto]);


  // Handle thumbnail load
  const handleThumbnailLoad = useCallback(() => {
    setThumbnailLoaded(true);
  }, []);

  // Calculate container dimensions based on media aspect ratio
  useEffect(() => {
    const updateContainerDimensions = () => {
      const container = mediaContainerRef.current;
      if (!container) return;

      // Get media element (img or video)
      const img = container.querySelector('img');
      const video = container.querySelector('video');

      let aspectRatio: number | null = null;

      if (img && img.naturalWidth && img.naturalHeight) {
        aspectRatio = img.naturalWidth / img.naturalHeight;
      } else if (video && video.videoWidth && video.videoHeight) {
        aspectRatio = video.videoWidth / video.videoHeight;
      }

      if (!aspectRatio) return;

      // Get max available space
      const maxWidth = window.innerWidth - 20;
      const maxHeight = window.innerHeight - 100;

      // Calculate dimensions based on aspect ratio
      const widthBasedHeight = maxWidth / aspectRatio;
      const heightBasedWidth = maxHeight * aspectRatio;

      // Determine which constraint is hit first
      if (heightBasedWidth <= maxWidth) {
        // Height is the limiting factor
        setContainerHeight(maxHeight);
        setContainerWidth(heightBasedWidth);
      } else {
        // Width is the limiting factor
        setContainerWidth(maxWidth);
        setContainerHeight(widthBasedHeight);
      }
    };

    // Set up listeners
    const img = mediaContainerRef.current?.querySelector('img');
    const video = mediaContainerRef.current?.querySelector('video');

    if (img) {
      img.addEventListener('load', updateContainerDimensions);
    }
    if (video) {
      video.addEventListener('loadedmetadata', updateContainerDimensions);
      video.addEventListener('resize', updateContainerDimensions);
    }
    window.addEventListener('resize', updateContainerDimensions);

    // Initial calculation
    updateContainerDimensions();

    return () => {
      if (img) {
        img.removeEventListener('load', updateContainerDimensions);
      }
      if (video) {
        video.removeEventListener('loadedmetadata', updateContainerDimensions);
        video.removeEventListener('resize', updateContainerDimensions);
      }
      window.removeEventListener('resize', updateContainerDimensions);
    };
  }, [selectedPhoto.id, thumbnailLoaded]);

  // Helper function to update meta tags
  const updateMetaTag = useCallback((attribute: string, key: string, content: string) => {
    let element = document.querySelector(`meta[${attribute}="${key}"]`) as HTMLMetaElement;
    
    if (!element) {
      element = document.createElement('meta');
      element.setAttribute(attribute, key);
      document.head.appendChild(element);
    }
    
    element.setAttribute('content', content);
  }, []);

  // Update page title and meta tags when photo changes
  useEffect(() => {
    if (selectedPhoto && selectedPhoto.title) {
      const pageTitle = `${selectedPhoto.title} - ${siteName}`;
      const photoUrl = getPhotoPermalink(selectedPhoto);
      const imageUrl = `${API_URL}${selectedPhoto.modal}`;
      
      // Update document title
      document.title = pageTitle;
      
      // Update meta tags for social media sharing
      updateMetaTag('property', 'og:title', pageTitle);
      updateMetaTag('property', 'og:image', imageUrl);
      updateMetaTag('property', 'og:url', photoUrl);
      updateMetaTag('property', 'og:type', 'article');
      updateMetaTag('name', 'twitter:title', pageTitle);
      updateMetaTag('name', 'twitter:image', imageUrl);
      updateMetaTag('name', 'twitter:card', 'summary_large_image');
      updateMetaTag('name', 'description', selectedPhoto.title);
      updateMetaTag('property', 'og:description', selectedPhoto.title);
      updateMetaTag('name', 'twitter:description', selectedPhoto.title);
    } else if (selectedPhoto) {
      // If no title, just show site name
      const tempTitle = `${siteName}`;
      document.title = tempTitle;
    }
  }, [selectedPhoto, siteName, getPhotoPermalink, updateMetaTag]);
  
  // Restore default title only when modal closes (component unmounts)
  useEffect(() => {
    return () => {
      // Restore appropriate title based on context
      if (album === 'homepage') {
        document.title = `${siteName} - Galleria`;
      } else {
        // On an album page, restore to "Album Name - Site Name"
        const albumTitleCase = album.charAt(0).toUpperCase() + album.slice(1);
        document.title = `${albumTitleCase} - ${siteName}`;
      }
    };
  }, [siteName, album]);

  // Handle copy link
  const handleCopyLink = useCallback(async (photo: Photo) => {
    const permalink = getPhotoPermalink(photo);
    try {
      await navigator.clipboard.writeText(permalink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      logError('Failed to copy link:', err);
    }
  }, [getPhotoPermalink]);

  // Handle close
  const handleClose = useCallback(async () => {
    if (selectedPhoto && modalOpenTimeRef.current) {
      const viewDuration = Date.now() - modalOpenTimeRef.current;
      trackModalClose(selectedPhoto.id, selectedPhoto.album, selectedPhoto.title, viewDuration);
    }
    
    // Exit fullscreen if active
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        logError('Error exiting fullscreen:', err);
      }
    }
    
    // Clear URL parameter
    const baseUrl = album === 'homepage' ? '/' : `/album/${album}`;
    window.history.replaceState(null, '', baseUrl);
    
    // Restore body scroll
    const scrollY = document.body.style.top;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, parseInt(scrollY || '0') * -1);
    
    onClose();
  }, [selectedPhoto, album, onClose]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } catch (err) {
        logError('Error attempting to enable fullscreen:', err);
      }
    } else {
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } catch (err) {
        logError('Error attempting to exit fullscreen:', err);
      }
    }
  }, []);

  // Toggle slideshow autoplay
  const toggleAutoplay = useCallback(() => {
    setIsAutoplay((prev) => !prev);
  }, []);

  // Fetch EXIF data
  const fetchExifData = useCallback(async (photo: Photo) => {
    if (exifData) return;
    
    setLoadingExif(true);
    try {
      const filename = photo.id.split('/').pop();
      const exifQueryParams = new URLSearchParams(window.location.search);
      exifQueryParams.delete('photo');
      if (secretKey) {
        exifQueryParams.set('key', secretKey);
      }
      exifQueryParams.set('i', String(cacheBustValue));
      const exifQueryString = exifQueryParams.toString();
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/photos/${photo.album}/${filename}/exif${exifQueryString ? `?${exifQueryString}` : ''}`
      );
      
      if (res.ok) {
        const data = await res.json();
        setExifData(data);
      } else {
        logError('Failed to load EXIF data');
        setExifData({ error: 'Failed to load' });
      }
    } catch (err) {
      logError('Error fetching EXIF:', err);
      setExifData({ error: 'Failed to load' });
    } finally {
      setLoadingExif(false);
    }
  }, [exifData, secretKey]);

  // Toggle info panel
  const handleToggleInfo = useCallback(() => {
    const newShowInfo = !showInfo;
    setShowInfo(newShowInfo);
    if (newShowInfo && selectedPhoto && !exifData && !loadingExif) {
      fetchExifData(selectedPhoto);
    }
  }, [showInfo, selectedPhoto, exifData, loadingExif, fetchExifData]);

  // Handle download
  const handleDownload = useCallback(async (photo: Photo) => {
    if (photo.downloads_enabled === false || !photo.download) {
      return;
    }

    const originalFilename = photo.id.split('/').pop() || 'photo.jpg';
    const fileExtension = originalFilename.substring(originalFilename.lastIndexOf('.'));
    
    // Create filename as "Site Name - Photo Title.jpg" or fallback to original
    let downloadFilename = originalFilename;
    if (photo.title) {
      // Sanitize title for filename (remove special characters)
      const sanitizedTitle = photo.title.replace(/[/\\?%*:|"<>]/g, '-');
      downloadFilename = `${siteName} - ${sanitizedTitle}${fileExtension}`;
    }
    
    try {
      const response = await fetch(`${API_URL}${photo.download}${imageQueryString}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = downloadFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      URL.revokeObjectURL(blobUrl);
      
      trackPhotoDownload(photo.id, photo.album, photo.title);
    } catch (err) {
      logError('Download failed:', err);
      window.open(`${API_URL}${photo.download}${imageQueryString}`, '_blank');
    }
  }, [imageQueryString, siteName]);

  // Navigate to previous photo
  const handleNavigatePrev = useCallback(() => {
    const viewDuration = modalOpenTimeRef.current ? Date.now() - modalOpenTimeRef.current : undefined;
    
    setExifData(null);
    setModalImageLoaded(false);
    setShowModalImage(false);
    setThumbnailLoaded(false);
    modalOpenTimeRef.current = Date.now();
    
    // Parent handles the actual photo change
    onNavigatePrev();
    
    setTimeout(() => {
      trackPhotoNavigation('previous', selectedPhoto.id, selectedPhoto.album, selectedPhoto.title, viewDuration);
    }, 0);
  }, [selectedPhoto, onNavigatePrev]);

  // Navigate to next photo
  const handleNavigateNext = useCallback(() => {
    const viewDuration = modalOpenTimeRef.current ? Date.now() - modalOpenTimeRef.current : undefined;
    
    setExifData(null);
    setModalImageLoaded(false);
    setShowModalImage(false);
    setThumbnailLoaded(false);
    modalOpenTimeRef.current = Date.now();
    
    // Parent handles the actual photo change
    onNavigateNext();
    
    setTimeout(() => {
      trackPhotoNavigation('next', selectedPhoto.id, selectedPhoto.album, selectedPhoto.title, viewDuration);
    }, 0);
  }, [selectedPhoto, onNavigateNext]);

  // Handle modal content click
  const handleModalContentClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    
    // Check if clicking on interactive elements that should NOT close the modal
    const isDirectlyOnImage = target.tagName === 'IMG';
    const isDirectlyOnVideo = target.tagName === 'VIDEO';
    const isOnButton = target.closest('button') || target.closest('.modal-navigation-button');
    const isOnInfoPanel = target.closest('.modal-info-panel');
    const isOnControls = target.closest('.modal-controls-top');
    const isOnImageTitle = target.closest('.modal-image-title');
    const isOnVideoPlayer = target.closest('.modal-video-player');
    
    // If clicking on video or video player, do nothing - let video handle its own events
    if (isOnVideoPlayer || isDirectlyOnVideo) {
      // Don't stop propagation, don't prevent default - video needs full control
      return;
    }
    
    // If clicking on any other interactive element, prevent modal close
    if (isOnButton || isOnInfoPanel || isOnControls || isOnImageTitle) {
      e.stopPropagation();
      return;
    }
    
    // If clicking directly on the image, don't close modal
    if (isDirectlyOnImage) {
      e.stopPropagation();
      
      // Close info panel if clicking on image while it's open
      if (showInfo) {
        setShowInfo(false);
      }
      return;
    }
    
    // For any other click (sides, above, below, background), close the modal
    // Don't stop propagation - let it bubble to the outer modal div which calls handleClose
  }, [showInfo]);

  // Handle touch gestures (swipe to navigate)
  const handleTouchStart = (e: React.TouchEvent) => {
    // Don't capture touches on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('video, .modal-video-player, button, .modal-controls-top, .modal-info-panel')) {
      return;
    }
    
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    // Don't process swipes on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('video, .modal-video-player, button, .modal-controls-top, .modal-info-panel')) {
      return;
    }
    
    if (!touchStartX.current || !touchStartY.current) return;

    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const deltaX = touchEndX - touchStartX.current;
    const deltaY = touchEndY - touchStartY.current;

    // Only trigger swipe if it's horizontal and significant
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX > 0) {
        handleNavigatePrev();
      } else {
        handleNavigateNext();
      }
    }

    touchStartX.current = null;
    touchStartY.current = null;
  };

  // Auto-fetch EXIF data when navigating if info panel is open
  useEffect(() => {
    if (showInfo && selectedPhoto && !exifData && !loadingExif) {
      fetchExifData(selectedPhoto);
    }
  }, [selectedPhoto, showInfo, exifData, loadingExif, fetchExifData]);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Detect video play/pause so autoplay holds while a video is playing
  useEffect(() => {
    const container = mediaContainerRef.current;
    if (!container) return;

    const onPlay = () => setIsVideoPlaying(true);
    const onPauseOrEnded = () => setIsVideoPlaying(false);

    container.addEventListener('play', onPlay, true);
    container.addEventListener('pause', onPauseOrEnded, true);
    container.addEventListener('ended', onPauseOrEnded, true);

    return () => {
      container.removeEventListener('play', onPlay, true);
      container.removeEventListener('pause', onPauseOrEnded, true);
      container.removeEventListener('ended', onPauseOrEnded, true);
    };
  }, [selectedPhoto.id]);

  // Slideshow autoplay: fixed interval, reuse next handler; hold on hover/focus or video play
  useEffect(() => {
    if (!isAutoplay || isHoverPaused || isVideoPlaying) return;

    const timerId = window.setInterval(() => {
      handleNavigateNext();
    }, AUTOPLAY_INTERVAL_MS);

    return () => window.clearInterval(timerId);
  }, [isAutoplay, isHoverPaused, isVideoPlaying, handleNavigateNext]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
    };
  }, []);

  // Note: Thumbnail preloading removed since we no longer receive the full photos array
  // Thumbnails are loaded on-demand and browser caching + server-side caching handles the rest

  // Preload modal image after delay (skip for videos)
  useEffect(() => {
    if (selectedPhoto && !showModalImage && selectedPhoto.media_type !== 'video') {
      const timer = setTimeout(() => {
        const img = new Image();
        const modalUrl = `${API_URL}${selectedPhoto.modal}${imageQueryString}`;

        img.onload = () => {
          // Add image to DOM first with opacity: 0
          setShowModalImage(true);
          // Then after a brief delay, fade it in
          requestAnimationFrame(() => {
            setTimeout(() => {
              setModalImageLoaded(true);
            }, 10);
          });
        };

        img.onerror = () => {
          logError('Modal image preload failed');
        };

        img.src = modalUrl;
      }, 10);

      return () => clearTimeout(timer);
    }
  }, [selectedPhoto, showModalImage, imageQueryString]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "ArrowLeft") {
        if (showNavigationHint) {
          setShowNavigationHint(false);
          localStorage.setItem('hideNavigationHint', 'true');
        }
        handleNavigatePrev();
      } else if (e.key === "ArrowRight") {
        if (showNavigationHint) {
          setShowNavigationHint(false);
          localStorage.setItem('hideNavigationHint', 'true');
        }
        handleNavigateNext();
      } else if (e.key === " " || e.code === "Space") {
        // Space toggles slideshow; leave Escape to close; don't steal from video/inputs
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.closest("input, textarea, select, [contenteditable='true']") ||
            target.closest("video, .modal-video-player"))
        ) {
          return;
        }
        e.preventDefault();
        toggleAutoplay();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, handleNavigatePrev, handleNavigateNext, showNavigationHint, toggleAutoplay]);

  return (
    <div 
      className={`modal ${isFullscreen ? 'fullscreen' : ''}`} 
      onClick={(e) => {
        // Only close if clicking directly on the modal background
        const target = e.target as HTMLElement;
        if (target.classList.contains('modal')) {
          handleClose();
        }
      }}
      onTouchEnd={(e) => {
        // Only close modal if touching the modal background
        const target = e.target as HTMLElement;
        if (target.classList.contains('modal')) {
          handleClose();
        }
      }}
    >
      <div
        key={selectedPhoto.id}
        className="modal-content"
        onClick={handleModalContentClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div className="modal-container" ref={imageContainerRef}>
          <div 
            className="modal-media-container"
            ref={mediaContainerRef}
            style={{
              width: containerWidth ? `${containerWidth}px` : undefined,
              height: containerHeight ? `${containerHeight}px` : undefined
            }}
            onMouseEnter={() => setIsHoverPaused(true)}
            onMouseLeave={() => setIsHoverPaused(false)}
            onFocusCapture={() => setIsHoverPaused(true)}
            onBlurCapture={(e) => {
              const next = e.relatedTarget as Node | null;
              if (!e.currentTarget.contains(next)) {
                setIsHoverPaused(false);
              }
            }}
          >
            <ModalControls
              show={thumbnailLoaded}
              showInfo={showInfo}
              copiedLink={copiedLink}
              isFullscreen={isFullscreen}
              isAutoplay={isAutoplay}
              onToggleInfo={handleToggleInfo}
              onCopyLink={handleCopyLink}
              onDownload={handleDownload}
              onToggleAutoplay={toggleAutoplay}
              onToggleFullscreen={toggleFullscreen}
              onClose={handleClose}
              selectedPhoto={selectedPhoto}
              isVideo={selectedPhoto.media_type === 'video'}
              style={{}}
            />

            <InfoPanel
              show={showInfo}
              photo={selectedPhoto}
              exifData={exifData}
              loadingExif={loadingExif}
              imageTitle={selectedPhoto.title}
              secretKey={secretKey}
              style={{}}
            />

            {selectedPhoto.media_type === 'video' ? (
              /* Show video player directly - NO event handlers on container */
              <div className="modal-photo-container">
                <div 
                  className="modal-video-player"
                  onClick={(e) => e.stopPropagation()}
                  onTouchEnd={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                >
                  <Suspense fallback={<div className="photo-loading-overlay"><div className="photo-loading-spinner"></div></div>}>
                    <VideoPlayer
                      album={selectedPhoto.album}
                      filename={selectedPhoto.id.includes('/') ? selectedPhoto.id.split('/').pop() || selectedPhoto.id : selectedPhoto.id}
                      videoTitle={selectedPhoto.title || selectedPhoto.id}
                      posterUrl={selectedPhoto.thumbnail}
                      onLoadStart={() => setThumbnailLoaded(false)}
                      onLoaded={() => {
                        setThumbnailLoaded(true);
                        setModalImageLoaded(true);
                      }}
                      secretKey={secretKey}
                    />
                  </Suspense>
                </div>
              </div>
            ) : (
              <div className="modal-photo-container">
                <ImageCanvas
                  photo={selectedPhoto}
                  apiUrl={API_URL}
                  imageQueryString={imageQueryString}
                  modalImageLoaded={modalImageLoaded}
                  showModalImage={showModalImage}
                  onThumbnailLoad={handleThumbnailLoad}
                />
              </div>
            )}

            <ModalNavigation
              showHint={showNavigationHint}
              onPrevious={handleNavigatePrev}
              onNext={handleNavigateNext}
              style={{}}
            />

            {/* Image Title */}
            {selectedPhoto.title && thumbnailLoaded && (
              <div className="modal-image-title">
                {selectedPhoto.title}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContentModal;
