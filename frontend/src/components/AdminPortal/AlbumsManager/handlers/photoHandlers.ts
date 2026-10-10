/**
 * Photo Management Handlers
 * Handles photo deletion, shuffle functionality, and retry operations
 */

import { TFunction } from 'i18next';
import { fetchWithRateLimitCheck } from '../../../../utils/fetchWrapper';
import { API_URL } from '../../../../config';
import { 
  trackPhotoDeleted,
  trackPhotoMoved,
  trackPhotoRetryOptimization, 
  trackPhotoRetryAI 
} from '../../../../utils/analytics';
import { ConfirmModalConfig, Photo } from '../types';


interface PhotoHandlersProps {
  selectedAlbum: string | null;
  loadPhotos: (albumName: string) => Promise<void>;
  shufflePhotos: () => void;
  setMessage: (message: { type: 'success' | 'error'; text: string }) => void;
  showConfirmation: (config: ConfirmModalConfig) => void;
  setAlbumPhotos: React.Dispatch<React.SetStateAction<Photo[]>>;
  setOriginalPhotoOrder: React.Dispatch<React.SetStateAction<Photo[]>>;
  setDeletingPhotoId: React.Dispatch<React.SetStateAction<string | null>>;
  shuffleIntervalRef: React.MutableRefObject<NodeJS.Timeout | null>;
  speedupTimeoutsRef: React.MutableRefObject<NodeJS.Timeout[]>;
  setIsShuffling: React.Dispatch<React.SetStateAction<boolean>>;
  loadAlbums?: () => Promise<void> | void;
  t: TFunction;
}

