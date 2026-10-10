/**
 * AlbumContentPanel Component
 * Modal container for managing photos and videos in a selected album
 * Orchestrates header controls and photo/video grid/list view
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import AlbumContentPanelHeader from './AlbumContentPanelHeader';
import AlbumContentPanelGrid from './AlbumContentPanelGrid';
import { Photo, UploadingImage } from '../types';
import { ShuffleIcon } from '../../../icons';
import '../../PhotosModal.css';

type ViewMode = 'grid' | 'list';

interface AlbumContentPanelProps {
  selectedAlbum: string;
  albumPhotos: Photo[];
  uploadingImages: UploadingImage[];
  loadingPhotos: boolean;
  hasEverDragged: boolean;
  savingOrder: boolean;
  isDragging: boolean;
  isShuffling: boolean;
  localAlbums: any[];
  deletingPhotoId: string | null;
  onClose: () => void;
  setCloseHandler: (handler: () => void) => void;
  onUploadPhotos: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDeleteAlbum: (albumName: string) => void;
  onRenameAlbum: (oldName: string, newName: string) => Promise<void>;
  onShareAlbum: (albumName: string) => void;
  onUpdateVisibility: (albumName: string, visibility: {
    published: boolean;
    show_on_homepage: boolean;
    downloads_enabled: boolean;
  }) => Promise<boolean>;
  onPreviewAlbum: (albumName: string) => void;
  onSavePhotoOrder: () => void;
  onCancelPhotoOrder: () => void;
  onShufflePhotos: () => void;
  onShuffleStart: () => void;
  onShuffleEnd: () => void;
  onPhotoDragStart: (event: any, setActiveId?: (id: string | null) => void) => void;
  onPhotoDragEnd: (event: any, setActiveId?: (id: string | null) => void) => void;
  onOpenEditModal: (photo: Photo) => void;
  onDeletePhoto: (album: string, filename: string, photoTitle?: string, thumbnail?: string, mediaType?: 'photo' | 'video') => void;
  onMovePhoto?: (album: string, filename: string, photoTitle?: string, thumbnail?: string, mediaType?: 'photo' | 'video') => void;
  onRetryOptimization?: (album: string, filename: string) => void;
  onRetryAI?: (album: string, filename: string) => void;
  onRetryUpload?: (filename: string, albumName: string) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  shuffleButtonRef: React.RefObject<HTMLButtonElement | null>;
  canEdit: boolean;
}

const AlbumContentPanel: React.FC<AlbumContentPanelProps> = ({
  selectedAlbum,
  albumPhotos,
  uploadingImages,
  loadingPhotos,
  deletingPhotoId,
  hasEverDragged,
  savingOrder,
  isDragging,
  isShuffling,
  localAlbums,
  onClose,
  setCloseHandler,
  onUploadPhotos,
  onDeleteAlbum,
  onRenameAlbum,
  onShareAlbum,
  onUpdateVisibility,
  onPreviewAlbum,
  onSavePhotoOrder,
  onCancelPhotoOrder,
  onShufflePhotos,
  onShuffleStart,
  onShuffleEnd,
  onPhotoDragStart,
  onPhotoDragEnd,
  onOpenEditModal,
  onDeletePhoto,
  onMovePhoto,
  onRetryOptimization,
  onRetryAI,
  onRetryUpload,
  onDragOver,
  onDragLeave,
  onDrop,
  shuffleButtonRef,
  canEdit,
}) => {
  const { t } = useTranslation();
  // Initialize viewMode from localStorage, default to 'grid'
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('photosViewMode');
    return (saved === 'list' || saved === 'grid') ? saved : 'grid';
  });
  const [photoActiveId, setPhotoActiveId] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(54);

  // Measure actual header height on mount (accounts for safe-area-inset-top)
  useEffect(() => {
    const header = document.querySelector('.header') as HTMLElement;
    if (header) {
      setHeaderHeight(header.offsetHeight);
    }
  }, []);

  // Save viewMode preference to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('photosViewMode', viewMode);
  }, [viewMode]);

  // Handle close with animation
  const handleClose = () => {
    setIsClosing(true);
    // Wait for animation to complete before actually closing
    setTimeout(() => {
      onClose();
    }, 300); // Match the flipDown animation duration
  };

  // Lock body scrolling when AlbumContentPanel is open and register close handler
  useEffect(() => {
    // Save current overflow states
    const originalBodyOverflow = document.body.style.overflow;
    const originalBodyPosition = document.body.style.position;
    const originalBodyTop = document.body.style.top;
    const originalBodyWidth = document.body.style.width;
    const scrollY = window.scrollY;
    
    // Lock scrolling on body
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    
    // Also lock scrolling on admin-container if it exists
    const adminContainer = document.querySelector('.admin-container') as HTMLElement;
    const originalContainerOverflow = adminContainer?.style.overflow;
    if (adminContainer) {
      adminContainer.style.overflow = 'hidden';
    }
    
    // Register close handler so album deletion can trigger animation
    setCloseHandler(() => handleClose);
    
    // Restore on unmount
    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.body.style.position = originalBodyPosition;
      document.body.style.top = originalBodyTop;
      document.body.style.width = originalBodyWidth;
      window.scrollTo(0, scrollY);
      
      if (adminContainer && originalContainerOverflow !== undefined) {
        adminContainer.style.overflow = originalContainerOverflow;
      }
    };
  }, [setCloseHandler]);

  return (
    <>
      <div className={`photos-modal-backdrop ${isClosing ? 'closing' : ''}`} onClick={handleClose} />
      <div
        className={`photos-modal ${isDragging ? 'drag-over' : ''} ${isClosing ? 'closing' : ''} ${hasEverDragged ? 'has-reorder-bar' : ''}`}
        style={{
          top: `${headerHeight}px`,
          height: `calc(100vh - ${headerHeight}px)`,
          maxHeight: `calc(100vh - ${headerHeight}px)`,
        }}
        onDragOver={uploadingImages.length > 0 ? undefined : onDragOver}
        onDragLeave={uploadingImages.length > 0 ? undefined : onDragLeave}
        onDrop={uploadingImages.length > 0 ? undefined : onDrop}
      >
          <AlbumContentPanelHeader
          selectedAlbum={selectedAlbum}
          localAlbums={localAlbums}
          albumPhotos={albumPhotos}
          uploadingImages={uploadingImages}
          viewMode={viewMode}
          onClose={handleClose}
          onUploadPhotos={onUploadPhotos}
          onDeleteAlbum={onDeleteAlbum}
          onRenameAlbum={onRenameAlbum}
          onShareAlbum={onShareAlbum}
          onUpdateVisibility={onUpdateVisibility}
          onPreviewAlbum={onPreviewAlbum}
          onViewModeChange={setViewMode}
          canEdit={canEdit}
        />

        <AlbumContentPanelGrid
          key={viewMode}
          albumPhotos={albumPhotos}
          uploadingImages={uploadingImages}
          loadingPhotos={loadingPhotos}
          activeId={photoActiveId}
          viewMode={viewMode}
          deletingPhotoId={deletingPhotoId}
          selectedAlbum={selectedAlbum}
          onPhotoDragStart={onPhotoDragStart}
          onPhotoDragEnd={onPhotoDragEnd}
          onOpenEditModal={onOpenEditModal}
          onDeletePhoto={onDeletePhoto}
          onMovePhoto={onMovePhoto}
          onRetryOptimization={onRetryOptimization}
          onRetryAI={onRetryAI}
          onRetryUpload={onRetryUpload}
          setActiveId={setPhotoActiveId}
          canEdit={canEdit}
        />

        {/* Reorder Controls (shown when dragging) - Now part of modal layout */}
        {hasEverDragged && canEdit && (
          <div className="photos-reorder-bar">
            <div className="photos-reorder-left">
              <button
                ref={shuffleButtonRef}
                onClick={onShufflePhotos}
                onMouseDown={onShuffleStart}
                onMouseUp={onShuffleEnd}
                onMouseLeave={onShuffleEnd}
                onTouchStart={onShuffleStart}
                onTouchEnd={onShuffleEnd}
                onTouchCancel={onShuffleEnd}
                className={`photos-btn btn-shuffle-order ${isShuffling ? 'shuffling-active' : ''}`}
                disabled={savingOrder}
                title={t('albumsManager.shufflePhotosTooltip')}
              >
                <ShuffleIcon width="16" height="16" />
                <span>{t('albumsManager.shuffle')}</span>
              </button>
              <span className="reorder-hint reorder-hint-desktop">{t('albumsManager.dragToReorder')}</span>
            </div>
            <div className="photos-reorder-right">
              <button 
                onClick={onCancelPhotoOrder} 
                className="photos-btn photos-btn-ghost" 
                disabled={savingOrder}
              >
                {t('common.cancel')}
              </button>
              <button 
                onClick={onSavePhotoOrder} 
                className="photos-btn photos-btn-success" 
                disabled={savingOrder}
              >
                {savingOrder ? t('albumsManager.savingOrder') : t('albumsManager.saveOrder')}
              </button>
            </div>
            <span className="reorder-hint reorder-hint-mobile">{t('albumsManager.dragToReorder')}</span>
          </div>
        )}
      </div>
    </>
  );
};

export default AlbumContentPanel;
