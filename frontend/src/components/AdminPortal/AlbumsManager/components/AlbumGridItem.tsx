/**
 * Unified Album Grid Item Component
 * Handles all photo/video states: queued, uploading, optimizing, generating-title, complete, error
 * Supports both uploading images/videos and completed photos/videos with drag-and-drop
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../../../config';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Photo, UploadingImage } from '../types';
import { cacheBustValue } from '../../../../config';
import { EditDocumentIcon, TrashIcon, HourglassIcon, VideoIcon, FolderArrowIcon } from '../../../icons';
import { info } from '../../../../utils/logger';


interface AlbumGridItemProps {
  // For uploading images
  uploadingImage?: UploadingImage;
  uploadingIndex?: number;
  
  // For completed photos
  photo?: Photo;
  
  // Actions
  onEdit?: (photo: Photo) => void;
  onDelete?: (album: string, filename: string, title: string, thumbnail: string, mediaType?: 'photo' | 'video') => void;
  onMove?: (album: string, filename: string, title: string, thumbnail: string, mediaType?: 'photo' | 'video') => void;
  onRetryOptimization?: (album: string, filename: string) => void;
  onRetryAI?: (album: string, filename: string) => void;
  onRetryUpload?: (filename: string, albumName: string) => void;
  
  // State
  deletingPhotoId?: string | null;
  activeOverlayId?: string | null;
  setActiveOverlayId?: (id: string | null) => void;
  selectedAlbum?: string;
  
  // Permissions
  canEdit: boolean;
}

const AlbumGridItem: React.FC<AlbumGridItemProps> = ({
  uploadingImage,
  uploadingIndex,
  photo,
  onEdit,
  onDelete,
  onMove,
  onRetryOptimization,
  onRetryAI,
  onRetryUpload,
  deletingPhotoId,
  activeOverlayId,
  setActiveOverlayId,
  selectedAlbum,
  canEdit,
}) => {
  const { t } = useTranslation();
  const isUploading = !!uploadingImage && uploadingImage.state !== 'complete';
  const isComplete = !!photo || (uploadingImage?.state === 'complete' && uploadingImage.photo);
  
  // Get the actual photo data (either from photo prop or completed uploadingImage)
  const photoData = photo || uploadingImage?.photo;
  
  // Use either the photo ID or a unique uploading ID for sortable
  const itemId = photoData ? photoData.id : `uploading-${uploadingIndex}`;
  
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: itemId, 
    disabled: !canEdit || isUploading 
  });

  const [showOverlay, setShowOverlay] = useState(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const hasMoved = useRef(false);
  
  // Check if this photo is being deleted (for CRT animation)
  const isDeleting = photoData && deletingPhotoId === photoData.id;
  
  // Close overlay if another photo's overlay becomes active
  useEffect(() => {
    if (activeOverlayId && activeOverlayId !== itemId && showOverlay) {
      setShowOverlay(false);
    }
  }, [activeOverlayId, itemId, showOverlay]);
  
  // Clear touch tracking when drag starts
  useEffect(() => {
    if (isDragging) {
      touchStartPos.current = null;
      hasMoved.current = false;
      setShowOverlay(false);
    }
  }, [isDragging]);


  const handleTouchMove = (e: React.TouchEvent) => {
    if (isUploading || isDragging || !touchStartPos.current) return; // Don't interfere with dragging
    
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - touchStartPos.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartPos.current.y);
    
    if (deltaX > 5 || deltaY > 5) {
      hasMoved.current = true;
      setShowOverlay(false);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isUploading || isDragging) return; // Don't interfere with dragging
    
    if (touchStartPos.current && !hasMoved.current) {
      e.preventDefault();
      
      const target = e.target as HTMLElement;
      const clickedButton = target.closest('.btn-edit-photo, .btn-delete-photo, .btn-retry-photo, .btn-move-photo');
      
      if (clickedButton) {
        // Tapped a button - let the button handler deal with it
      } else if (showOverlay) {
        setShowOverlay(false);
        if (setActiveOverlayId) setActiveOverlayId(null);
      } else {
        setShowOverlay(true);
        if (setActiveOverlayId && itemId) setActiveOverlayId(itemId);
      }
    }
    touchStartPos.current = null;
    hasMoved.current = false;
  };

  const handleTouchCancel = () => {
    if (isDragging) return; // Don't interfere with dragging
    touchStartPos.current = null;
    hasMoved.current = false;
    setShowOverlay(false);
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (isUploading) return;
    const target = e.target as HTMLElement;
    if (!target.closest('.btn-edit-photo, .btn-delete-photo, .btn-retry-photo, .btn-move-photo')) {
      setShowOverlay(false);
    }
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  // Get filename for display
  const filename = photoData
    ? photoData.id.split('/').pop() || photoData.id
    : uploadingImage?.filename || '';

  // Get thumbnail URL
  const thumbnailUrl = photoData
    ? `${API_URL}${photoData.thumbnail}?i=${cacheBustValue}`
    : uploadingImage?.thumbnailUrl;

  // Use custom touch handlers on touch devices (overlay tap to show/hide)
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const useCustomTouchHandlers = isTouchDevice;
  
  const handleTouchStart = (e: React.TouchEvent) => {
    if (isUploading || isDragging) return;
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    hasMoved.current = false;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-photo-id={itemId}
      className={`admin-photo-item ${isDragging ? 'dragging' : ''} ${showOverlay ? 'show-overlay' : ''} ${isUploading ? 'uploading' : ''} ${isDeleting ? 'crt-delete' : ''}`}
      {...(useCustomTouchHandlers ? {
        onTouchStart: handleTouchStart,
        onTouchMove: handleTouchMove,
        onTouchEnd: handleTouchEnd,
        onTouchCancel: handleTouchCancel,
      } : {})}
      {...(canEdit && !isUploading ? attributes : {})}
      {...(canEdit && !isUploading ? listeners : {})}
    >
      {/* Thumbnail or placeholder */}
      {isUploading ? (
        <div className="admin-photo-thumbnail uploading-placeholder"></div>
      ) : (
        <img
          src={thumbnailUrl}
          alt=""
          className="admin-photo-thumbnail"
        />
      )}

      {/* Video indicator icon */}
      {!isUploading && photoData?.media_type === 'video' && (
        <div className="video-icon-overlay">
          <VideoIcon width="20" height="20" />
        </div>
      )}

      {/* Uploading States */}
      {isUploading && uploadingImage && (
        <>
          {uploadingImage.state === 'queued' && (
            <div className="photo-state-overlay queued">
              <HourglassIcon width="32" height="32" style={{ opacity: 0.8 }} />
              <span className="state-text">{t('sse.queued')}</span>
            </div>
          )}
          {uploadingImage.state === 'uploading' && (
            <div className="photo-state-overlay uploading">
              <div className="progress-circle">
                <svg className="progress-ring" width="60" height="60">
                  <circle
                    className="progress-ring-circle"
                    stroke="var(--primary-color)"
                    strokeWidth="4"
                    fill="transparent"
                    r="26"
                    cx="30"
                    cy="30"
                    style={{
                      strokeDasharray: `${2 * Math.PI * 26}`,
                      strokeDashoffset: `${2 * Math.PI * 26 * (1 - (uploadingImage.progress || 0) / 100)}`,
                    }}
                  />
                </svg>
                <div className="progress-percentage">{uploadingImage.progress || 0}%</div>
              </div>
              <span className="state-text">{t('sse.uploadingLabel')}</span>
            </div>
          )}
          {uploadingImage.state === 'optimizing' && (
            <div className="photo-state-overlay optimizing">
              {(uploadingImage.optimizeProgress || 0) === 0 ? (
                // Show spinner when progress is 0 (waiting/processing)
                <div className="spinner"></div>
              ) : (
                // Show progress circle when we have actual progress
                <div className="progress-circle">
                  <svg className="progress-ring" width="60" height="60">
                    <circle
                      className="progress-ring-circle"
                      stroke="var(--primary-color)"
                      strokeWidth="4"
                      fill="transparent"
                      r="26"
                      cx="30"
                      cy="30"
                      style={{
                        strokeDasharray: `${2 * Math.PI * 26}`,
                        strokeDashoffset: `${2 * Math.PI * 26 * (1 - (uploadingImage.optimizeProgress || 0) / 100)}`,
                      }}
                    />
                  </svg>
                  <div className="progress-percentage">{Math.round(uploadingImage.optimizeProgress || 0)}%</div>
                </div>
              )}
              <span className="state-text">
                {uploadingImage.videoStage 
                  ? uploadingImage.videoStage.match(/^\d+p$/) // Is it a resolution like "720p"?
                    ? `${uploadingImage.videoStage} (${Math.round(uploadingImage.videoStageProgress || 0)}%)`
                    : uploadingImage.videoStage // Show stage name for rotation/thumbnail
                  : t('sse.optimizing')}
              </span>
            </div>
          )}
          {uploadingImage.state === 'generating-title' && (
            <div className="photo-state-overlay generating-title">
              <div className="spinner"></div>
              <span className="state-text">{t('sse.generatingTitle')}</span>
            </div>
          )}
          {uploadingImage.state === 'error' && (() => {
            info(`[PhotoGridItem] Error state for ${filename}:`, {
              canEdit,
              hasRetryHandler: !!onRetryUpload,
              selectedAlbum,
              retryCount: uploadingImage.retryCount,
              showButton: canEdit && !!onRetryUpload && !!selectedAlbum
            });
            return (
              <div className="photo-state-overlay error">
                <div className="state-icon">⚠️</div>
                <span className="state-text">Error</span>
                <span className="error-message">{uploadingImage.error}</span>
                {canEdit && onRetryUpload && selectedAlbum ? (
                  <button
                    className="retry-upload-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      info(`[PhotoGridItem] Retry button clicked for ${filename}`);
                      onRetryUpload(filename, selectedAlbum);
                    }}
                    title={`Retry upload (${uploadingImage.retryCount || 0}/5 attempts)`}
                  >
                    🔄 Retry Upload
                  </button>
                ) : (
                  <div style={{ fontSize: '0.7rem', marginTop: '0.5rem', color: '#999' }}>
                    Debug: canEdit={String(canEdit)}, handler={String(!!onRetryUpload)}, album={String(!!selectedAlbum)}
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}

      {/* Photo info section (shown in list view, hidden during upload) */}
      {isComplete && (
        <div className="photo-info">
          <div className="photo-title">
            {photoData?.title || filename}
          </div>
        </div>
      )}

      {/* Error badges for completed photos */}
      {isComplete && photoData?.optimizationError && (
        <div className="photo-error-badge optimization-error" title={photoData.optimizationError}>
          ⚠️ Optimization Failed
        </div>
      )}
      {isComplete && photoData?.aiError && (
        <div className="photo-error-badge ai-error" title={photoData.aiError}>
          ⚠️ AI Failed
        </div>
      )}

      {/* Action overlay for completed photos */}
      {isComplete && canEdit && photoData && (
        <div className="photo-overlay" onClick={handleOverlayClick}>
          <div className="photo-actions">
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (onEdit) onEdit(photoData);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (onEdit) onEdit(photoData);
              }}
              className="btn-edit-photo"
              title={t('albumsManager.editMetadata')}
              type="button"
            >
              <EditDocumentIcon width="16" height="16" />
            </button>
            {onMove && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const parts = photoData.id.split('/');
                  const fname = parts.length > 1 ? parts[parts.length - 1] : parts[0];
                  onMove(photoData.album, decodeURIComponent(fname), photoData.title, photoData.thumbnail, photoData.media_type);
                }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const parts = photoData.id.split('/');
                  const fname = parts.length > 1 ? parts[parts.length - 1] : parts[0];
                  onMove(photoData.album, decodeURIComponent(fname), photoData.title, photoData.thumbnail, photoData.media_type);
                }}
                className="btn-move-photo"
                title={t('albumsManager.moveToAlbum')}
                type="button"
              >
                <FolderArrowIcon width="16" height="16" />
              </button>
            )}
            {photoData.optimizationError && onRetryOptimization && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const filename = photoData.id.split('/').pop() || photoData.id;
                  onRetryOptimization(photoData.album, filename);
                }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const filename = photoData.id.split('/').pop() || photoData.id;
                  onRetryOptimization(photoData.album, filename);
                }}
                className="btn-retry-photo"
                title="Retry optimization"
                type="button"
              >
                🔄
              </button>
            )}
            {photoData.aiError && onRetryAI && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const filename = photoData.id.split('/').pop() || photoData.id;
                  onRetryAI(photoData.album, filename);
                }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const filename = photoData.id.split('/').pop() || photoData.id;
                  onRetryAI(photoData.album, filename);
                }}
                className="btn-retry-photo"
                title="Retry AI title generation"
                type="button"
              >
                🤖
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                // Extract filename from ID (format: "album/filename.jpg")
                const parts = photoData.id.split('/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
                info('Delete photo:', { album: photoData.album, filename, id: photoData.id });
                if (onDelete) onDelete(photoData.album, decodeURIComponent(filename), photoData.title, photoData.thumbnail, photoData.media_type);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                e.preventDefault();
                // Extract filename from ID (format: "album/filename.jpg")
                const parts = photoData.id.split('/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
                info('Delete photo:', { album: photoData.album, filename, id: photoData.id });
                if (onDelete) onDelete(photoData.album, decodeURIComponent(filename), photoData.title, photoData.thumbnail, photoData.media_type);
              }}
              className="btn-delete-photo"
              title="Delete photo"
              type="button"
            >
              <TrashIcon width="16" height="16" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AlbumGridItem;

