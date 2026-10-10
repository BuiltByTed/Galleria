/**
 * AlbumContentPanelGrid Component
 * Displays the photo grid with:
 * - Uploading photos with progress states
 * - Sortable photos with drag-and-drop
 * - Loading state
 */

import React, { useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../../../config';
import { DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from '@dnd-kit/sortable';
import AlbumGridItem from './AlbumGridItem';
import { AlbumListItem } from './AlbumListItem';
import { Photo, UploadingImage } from '../types';
import { cacheBustValue } from '../../../../config';


type ViewMode = 'grid' | 'list';

interface AlbumContentPanelGridProps {
  albumPhotos: Photo[];
  uploadingImages: UploadingImage[];
  loadingPhotos: boolean;
  activeId: string | null;
  viewMode: ViewMode;
  deletingPhotoId: string | null;
  selectedAlbum: string;
  onPhotoDragStart: (event: any, setActiveId?: (id: string | null) => void) => void;
  onPhotoDragEnd: (event: any, setActiveId?: (id: string | null) => void) => void;
  onOpenEditModal: (photo: Photo) => void;
  onDeletePhoto: (album: string, filename: string, photoTitle?: string, thumbnail?: string, mediaType?: 'photo' | 'video') => void;
  onMovePhoto?: (album: string, filename: string, photoTitle?: string, thumbnail?: string, mediaType?: 'photo' | 'video') => void;
  onRetryOptimization?: (album: string, filename: string) => void;
  onRetryAI?: (album: string, filename: string) => void;
  onRetryUpload?: (filename: string, albumName: string) => void;
  setActiveId: (id: string | null) => void;
  canEdit: boolean;
}

const AlbumContentPanelGrid: React.FC<AlbumContentPanelGridProps> = ({
  albumPhotos,
  uploadingImages,
  loadingPhotos,
  canEdit,
  deletingPhotoId,
  selectedAlbum,
  activeId,
  viewMode,
  onPhotoDragStart,
  onPhotoDragEnd,
  onOpenEditModal,
  onDeletePhoto,
  onMovePhoto,
  onRetryOptimization,
  onRetryAI,
  onRetryUpload,
  setActiveId,
}) => {
  const { t } = useTranslation();
  // Detect if device supports touch
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  
  // Track which photo has its overlay visible (only one at a time)
  const [activeOverlayId, setActiveOverlayId] = React.useState<string | null>(null);
  
  // Clear overlay when shuffle starts
  React.useEffect(() => {
    const handleShuffleStart = () => {
      setActiveOverlayId(null);
    };
    
    // Watch for shuffle button clicks
    const shuffleButton = document.querySelector('.btn-shuffle-order');
    if (shuffleButton) {
      shuffleButton.addEventListener('click', handleShuffleStart);
      shuffleButton.addEventListener('mousedown', handleShuffleStart);
      shuffleButton.addEventListener('touchstart', handleShuffleStart);
    }
    
    return () => {
      if (shuffleButton) {
        shuffleButton.removeEventListener('click', handleShuffleStart);
        shuffleButton.removeEventListener('mousedown', handleShuffleStart);
        shuffleButton.removeEventListener('touchstart', handleShuffleStart);
      }
    };
  }, []);
  
  // Lock/unlock scrolling based on drag state
  React.useEffect(() => {
    const container = document.getElementById('photos-scroll-container');
    if (!container) return;
    
    if (activeId) {
      // Drag started - prevent scrolling
      const preventScroll = (e: TouchEvent) => {
        e.preventDefault();
      };
      container.addEventListener('touchmove', preventScroll, { passive: false });
      
      return () => {
        // Drag ended - re-enable scrolling
        container.removeEventListener('touchmove', preventScroll);
      };
    }
  }, [activeId]);
  
  // FLIP animation for smooth reflow on delete
  const gridRef = useRef<HTMLDivElement>(null);
  const firstPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const prevAlbumPhotosLengthRef = useRef(albumPhotos.length);
  
  // Single useLayoutEffect - captures First positions, then applies FLIP
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    
    const currentLength = albumPhotos.length;
    const prevLength = prevAlbumPhotosLengthRef.current;
    
    // Photo was deleted (array got shorter)
    if (currentLength < prevLength && firstPositionsRef.current.size > 0) {
      // Array just changed - photos are now in new positions
      // Apply FLIP animation immediately (before browser paints)
      
      const items = gridRef.current.querySelectorAll('.admin-photo-item:not(.crt-delete)');
      
      items.forEach((item) => {
        const id = (item as HTMLElement).dataset.photoId;
        if (!id) return;
        
        const first = firstPositionsRef.current.get(id);
        if (!first) return;
        
        const last = item.getBoundingClientRect();
        const deltaX = first.left - last.left;
        const deltaY = first.top - last.top;
        
        // Only animate if position changed significantly
        if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
          const element = item as HTMLElement;
          
          // Invert: instantly move back to old position
          element.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
          element.style.transition = 'none';
          
          // Force reflow
          element.offsetHeight;
          
          // Play: animate to new position
          requestAnimationFrame(() => {
            element.style.transform = '';
            element.style.transition = 'transform 200ms ease';
            
            // Cleanup
            setTimeout(() => {
              element.style.transform = '';
              element.style.transition = '';
            }, 210);
          });
        }
      });
      
      // Clear stored positions
      firstPositionsRef.current.clear();
    }
    // Capture "First" positions when deletion starts (deletingPhotoId set)
    else if (deletingPhotoId && firstPositionsRef.current.size === 0) {
      const items = gridRef.current.querySelectorAll('.admin-photo-item:not(.crt-delete)');
      items.forEach((item) => {
        const id = (item as HTMLElement).dataset.photoId;
        if (id && id !== deletingPhotoId) {
          firstPositionsRef.current.set(id, item.getBoundingClientRect());
        }
      });
    }
    
    prevAlbumPhotosLengthRef.current = currentLength;
  }, [albumPhotos, deletingPhotoId]);
  
  // Configure dnd-kit sensors for photos
  // Mobile: Hold for 300ms with < 10px movement to activate drag
  // Once drag activates, JavaScript locks scrolling
  // Desktop: 5px movement to start drag
  const photoSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isTouchDevice ? {
        delay: 300, // Mobile: require 300ms hold before drag starts
        tolerance: 10, // Allow 10px "wiggle room" - drag cancels if moved more
      } : {
        distance: 5, // Desktop: require 5px movement to start drag
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  if (loadingPhotos) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>{t('albumsManager.loadingPhotos')}</p>
      </div>
    );
  }

  // Check if any uploads are in progress (not complete or error)
  // Error state should not prevent retry button from showing
  const hasActiveUploads = uploadingImages.some(img => 
    img.state === 'queued' || 
    img.state === 'uploading' || 
    img.state === 'optimizing' || 
    img.state === 'generating-title'
  );
  
  // Combine item IDs for sortable context
  const allItemIds = [
    ...uploadingImages.map((img) => img.photo?.id || `uploading-${uploadingImages.indexOf(img)}`),
    ...(Array.isArray(albumPhotos) ? albumPhotos.filter(p => p && p.id).map(p => p.id) : [])
  ];

  return (
    <div 
      className={`photos-modal-content ${activeId ? 'is-dragging' : ''}`} 
      id="photos-scroll-container"
    >
      <DndContext
        sensors={photoSensors}
        collisionDetection={closestCenter}
        onDragStart={(event) => onPhotoDragStart(event, setActiveId)}
        onDragEnd={(event) => onPhotoDragEnd(event, setActiveId)}
        autoScroll={{
          enabled: true,
          layoutShiftCompensation: false,
          threshold: {
            x: 0.2,
            y: 0.2,
          },
        }}
      >
        {viewMode === 'grid' ? (
          <div ref={gridRef} className="photos-grid">
            <SortableContext items={allItemIds} strategy={rectSortingStrategy}>
              {/* Uploading images (includes those transitioning to complete) */}
              {uploadingImages.map((img, index) => (
                <AlbumGridItem
                  key={img.photo?.id || `uploading-${index}`}
                  uploadingImage={img}
                  uploadingIndex={index}
                  onEdit={onOpenEditModal}
                  onDelete={onDeletePhoto}
                  onMove={onMovePhoto}
                  onRetryOptimization={onRetryOptimization}
                  onRetryAI={onRetryAI}
                  onRetryUpload={onRetryUpload}
                  selectedAlbum={selectedAlbum}
                  deletingPhotoId={deletingPhotoId}
                  canEdit={img.state === 'error' ? canEdit : (canEdit && !hasActiveUploads)}
                  activeOverlayId={activeOverlayId}
                  setActiveOverlayId={setActiveOverlayId}
                />
              ))}
              
              {/* Existing album photos (already in album before upload) */}
              {Array.isArray(albumPhotos) && albumPhotos.filter(photo => photo && photo.id).map((photo) => (
                <AlbumGridItem
                  key={photo.id}
                  photo={photo}
                  onEdit={onOpenEditModal}
                  onDelete={onDeletePhoto}
                  onMove={onMovePhoto}
                  onRetryOptimization={onRetryOptimization}
                  onRetryAI={onRetryAI}
                  deletingPhotoId={deletingPhotoId}
                  canEdit={canEdit && !hasActiveUploads}
                  activeOverlayId={activeOverlayId}
                  setActiveOverlayId={setActiveOverlayId}
                />
              ))}
            </SortableContext>
          </div>
        ) : (
          <div ref={gridRef} className="photos-list">
            <SortableContext items={allItemIds} strategy={rectSortingStrategy}>
              {/* Uploading images (includes those transitioning to complete) */}
              {uploadingImages.map((img, index) => (
                <AlbumListItem
                  key={img.photo?.id || `uploading-${index}`}
                  uploadingImage={img}
                  uploadingIndex={index}
                  onEdit={onOpenEditModal}
                  onDelete={onDeletePhoto}
                  onMove={onMovePhoto}
                  deletingPhotoId={deletingPhotoId}
                  canEdit={canEdit && !hasActiveUploads}
                />
              ))}
              
              {/* Existing album photos (already in album before upload) */}
              {Array.isArray(albumPhotos) && albumPhotos.filter(photo => photo && photo.id).map((photo) => (
                <AlbumListItem
                  key={photo.id}
                  photo={photo}
                  onEdit={onOpenEditModal}
                  onDelete={onDeletePhoto}
                  onMove={onMovePhoto}
                  deletingPhotoId={deletingPhotoId}
                  canEdit={canEdit && !hasActiveUploads}
                />
              ))}
            </SortableContext>
          </div>
        )}
        <DragOverlay dropAnimation={null}>
          {activeId ? (() => {
            const draggedPhoto = [...uploadingImages.map(img => img.photo), ...albumPhotos]
              .filter(p => p)
              .find(p => p!.id === activeId);
            
            if (!draggedPhoto) return null;
            
            // List view: show full row with title
            if (viewMode === 'list') {
              const filename = draggedPhoto.id.split('/').pop() || draggedPhoto.id;
              const title = draggedPhoto.title || filename;
              
              return (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '0.75rem 1.5rem',
                  minHeight: '76px',
                  background: '#161616',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
                  cursor: 'grabbing',
                  opacity: 0.95,
                  minWidth: '300px',
                  maxWidth: '500px',
                }}>
                  <div style={{
                    flexShrink: 0,
                    width: '60px',
                    height: '60px',
                    borderRadius: '6px',
                    overflow: 'hidden',
                    border: '1px solid #3a3a3a',
                  }}>
                    <img
                      src={`${API_URL}${draggedPhoto.thumbnail}?i=${cacheBustValue}`}
                      alt=""
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />
                  </div>
                  <div style={{
                    flex: 1,
                    minWidth: 0,
                    color: '#cfcfcf',
                    fontSize: '1rem',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {title}
                  </div>
                </div>
              );
            }
            
            // Grid view: show thumbnail only
            return (
              <div style={{ 
                width: '120px',
                height: '120px',
                borderRadius: '12px',
                overflow: 'hidden',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                cursor: 'grabbing',
                opacity: 0.9,
                transform: 'translate(0%, -50%)',
              }}>
                <img
                  src={`${API_URL}${draggedPhoto.thumbnail}?i=${cacheBustValue}`}
                  alt=""
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              </div>
            );
          })() : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
};

export default AlbumContentPanelGrid;