export const createPhotoHandlers = (props: PhotoHandlersProps) => {
  const { /* selectedAlbum, */ loadPhotos, shufflePhotos, setMessage, showConfirmation, setAlbumPhotos, setOriginalPhotoOrder, setDeletingPhotoId, shuffleIntervalRef, speedupTimeoutsRef, setIsShuffling, loadAlbums, t } = props;
  
  // Retry optimization for a photo
  const handleRetryOptimization = async (album: string, filename: string): Promise<void> => {
    try {
      setMessage({ type: 'success', text: t('albumsManager.retryingOptimization', { filename }) });
      
      // Clear the error state immediately
      setAlbumPhotos((prev: Photo[]) =>
        prev.map((photo: Photo) =>
          photo.id === `${album}/${filename}`
            ? { ...photo, optimizationError: undefined }
            : photo
        )
      );
      
      // Call the optimization endpoint for this specific photo
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/image-optimization/retry-photo`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ album, filename }),
          credentials: 'include',
        }
      );
      
      if (!res.ok) {
        throw new Error('Failed to retry optimization');
      }
      
      trackPhotoRetryOptimization(album, `${album}/${filename}`);
      setMessage({ type: 'success', text: t('albumsManager.optimizationRestarted', { filename }) });
      
      // Reload photos to get the updated version
      await loadPhotos(album);
    } catch (err) {
      setMessage({ type: 'error', text: t('albumsManager.failedToRetryOptimization') });
      // Restore error state
      setAlbumPhotos((prev: Photo[]) =>
        prev.map((photo: Photo) =>
          photo.id === `${album}/${filename}`
            ? { ...photo, optimizationError: 'Optimization failed' }
            : photo
        )
      );
    }
  };
  
  // Retry AI title generation for a photo
  const handleRetryAI = async (album: string, filename: string): Promise<void> => {
    try {
      setMessage({ type: 'success', text: t('albumsManager.retryingAIGeneration', { filename }) });
      
      // Clear the error state immediately
      setAlbumPhotos((prev: Photo[]) =>
        prev.map((photo: Photo) =>
          photo.id === `${album}/${filename}`
            ? { ...photo, aiError: undefined }
            : photo
        )
      );
      
      // Call the AI title generation endpoint for this specific photo
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/ai-titles/retry-photo`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ album, filename }),
          credentials: 'include',
        }
      );
      
      if (!res.ok) {
        throw new Error('Failed to retry AI title generation');
      }
      
      trackPhotoRetryAI(album, `${album}/${filename}`);
      setMessage({ type: 'success', text: t('albumsManager.aiGenerationRestarted', { filename }) });
      
      // Reload photos to get the updated version
      await loadPhotos(album);
    } catch (err) {
      setMessage({ type: 'error', text: t('albumsManager.failedToRetryAIGeneration') });
      // Restore error state
      setAlbumPhotos((prev: Photo[]) =>
        prev.map((photo: Photo) =>
          photo.id === `${album}/${filename}`
            ? { ...photo, aiError: 'AI generation failed' }
            : photo
        )
      );
    }
  };

  const handleDeletePhoto = async (
    album: string,
    filename: string,
    photoTitle: string = '',
    thumbnail: string = '',
    mediaType: 'photo' | 'video' = 'photo'
  ): Promise<void> => {
    const isVideo = mediaType === 'video';
    showConfirmation({
      message: '', // Not used when photo is provided
      confirmText: isVideo ? t('albumsManager.deleteVideo') : t('albumsManager.deletePhoto'),
      isDanger: true,
      photo: thumbnail ? {
        thumbnail,
        title: photoTitle,
        filename
      } : undefined,
      onConfirm: async () => {
        // Trigger CRT animation by setting the photo ID
        const photoId = `${album}/${filename}`;
        setDeletingPhotoId(photoId);
        
        // Wait for CRT animation to complete
        await new Promise(resolve => setTimeout(resolve, 200));
        
        try {
          const res = await fetchWithRateLimitCheck(
            `${API_URL}/api/albums/${encodeURIComponent(album)}/photos/${encodeURIComponent(filename)}`,
            {
              method: 'DELETE',
              credentials: 'include',
            }
          );

          if (res.ok) {
            setMessage({ type: 'success', text: t('albumsManager.photoDeleted') });
            trackPhotoDeleted(album, filename, photoTitle || filename);
            
            // Remove photo from both local state AND original order
            // This prevents deleted photos from reappearing when user hits "Cancel"
            setAlbumPhotos((prev: Photo[]) => prev.filter((p: Photo) => p.id !== photoId));
            setOriginalPhotoOrder((prev: Photo[]) => prev.filter((p: Photo) => p.id !== photoId));
            
            // Clear deleting state immediately - this triggers FLIP animation
            setDeletingPhotoId(null);
          } else {
            const error = await res.json();
            setMessage({ type: 'error', text: error.error || t('albumsManager.failedToDeletePhoto') });
            setDeletingPhotoId(null); // Clear deleting state on error
          }
        } catch (err) {
          setMessage({ type: 'error', text: t('albumsManager.networkErrorOccurred') });
          setDeletingPhotoId(null); // Clear deleting state on error
        }
      },
    });
  };

  /**
   * Move a single photo/video to another album.
   * Returns true on success so callers can close modals.
   */
  const handleMovePhoto = async (
    sourceAlbum: string,
    filename: string,
    destinationAlbum: string,
    photoTitle: string = ''
  ): Promise<boolean> => {
    const photoId = `${sourceAlbum}/${filename}`;
    try {
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/albums/${encodeURIComponent(sourceAlbum)}/photos/${encodeURIComponent(filename)}/move`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destinationAlbum }),
          credentials: 'include',
        }
      );

      if (!res.ok) {
        let errorText = t('albumsManager.failedToMovePhoto');
        try {
          const body = await res.json();
          if (body?.error) errorText = body.error;
        } catch {
          // ignore parse errors
        }
        setMessage({ type: 'error', text: errorText });
        return false;
      }

      setAlbumPhotos((prev: Photo[]) => prev.filter((p: Photo) => p.id !== photoId));
      setOriginalPhotoOrder((prev: Photo[]) => prev.filter((p: Photo) => p.id !== photoId));
      trackPhotoMoved(sourceAlbum, destinationAlbum, photoId, photoTitle || filename);
      setMessage({
        type: 'success',
        text: t('albumsManager.photoMoved', { album: destinationAlbum }),
      });
      if (loadAlbums) {
        await loadAlbums();
      }
      return true;
    } catch {
      setMessage({ type: 'error', text: t('albumsManager.networkErrorOccurred') });
      return false;
    }
  };

  // Shuffle handlers
  const handleShuffleClick = (): void => {
    // Hide any visible overlays when shuffle happens
    const photoElements = document.querySelectorAll('.admin-photo-item');
    photoElements.forEach((el) => {
      el.classList.remove('show-overlay');
    });
    
    shufflePhotos(); // Full shuffle on single click
  };

  const handleShuffleStart = (): void => {
    // Don't start if already shuffling
    if (shuffleIntervalRef.current) return;
    
    // Add 500ms delay before starting continuous shuffle
    // This makes it easier to distinguish between a click and a hold
    const delayTimeout = setTimeout(() => {
      setIsShuffling(true);
      
      // Get the shuffle button to update its animation speed
      const shuffleButton = document.querySelector('.btn-shuffle-order') as HTMLElement;
      
      // Get the photo container (either grid or list)
      const photoContainer = document.querySelector('.photos-grid, .photos-list') as HTMLElement;
      const isGridView = photoContainer?.classList.contains('photos-grid');
      
      // Add zoom class to all photos during shuffle
      const photoElements = document.querySelectorAll('.admin-photo-item, .list-item');
      
      photoElements.forEach((el) => {
        el.classList.add('shuffling-active');
        // Hide any visible overlays when shuffle starts
        el.classList.remove('show-overlay');
      });
      
      // Get album size for calculations
      const albumSize = photoElements.length;
    
    // Calculate speed multiplier based on album size
    // Speed increases linearly with album size: speed = base_speed * (num_photos / 20)
    // Since interval is inverse of speed: interval = base_interval / (num_photos / 20)
    const speedMultiplier = 20 / Math.max(albumSize, 1); // Prevent division by zero
    
    // Start continuous shuffling with progressive speed increase
    let currentInterval = 100 * speedMultiplier; // Adjust base speed by album size
    let currentAnimationSpeed = 0.4; // Start with 0.4s for rainbow rotation
    
    // Update rainbow rotation speed
    if (shuffleButton) {
      shuffleButton.style.setProperty('--animation-speed', `${currentAnimationSpeed}s`);
    }
    
    const startShuffling = (interval: number) => {
      if (shuffleIntervalRef.current) {
        clearInterval(shuffleIntervalRef.current);
      }
      
      // On first call, apply grid scaling (only for grid view, not list view)
      if (!shuffleIntervalRef.current && photoContainer && isGridView) {
        // Get current number of columns in the grid
        const gridComputedStyle = window.getComputedStyle(photoContainer);
        const gridWidth = photoContainer.clientWidth;
        const firstPhoto = photoContainer.querySelector('.admin-photo-item') as HTMLElement;
        
        let currentColumns = 5; // Fallback
        if (firstPhoto) {
          const photoWidth = firstPhoto.offsetWidth;
          const gap = parseFloat(gridComputedStyle.gap) || 16;
          currentColumns = Math.round(gridWidth / (photoWidth + gap));
        }
        
        // Calculate optimal column count to fit up to 100 images in view
        let targetColumns = 5; // Base minimum
        
        if (albumSize > 30) {
          // More photos = more columns
          // Target: 100 photos should show ~12 columns
          // Formula: targetColumns = 5 + Math.floor((albumSize - 30) / 10)
          targetColumns = Math.min(20, 5 + Math.floor((albumSize - 30) / 10));
        }
        
        // ONLY scale down (increase columns), never up (decrease columns)
        const columnCount = Math.max(currentColumns, targetColumns);
        
        // Only apply shuffling-grid if we're actually adding columns
        if (columnCount > currentColumns) {
          photoContainer.classList.add('shuffling-grid');
          photoContainer.style.setProperty('--shuffle-columns', columnCount.toString());
        }
      }
      
      shuffleIntervalRef.current = setInterval(() => {
        // Shuffle one photo at a time (swap two random photos)
        setAlbumPhotos((currentPhotos) => {
          const newOrder = [...currentPhotos];
          // Pick two random indices
          const i = Math.floor(Math.random() * newOrder.length);
          const j = Math.floor(Math.random() * newOrder.length);
          
          // Swap them
          if (i !== j) {
            [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
          }
          
          return newOrder;
        });
      }, interval);
    };
    
    startShuffling(currentInterval);
    
    // Speed up by 20% every 500ms for 3 seconds (6 iterations)
    for (let i = 1; i <= 6; i++) {
      const timeout = setTimeout(() => {
        currentInterval = currentInterval * 0.8; // Reduce interval by 20% = 20% faster
        currentAnimationSpeed = currentAnimationSpeed * 0.8; // Speed up rainbow rotation too
        
        if (shuffleButton) {
          shuffleButton.style.setProperty('--animation-speed', `${currentAnimationSpeed}s`);
        }
        
        startShuffling(currentInterval);
      }, i * 500);
      speedupTimeoutsRef.current.push(timeout);
    }
    }, 150); // 100ms delay before starting continuous shuffle
    
    // Store the delay timeout so it can be cancelled if button is released early
    speedupTimeoutsRef.current.push(delayTimeout);
  };

  const handleShuffleEnd = (): void => {
    // Clear all speedup timeouts
    speedupTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
    speedupTimeoutsRef.current = [];
    
    // Stop shuffling
    if (shuffleIntervalRef.current) {
      clearInterval(shuffleIntervalRef.current);
      shuffleIntervalRef.current = null;
    }
    
    setIsShuffling(false);
    
    // Reset rainbow rotation speed back to normal
    const shuffleButton = document.querySelector('.btn-shuffle-order') as HTMLElement;
    if (shuffleButton) {
      shuffleButton.style.removeProperty('--animation-speed');
    }
    
    // Reset grid/list layout
    const photoContainer = document.querySelector('.photos-grid, .photos-list') as HTMLElement;
    if (photoContainer) {
      photoContainer.classList.remove('shuffling-grid');
      photoContainer.style.removeProperty('--shuffle-columns');
    }
    
    // Remove shuffling class from photos (both grid and list items)
    setTimeout(() => {
      const photoElements = document.querySelectorAll('.admin-photo-item, .list-item');
      photoElements.forEach((el) => {
        el.classList.remove('shuffling-active');
      });
    }, 200);
  };

  const handleShuffleMouseDown = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    handleShuffleStart();
  };

  const handleShuffleMouseUp = (): void => {
    handleShuffleEnd();
  };

  const handleShuffleMouseLeave = (): void => {
    handleShuffleEnd();
  };

  return {
    handleDeletePhoto,
    handleMovePhoto,
    handleRetryOptimization,
    handleRetryAI,
    handleShuffleClick,
    handleShuffleStart,
    handleShuffleEnd,
    handleShuffleMouseDown,
    handleShuffleMouseUp,
    handleShuffleMouseLeave,
  };
};

