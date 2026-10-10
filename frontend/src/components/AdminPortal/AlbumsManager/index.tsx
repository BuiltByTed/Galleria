/**
 * Albums Manager - Main Orchestrator
 * Manages albums, photos, uploads, and image optimization
 * 
 * Refactored to use extracted components:
 * - SortableAlbumCard: Drag-and-drop album cards
 * - SortablePhotoItem: Drag-and-drop photo thumbnails
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../../config';
import { useSearchParams } from 'react-router-dom';
import { UploadingImage, AlbumsManagerProps, ConfirmModalConfig, Photo } from './types';
import { trackAlbumCreated } from '../../../utils/analytics';
import { useSSEToaster } from '../../../contexts/SSEToasterContext';
import AlbumContentPanel from './components/AlbumContentPanel';
import AlbumToolbar from './components/AlbumToolbar';
import FoldersSection from './components/FoldersSection';
import UncategorizedSection from './components/UncategorizedSection';
import ModalsCollection from './components/ModalsCollection';
import { useAlbumManagement } from './hooks/useAlbumManagement';
import { usePhotoManagement } from './hooks/usePhotoManagement';
import { useFolderManagement } from './hooks/useFolderManagement';
import { isValidAlbumName } from './utils/albumHelpers';
import { customCollisionDetection } from './utils/collisionDetection';
import { createDragDropHandlers } from './handlers/dragDropHandlers';
import { createFolderHandlers } from './handlers/folderHandlers';
import { createUploadHandlers } from './handlers/uploadHandlers';
import { createAlbumHandlers } from './handlers/albumHandlers';
import { createUIInteractionHandlers } from './handlers/uiInteractionHandlers';
import { createPhotoHandlers } from './handlers/photoHandlers';
import { createMobileReorderHandlers } from './handlers/mobileReorderHandlers';
import { createOptimizationStreamHandlers } from './handlers/optimizationStreamHandlers';
import '../AlbumsManager.css';
import '../PhotoOrderControls.css';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { info } from '../../../utils/logger';


const AlbumsManager: React.FC<AlbumsManagerProps> = ({
  albums,
  folders,
  loadAlbums,
  setMessage,
  userRole,
}) => {
  const { t, i18n } = useTranslation();
  // Check if user can edit (admin or manager)
  const canEdit = userRole === 'admin' || userRole === 'manager';
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Confirmation modal state (needed early for hooks)
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmModalConfig | null>(null);
  
  // Track which photo is being deleted for animation
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  
  // Store reference to AlbumContentPanel close handler for album deletion
  const [albumContentPanelCloseHandler, setAlbumContentPanelCloseHandler] = useState<(() => void) | null>(null);
  
  // Helper function to show confirmation dialog
  const showConfirmation = useCallback((config: ConfirmModalConfig) => {
    setConfirmConfig(config);
    setShowConfirmModal(true);
  }, []);
  
  // Use custom hooks for album, photo, and folder management
  const albumManagement = useAlbumManagement({ albums, folders, setMessage, loadAlbums });
  const photoManagement = usePhotoManagement({ setMessage, showConfirmation });
  const folderManagement = useFolderManagement({ setMessage, loadAlbums, showConfirmation });
  
  // Get SSE toaster context for real-time title updates
  const sseToaster = useSSEToaster();
  
  // Extract commonly used values from hooks
  const {
    localAlbums,
    setLocalAlbums,
    localFolders,
    setLocalFolders,
    animatingAlbum,
    setAnimatingAlbum,
  } = albumManagement;
  
  const {
    selectedAlbum,
    albumPhotos,
    setAlbumPhotos,
    setOriginalPhotoOrder,
    loadingPhotos,
    hasEverDragged,
    // setHasEverDragged,
    savingOrder,
    selectAlbum: selectAlbumInternal,
    deselectAlbum: deselectAlbumInternal,
    editingPhoto,
    editTitleValue,
    setEditTitleValue,
    editDescriptionValue,
    setEditDescriptionValue,
    showEditModal,
    openEditModal,
    closeEditModal,
    handleEditSave,
  } = photoManagement;
  
  // Upload state (declare before useEffect that uses it)
  const [uploadingImages, setUploadingImages] = useState<UploadingImage[]>([]);
  const uploadingImagesRef = useRef<UploadingImage[]>([]);
  const uploadBatchSizeRef = useRef(0); // Track original batch size
  const [uploadingAlbum, setUploadingAlbum] = useState<string>(''); // Track which album is uploading
  
  // Sync URL with selected album state
  useEffect(() => {
    const albumParam = searchParams.get('album');
    
    // If URL has an album and it's valid
    if (albumParam && albums.some(a => a.name === albumParam)) {
      // Only select if not already selected (to prevent infinite loop)
      if (selectedAlbum !== albumParam) {
        // If we're currently uploading to this album, don't reload from DB
        // Just set the selectedAlbum state without calling loadPhotos
        if (uploadingAlbum === albumParam) {
          info(`[Album Manager] Opening panel for album "${albumParam}" during active upload - skipping DB load`);
          photoManagement.setSelectedAlbum(albumParam);
        } else {
          selectAlbumInternal(albumParam);
        }
      }
    } else if (!albumParam && selectedAlbum) {
      // If URL has no album but state has one, deselect
      deselectAlbumInternal();
    }
  }, [albums, searchParams, selectedAlbum, selectAlbumInternal, deselectAlbumInternal, uploadingAlbum, photoManagement]);
  
  // Calculate upload progress for the currently uploading album
  const uploadProgress = uploadingAlbum ? {
    album: uploadingAlbum,
    completed: uploadingImages.filter(img => img.state === 'complete').length,
    total: uploadBatchSizeRef.current,
  } : null;
  
  // Wrapper to update URL when selecting an album
  const selectAlbum = useCallback((albumName: string) => {
    setSearchParams({ album: albumName }, { replace: false });
  }, [setSearchParams]);
  
  // Wrapper to clear URL when deselecting an album
  const deselectAlbum = useCallback(() => {
    searchParams.delete('album');
    setSearchParams(searchParams, { replace: false });
  }, [searchParams, setSearchParams]);
  
  // Move completed uploads from uploadingImages to albumPhotos when ALL uploads finish
  useEffect(() => {
    const completedUploads = uploadingImages.filter(img => img.state === 'complete' && img.photo);
    
    // Check if all uploads are done
    const hasActiveUploads = uploadingImages.some(img => img.state !== 'complete');
    
    // Only move to albumPhotos when ALL uploads are complete
    // Use uploadingAlbum instead of selectedAlbum so this works even if panel is closed
    if (completedUploads.length > 0 && !hasActiveUploads && uploadingAlbum) {
      info('[Upload Progress] All uploads complete, moving to albumPhotos:', completedUploads.length);
      
      // Sort by uploadIndex to maintain original order
      const sortedCompleted = [...completedUploads].sort((a, b) => 
        (a.uploadIndex ?? 0) - (b.uploadIndex ?? 0)
      );
      
      // Extract photos from completed uploads in correct order
      const newPhotos = sortedCompleted.map(img => img.photo!).filter(p => p);
      
      // Only update albumPhotos if the uploading album matches the currently selected album
      if (uploadingAlbum === selectedAlbum) {
        info('[Upload Progress] Uploading album matches selected album, updating UI');
        // Add to beginning of albumPhotos (they were rendered first in the grid)
        photoManagement.setAlbumPhotos((prev: Photo[]) => [...newPhotos, ...prev]);
        
        // ALSO update originalPhotoOrder so Cancel doesn't make photos disappear
        photoManagement.setOriginalPhotoOrder((prev: Photo[]) => [...newPhotos, ...prev]);
      } else {
        info('[Upload Progress] Uploading album does not match selected album, showing completion toaster');
        // Show success toaster if panel was closed during upload
        setMessage({ 
          type: 'success', 
          text: t('albumsManager.uploadComplete', { 
            count: completedUploads.length, 
            photo: completedUploads.length === 1 ? t('albumsManager.photo') : t('albumsManager.photos'),
            album: uploadingAlbum
          })
        });
      }
      
      // Clear uploadingImages
      setUploadingImages([]);
      
      // Clear uploading album state
      setUploadingAlbum('');
      uploadBatchSizeRef.current = 0;
    }
  }, [uploadingImages, photoManagement, selectedAlbum, uploadingAlbum]);

  // Ref to track current selected album (avoids closure issues in SSE handler)
  const selectedAlbumRef = useRef<string | null>(selectedAlbum);
  useEffect(() => {
    selectedAlbumRef.current = selectedAlbum;
  }, [selectedAlbum]);

  // Register title update callback for real-time updates during AI title generation
  useEffect(() => {
    const handleTitleUpdate = (album: string, filename: string, title: string) => {
      // Only update if it's for the currently selected album
      if (album === selectedAlbumRef.current) {
        info(`[AlbumsManager] Updating title for ${album}/${filename}: "${title}"`);
        setAlbumPhotos((prev: Photo[]) =>
          prev.map((p) =>
            (p.id.split('/').pop() || p.id) === filename ? { ...p, title } : p
          )
        );
        setOriginalPhotoOrder((prev: Photo[]) =>
          prev.map((p) =>
            (p.id.split('/').pop() || p.id) === filename ? { ...p, title } : p
          )
        );
      }
    };
    
    sseToaster.setOnTitleUpdate(handleTitleUpdate);
    
    return () => {
      sseToaster.setOnTitleUpdate(null);
    };
  }, [setAlbumPhotos, setOriginalPhotoOrder, sseToaster]);
  
  // Apply buffered title updates when album changes
  useEffect(() => {
    if (selectedAlbum && albumPhotos.length > 0) {
      const bufferedUpdates = sseToaster.getBufferedUpdates(selectedAlbum);
      const updateCount = Object.keys(bufferedUpdates).length;
      
      if (updateCount > 0) {
        info(`[AlbumsManager] Applying ${updateCount} buffered title updates for ${selectedAlbum}`);
        setAlbumPhotos((prev: Photo[]) =>
          prev.map((p) => {
            const filename = p.id.split('/').pop() || p.id;
            return bufferedUpdates[filename] ? { ...p, title: bufferedUpdates[filename] } : p;
          })
        );
        setOriginalPhotoOrder((prev: Photo[]) =>
          prev.map((p) => {
            const filename = p.id.split('/').pop() || p.id;
            return bufferedUpdates[filename] ? { ...p, title: bufferedUpdates[filename] } : p;
          })
        );
      }
    }
  }, [selectedAlbum, albumPhotos.length, setAlbumPhotos, setOriginalPhotoOrder, sseToaster]);

  // Ref to track uploading album (persists even when panel is closed)
  const uploadingAlbumRef = useRef<string>('');
  useEffect(() => {
    uploadingAlbumRef.current = uploadingAlbum;
  }, [uploadingAlbum]);

  // Connect to optimization stream when AlbumContentPanel is open (memoize to prevent recreating on every render)
  const optimizationStreamHandlers = React.useMemo(
    () => createOptimizationStreamHandlers({
      setUploadingImages,
      uploadingAlbumRef
    }),
    [setUploadingImages]
  );

  // Track whether we have active uploads (to detect transitions)
  const hasActiveUploadsRef = useRef(false);
  
  // Check for active uploads and manage connection (runs on every uploadingImages change)
  useEffect(() => {
    // Check if there are any images that are actively being processed (not complete or error)
    const hasActive = uploadingImages.some(img => 
      img.state === 'queued' || 
      img.state === 'uploading' || 
      img.state === 'optimizing' || 
      img.state === 'generating-title'
    );
    
    // Transition: no uploads → has uploads
    if (hasActive && !hasActiveUploadsRef.current && uploadingAlbum) {
      info('[Album Manager] 🚀 Active uploads started, connecting stream');
      hasActiveUploadsRef.current = true;
      optimizationStreamHandlers.connectOptimizationStream();
    }
    // Transition: has uploads → no uploads  
    else if (!hasActive && hasActiveUploadsRef.current) {
      info('[Album Manager] ✅ All uploads complete, disconnecting stream');
      hasActiveUploadsRef.current = false;
      optimizationStreamHandlers.disconnectOptimizationStream();
    }
  }, [uploadingImages, uploadingAlbum, optimizationStreamHandlers]);

  // Cleanup only on unmount
  useEffect(() => {
    return () => {
      info('[Album Manager] Component unmounting, cleaning up stream');
      optimizationStreamHandlers.disconnectOptimizationStream();
      hasActiveUploadsRef.current = false;
    };
  }, []); // Empty deps = only on mount/unmount
  
  // Drag-and-drop state (keeping this in component for now)
  const [isDragging, setIsDragging] = useState(false);
  const [isShuffling, setIsShuffling] = useState(false);
  const shuffleIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const speedupTimeoutsRef = useRef<NodeJS.Timeout[]>([]);
  
  // Folder management is handled via folderManagement object
  
  // State for drag-and-drop on album tiles
  const [dragOverAlbum] = useState<string | null>(null);
  const [isGhostAlbumDragOver, setIsGhostAlbumDragOver] = useState(false);
  const [dragOverFolderGhostTile, setDragOverFolderGhostTile] = useState<number | null>(null);
  const [showNewAlbumModal, setShowNewAlbumModal] = useState(false);
  const [newAlbumFiles, setNewAlbumFiles] = useState<File[]>([]);
  const [newAlbumModalName, setNewAlbumModalName] = useState('');
  const [newAlbumPublished, setNewAlbumPublished] = useState(false);
  const [newAlbumModalError, setNewAlbumModalError] = useState('');
  
  // Folder modal state
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderModalError, setFolderModalError] = useState('');
  const [targetFolderId, setTargetFolderId] = useState<number | null>(null);
  
  // Folder delete modal state
  const [showFolderDeleteModal, setShowFolderDeleteModal] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ name: string; albumCount: number } | null>(null);
  
  // Rename album state
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renamingAlbum, setRenamingAlbum] = useState<string | null>(null);
  const [newAlbumName, setNewAlbumName] = useState('');
  
  // Folder drag-over state (when an album is dragged over a folder)
  const [dragOverFolderId, setDragOverFolderId] = useState<number | null>(null);
  const [dragOverUncategorized, setDragOverUncategorized] = useState(false);
  
  // Ref to track if we're currently dragging (for touch scroll prevention)
  // const isDraggingRef = useRef(false); // unused for now
  
  // Ref for ghost tile file input
  const ghostTileFileInputRef = useRef<HTMLInputElement>(null);
  
  // Refs for folder ghost tile file inputs (Map of folderId -> ref)
  const folderGhostTileRefs = useRef<Map<number, React.RefObject<HTMLInputElement>>>(new Map());

  // Ref for uncategorized section (for manual bounding box checks)
  const uncategorizedSectionRef = useRef<HTMLDivElement>(null);

  // Detect if device supports touch
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  
  // Prevent touch scrolling while dragging on mobile
  useEffect(() => {
    if (isDragging) {
      // Store current scroll position
      const scrollY = window.scrollY;
      
      // Store original styles
      const originalOverflow = document.body.style.overflow;
      const originalTouchAction = document.body.style.touchAction;
      const originalPosition = document.body.style.position;
      const originalTop = document.body.style.top;
      const originalWidth = document.body.style.width;
      
      // Disable scrolling and preserve position
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
      
      return () => {
        // Restore original styles
        document.body.style.overflow = originalOverflow;
        document.body.style.touchAction = originalTouchAction;
        document.body.style.position = originalPosition;
        document.body.style.top = originalTop;
        document.body.style.width = originalWidth;
        
        // Restore scroll position
        window.scrollTo(0, scrollY);
      };
    }
  }, [isDragging]);
  
  // Configure dnd-kit sensors for photos (unused for now)
  // Desktop: minimal delay for instant drag, mobile: longer delay to differentiate tap vs drag
  // const photoSensors = useSensors(
  //   useSensor(PointerSensor, {
  //     activationConstraint: isTouchDevice ? {
  //       delay: 300, // Mobile: require 300ms hold before drag starts
  //       tolerance: 8, // Mobile: allow 8px movement during the delay
  //     } : {
  //       distance: 5, // Desktop: require 5px movement to start drag (prevents accidental drags on click)
  //     },
  //   }),
  //   useSensor(KeyboardSensor, {
  //     coordinateGetter: sortableKeyboardCoordinates,
  //   })
  // );

  // Configure dnd-kit sensors for albums
  const albumSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isTouchDevice ? {
        delay: 300, // Mobile: require 300ms hold before drag starts
        tolerance: 8, // Mobile: allow 8px movement during the delay
      } : {
        distance: 5, // Desktop: require 5px movement to start drag (prevents accidental drags on click)
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // State for album drag-and-drop
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareAlbumName, setShareAlbumName] = useState<string | null>(null);
  
  // Move to Folder modal state
  const [showMoveToFolderModal, setShowMoveToFolderModal] = useState(false);
  const [moveToFolderAlbumName, setMoveToFolderAlbumName] = useState<string | null>(null);

  // Move photo to album modal state
  const [showMoveToAlbumModal, setShowMoveToAlbumModal] = useState(false);
  const [movePhotoAlbum, setMovePhotoAlbum] = useState<string | null>(null);
  const [movePhotoFilename, setMovePhotoFilename] = useState<string | null>(null);
  const [movePhotoTitle, setMovePhotoTitle] = useState('');
  const [isMovingPhoto, setIsMovingPhoto] = useState(false);
  
  // Folder deletion modal state
  const [showDeleteFolderModal, setShowDeleteFolderModal] = useState(false);
  const [deletingFolderName] = useState<string | null>(null);

  // Helper function to show confirmation modal (using imported utility)
  // const showConfirmation = (message: string): Promise<boolean> => {
  //   return createConfirmation(message, setShowConfirmModal, setConfirmConfig);
  // };

// Initialize all handlers using factory functions
  const dragDropHandlers = createDragDropHandlers({
    localAlbums,
    setLocalAlbums,
    localFolders,
    setLocalFolders,
    saveAlbumOrder: albumManagement.saveAlbumOrder,
    saveFolderOrder: folderManagement.saveFolderOrder,
    loadAlbums,
    setAnimatingAlbum,
    setActiveAlbumId,
    setActiveFolderId,
    setDragOverFolderId,
    setDragOverUncategorized,
    setIsDragging,
    uncategorizedSectionRef,
  });

  const folderHandlers = createFolderHandlers({
    localAlbums,
    localFolders,
    setMessage,
    loadAlbums,
    saveAlbumOrder: albumManagement.saveAlbumOrder,
    setShowFolderDeleteModal,
    setFolderToDelete,
    t,
  });

  const uploadHandlers = createUploadHandlers({
    uploadingImages,
    setUploadingImages,
    uploadingImagesRef,
    uploadBatchSizeRef,
    setUploadingAlbum,
    selectAlbum,
    setMessage,
    loadAlbums,
    language: i18n.language,
    t,
  });

  const albumHandlers = createAlbumHandlers({
    localAlbums,
    setLocalAlbums,
    localFolders,
    selectedAlbum,
    deselectAlbum,
    selectAlbum,
    setMessage,
    loadAlbums,
    saveAlbumOrder: albumManagement.saveAlbumOrder,
    setShowRenameModal,
    setRenamingAlbum,
    setNewAlbumName,
    renamingAlbum,
    newAlbumName,
    showConfirmation,
    closePhotosPanel: albumContentPanelCloseHandler || undefined,
    t,
  });

  const uiHandlers = createUIInteractionHandlers({
    localAlbums,
    loadAlbums,
    setShowNewAlbumModal,
    setNewAlbumFiles,
    setNewAlbumModalName,
    setIsGhostAlbumDragOver,
    setDragOverFolderGhostTile,
    setTargetFolderId,
    ghostTileFileInputRef,
    folderGhostTileRefs,
    t,
    setMessage,
    saveAlbumOrder: albumManagement.saveAlbumOrder,
    uploadingImages,
  });

  const mobileReorderHandlers = createMobileReorderHandlers({
    localAlbums,
    setLocalAlbums,
    localFolders,
    setLocalFolders,
    saveAlbumOrder: albumManagement.saveAlbumOrder,
    saveFolderOrder: folderManagement.saveFolderOrder,
  });

  const photoHandlers = createPhotoHandlers({
    selectedAlbum,
    loadPhotos: photoManagement.loadPhotos,
    shufflePhotos: photoManagement.shufflePhotos,
    setMessage,
    showConfirmation,
    setAlbumPhotos: photoManagement.setAlbumPhotos,
    setOriginalPhotoOrder: photoManagement.setOriginalPhotoOrder,
    setDeletingPhotoId,
    shuffleIntervalRef,
    speedupTimeoutsRef,
    setIsShuffling,
    loadAlbums,
    t,
  });

  const handleOpenMovePhotoModal = (
    album: string,
    filename: string,
    photoTitle: string = '',
    _thumbnail?: string,
    _mediaType?: 'photo' | 'video'
  ) => {
    setMovePhotoAlbum(album);
    setMovePhotoFilename(filename);
    setMovePhotoTitle(photoTitle || '');
    setShowMoveToAlbumModal(true);
  };

  const handleOpenMoveFromEdit = () => {
    if (!editingPhoto) return;
    const parts = editingPhoto.id.split('/');
    const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    handleOpenMovePhotoModal(
      editingPhoto.album || parts[0],
      decodeURIComponent(filename),
      editingPhoto.title || ''
    );
  };

  const handleMovePhotoToAlbum = async (destinationAlbum: string) => {
    if (!movePhotoAlbum || !movePhotoFilename) return;
    setIsMovingPhoto(true);
    try {
      const ok = await photoHandlers.handleMovePhoto(
        movePhotoAlbum,
        movePhotoFilename,
        destinationAlbum,
        movePhotoTitle
      );
      if (ok) {
        setShowMoveToAlbumModal(false);
        setMovePhotoAlbum(null);
        setMovePhotoFilename(null);
        setMovePhotoTitle('');
        // Close edit modal if open (photo left this album)
        if (showEditModal) {
          closeEditModal();
        }
      }
    } finally {
      setIsMovingPhoto(false);
    }
  };

  // Handlers are accessed via namespace pattern (e.g., dragDropHandlers.handlePhotoDragStart)
  // This makes it clearer where each handler comes from

  // Additional handlers that need to stay inline due to local state dependencies
  // const handleModalCancel = () => cancelModal(setShowConfirmModal, setConfirmConfig); // unused

  const handleCloseNewAlbumModal = () => {
    setShowNewAlbumModal(false);
    setNewAlbumModalName('');
    setNewAlbumFiles([]);
    setNewAlbumModalError('');
    setTargetFolderId(null);
    setNewAlbumPublished(false);
  };

  const handleOpenMoveToFolderModal = (albumName: string) => {
    setMoveToFolderAlbumName(albumName);
    setShowMoveToFolderModal(true);
  };

  const handleMoveToFolder = async (albumName: string, folderId: number | null) => {
    // Get target folder's published state (if moving to a folder)
    const targetFolder = folderId ? localFolders.find(f => f.id === folderId) : null;
    const targetPublishedState = targetFolder ? targetFolder.published : undefined;
    
    // Update the album's folder_id and published state in local state
    const updatedAlbums = localAlbums.map(album => 
      album.name === albumName 
        ? { 
            ...album, 
            folder_id: folderId || undefined,
            // Sync published state with folder (or keep current if moving to uncategorized)
            published: targetPublishedState !== undefined ? targetPublishedState : album.published
          }
        : album
    );
    setLocalAlbums(updatedAlbums);
    
    // Save immediately
    const success = await albumManagement.saveAlbumOrder(updatedAlbums, true);
    if (success) {
      // Reload to get any backend updates (like folder published state changes)
      await loadAlbums();
      setMessage({ type: 'success', text: `Album moved to ${folderId ? localFolders.find(f => f.id === folderId)?.name || 'folder' : 'Uncategorized'}` });
    }
  };

  const handleCreateAlbumFromModal = async () => {
    // Check for reserved "homepage" name
    if (newAlbumModalName.trim().toLowerCase() === 'homepage') {
      setNewAlbumModalError('HOMEPAGE_RESERVED');
      return;
    }
    
    // Validate album name
    if (!isValidAlbumName(newAlbumModalName)) {
      setNewAlbumModalError('Album name must be at least 2 characters and contain only letters, numbers, spaces, hyphens, and underscores');
      return;
    }
    
    // Check for duplicate names
    if (localAlbums.some(a => a.name.toLowerCase() === newAlbumModalName.trim().toLowerCase())) {
      setNewAlbumModalError('An album with this name already exists');
      return;
    }
    
    try {
      // Step 1: Create empty album first
      const createBody: any = { name: newAlbumModalName };
      if (targetFolderId !== null) {
        createBody.folder_id = targetFolderId;
      }
      
      const res = await fetch(`${API_URL}/api/albums`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      
      if (!res.ok) {
        const error = await res.json();
        setNewAlbumModalError(error.message || error.error || 'Failed to create album');
        return;
      }
      
      // Step 2: Set published state based on folder or checkbox
      let shouldPublish = newAlbumPublished; // Default to checkbox value for uncategorized
      
      // If creating in a folder, inherit the folder's published state
      if (targetFolderId !== null) {
        const targetFolder = localFolders.find(f => f.id === targetFolderId);
        if (targetFolder) {
          shouldPublish = targetFolder.published;
        }
      }
      
      if (shouldPublish) {
        await fetch(`${API_URL}/api/albums/${encodeURIComponent(newAlbumModalName)}/publish`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ published: true }),
        });
      }
      
      // Step 3: Upload photos one by one using SSE workflow
      setMessage({ type: 'success', text: `Album "${newAlbumModalName}" created` });
      trackAlbumCreated(newAlbumModalName);
      await loadAlbums();
      
      // Notify other components (like the header navigation)
      window.dispatchEvent(new Event('albums-updated'));
      
      handleCloseNewAlbumModal();
      selectAlbum(newAlbumModalName);
      
      // Upload files using the SSE workflow
      if (newAlbumFiles.length > 0) {
        await uploadHandlers.handleUploadToAlbum(newAlbumModalName, newAlbumFiles);
      }
    } catch (err) {
      setNewAlbumModalError('Network error occurred');
    }
  };

  // Ref for shuffle button (for long-press shuffle)
  const shuffleButtonRef = useRef<HTMLButtonElement>(null);
  
  // Cleanup shuffle interval and timeouts on unmount
  useEffect(() => {
    return () => {
      if (shuffleIntervalRef.current) {
        clearInterval(shuffleIntervalRef.current);
        shuffleIntervalRef.current = null;
      }
      speedupTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
      speedupTimeoutsRef.current = [];
    };
  }, []);


  return (
    <>
      <section className="admin-section">
        <div>
          <h2>{t('albumsManager.title')}</h2>
          <p className="section-description">{t('albumsManager.description')}</p>
        </div>
        
        {/* Unified Drag-and-Drop Context for Folders and Albums */}
        <DndContext
          sensors={albumSensors}
          collisionDetection={customCollisionDetection}
          onDragStart={dragDropHandlers.handleAlbumDragStart}
          onDragOver={dragDropHandlers.handleAlbumDragOver}
          onDragEnd={dragDropHandlers.handleAlbumDragEnd}
        >
          {/* Single SortableContext for ALL albums (enables dragging between folders and uncategorized) */}
          <SortableContext
            items={localAlbums.map((album) => album.name)}
            strategy={rectSortingStrategy}
          >
          
          
          <AlbumToolbar
            localFoldersCount={localFolders.length}
            onCreateFolder={() => setShowFolderModal(true)}
            canEdit={canEdit}
          />
          
          <FoldersSection
            localFolders={localFolders}
            localAlbums={localAlbums}
            selectedAlbum={selectedAlbum}
            animatingAlbum={animatingAlbum}
            dragOverAlbum={dragOverAlbum}
            dragOverFolderId={dragOverFolderId}
            dragOverFolderGhostTile={dragOverFolderGhostTile}
            uploadingImages={uploadingImages}
            uploadProgress={uploadProgress}
            folderGhostTileRefs={folderGhostTileRefs}
            onDeleteFolder={folderHandlers.handleDeleteFolder}
            onToggleFolderPublished={folderHandlers.handleToggleFolderPublished}
            onAlbumClick={(albumName) => selectedAlbum === albumName ? deselectAlbum() : selectAlbum(albumName)}
            onAlbumDragOver={dragDropHandlers.handleAlbumTileDragOver}
            onAlbumDragLeave={(e) => dragDropHandlers.handleAlbumTileDragLeave(e)}
            onAlbumDrop={dragDropHandlers.handleAlbumTileDrop}
            onCreateAlbumInFolder={uiHandlers.handleCreateAlbumInFolder}
            onFolderGhostTileClick={uiHandlers.handleFolderGhostTileClick}
            onFolderGhostTileDragOver={uiHandlers.handleFolderGhostTileDragOver}
            onFolderGhostTileDragLeave={uiHandlers.handleFolderGhostTileDragLeave}
            onFolderGhostTileDrop={uiHandlers.handleFolderGhostTileDrop}
            onFolderGhostTileFileSelect={uiHandlers.handleFolderGhostTileFileSelect}
            onFolderMoveUp={mobileReorderHandlers.handleFolderMoveUp}
            onFolderMoveDown={mobileReorderHandlers.handleFolderMoveDown}
            onAlbumMoveUp={mobileReorderHandlers.handleAlbumMoveUp}
            onAlbumMoveDown={mobileReorderHandlers.handleAlbumMoveDown}
            onAlbumMoveToFolder={handleOpenMoveToFolderModal}
            hasFolders={localFolders.length > 0}
            canEdit={canEdit}
          />
          
          <UncategorizedSection
            localAlbums={localAlbums}
            selectedAlbum={selectedAlbum}
            animatingAlbum={animatingAlbum}
            dragOverAlbum={dragOverAlbum}
            dragOverUncategorized={dragOverUncategorized}
            uploadingImages={uploadingImages}
            uploadProgress={uploadProgress}
            isGhostAlbumDragOver={isGhostAlbumDragOver}
            uncategorizedSectionRef={uncategorizedSectionRef}
            ghostTileFileInputRef={ghostTileFileInputRef}
            onAlbumClick={(albumName) => selectedAlbum === albumName ? deselectAlbum() : selectAlbum(albumName)}
            onAlbumDragOver={dragDropHandlers.handleAlbumTileDragOver}
            onAlbumDragLeave={dragDropHandlers.handleAlbumTileDragLeave}
            onAlbumDrop={dragDropHandlers.handleAlbumTileDrop}
            onGhostTileClick={uiHandlers.handleGhostTileClick}
            onGhostTileDragOver={uiHandlers.handleGhostTileDragOver}
            onGhostTileDragLeave={uiHandlers.handleGhostTileDragLeave}
            onGhostTileDrop={uiHandlers.handleGhostTileDrop}
            onGhostTileFileSelect={uiHandlers.handleGhostTileFileSelect}
            onAlbumMoveUp={mobileReorderHandlers.handleAlbumMoveUp}
            onAlbumMoveDown={mobileReorderHandlers.handleAlbumMoveDown}
            onAlbumMoveToFolder={handleOpenMoveToFolderModal}
            hasFolders={localFolders.length > 0}
            canEdit={canEdit}
          />
          
          
          {/* Unified Drag Overlay for both albums and folders */}
          <DragOverlay>
            {activeAlbumId ? (
              <div className="album-card dragging" style={{ cursor: 'grabbing', opacity: 0.8 }}>
                <div className="album-card-header">
                  <h4>
                    <span className="album-name">{activeAlbumId}</span>
                  </h4>
                  {localAlbums.find(a => a.name === activeAlbumId)?.photoCount !== undefined && (
                    <div className="album-badge">
                      {localAlbums.find(a => a.name === activeAlbumId)?.photoCount} {localAlbums.find(a => a.name === activeAlbumId)?.photoCount === 1 ? 'photo' : 'photos'}
                    </div>
                  )}
                </div>
              </div>
            ) : activeFolderId ? (
              (() => {
                const folder = localFolders.find(f => f.id === activeFolderId);
                const folderAlbums = localAlbums.filter(a => a.folder_id === activeFolderId);
                if (!folder) return null;
                return (
                  <div className={`folder-card dragging ${!folder.published ? 'unpublished' : ''}`} style={{ cursor: 'grabbing', opacity: 0.8 }}>
                    <div className="folder-card-header">
                      <div className="folder-drag-handle">
                        <h4 className="folder-card-title">{folder.published ? '📁' : '🔒'} {folder.name}</h4>
                        <div className="folder-count">{folderAlbums.length} {folderAlbums.length === 1 ? 'album' : 'albums'}</div>
                      </div>
                    </div>
                    <div className="folder-albums-grid">
                      {folderAlbums.map((album) => (
                        <div key={album.name} className="album-card">
                          <h4>{album.name}</h4>
                          <span className="photo-count">{album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()
            ) : null}
          </DragOverlay>
          </SortableContext>
        </DndContext>

          {selectedAlbum && (
            <AlbumContentPanel
              selectedAlbum={selectedAlbum}
              albumPhotos={albumPhotos}
              uploadingImages={uploadingAlbum === selectedAlbum ? uploadingImages : []}
              loadingPhotos={loadingPhotos}
              hasEverDragged={hasEverDragged}
              savingOrder={savingOrder}
              isDragging={isDragging}
              isShuffling={isShuffling}
              localAlbums={localAlbums}
              deletingPhotoId={deletingPhotoId}
              onClose={deselectAlbum}
              setCloseHandler={setAlbumContentPanelCloseHandler}
              onUploadPhotos={uploadHandlers.handleUploadPhotos}
              onDeleteAlbum={albumHandlers.handleDeleteAlbum}
              onRenameAlbum={albumHandlers.handleInlineRenameAlbum}
              onShareAlbum={(albumName) => {
                setShareAlbumName(albumName);
                setShowShareModal(true);
              }}
              onUpdateVisibility={albumHandlers.handleUpdateVisibility}
              onPreviewAlbum={(albumName) => {
                window.open(`/album/${encodeURIComponent(albumName)}`, '_blank');
              }}
              onSavePhotoOrder={() => photoManagement.savePhotoOrder()}
              onCancelPhotoOrder={photoManagement.cancelPhotoReorder}
              onShufflePhotos={photoHandlers.handleShuffleClick}
              onShuffleStart={photoHandlers.handleShuffleStart}
              onShuffleEnd={photoHandlers.handleShuffleEnd}
              onPhotoDragStart={(event, setActiveId) => photoManagement.handlePhotoDragStart(event, setActiveId)}
              onPhotoDragEnd={(event, setActiveId) => photoManagement.handlePhotoDragEnd(event, setActiveId)}
              onOpenEditModal={openEditModal}
              onDeletePhoto={photoHandlers.handleDeletePhoto}
              onMovePhoto={handleOpenMovePhotoModal}
              onRetryOptimization={photoHandlers.handleRetryOptimization}
              onRetryAI={photoHandlers.handleRetryAI}
              onRetryUpload={uploadHandlers.handleRetryUpload}
              onDragOver={uploadHandlers.handleDragOver}
              onDragLeave={uploadHandlers.handleDragLeave}
              onDrop={uploadHandlers.handleDrop}
              shuffleButtonRef={shuffleButtonRef}
              canEdit={canEdit}
            />
          )}
      </section>

      <ModalsCollection
        showEditModal={showEditModal}
        editingPhoto={editingPhoto}
        editTitleValue={editTitleValue}
        setEditTitleValue={setEditTitleValue}
        editDescriptionValue={editDescriptionValue}
        setEditDescriptionValue={setEditDescriptionValue}
        handleCloseEditModal={closeEditModal}
        handleSaveTitle={handleEditSave}
        onOpenMoveFromEdit={handleOpenMoveFromEdit}
        showMoveToAlbumModal={showMoveToAlbumModal}
        movePhotoAlbum={movePhotoAlbum}
        movePhotoFilename={movePhotoFilename}
        movePhotoTitle={movePhotoTitle}
        setShowMoveToAlbumModal={setShowMoveToAlbumModal}
        handleMovePhotoToAlbum={handleMovePhotoToAlbum}
        isMovingPhoto={isMovingPhoto}
        showRenameModal={showRenameModal}
        renamingAlbum={renamingAlbum}
        newAlbumName={newAlbumName}
        setNewAlbumName={setNewAlbumName}
        setShowRenameModal={setShowRenameModal}
        handleRenameAlbum={albumHandlers.handleRenameAlbum}
        showFolderModal={showFolderModal}
        setShowFolderModal={setShowFolderModal}
        folderModalError={folderModalError}
        setFolderModalError={setFolderModalError}
        folderManagement={{
          newFolderName: folderManagement.newFolderName,
          setNewFolderName: folderManagement.setNewFolderName,
          isCreatingFolder: folderManagement.isCreatingFolder,
          handleCreateFolder: async () => {
            const success = await folderManagement.createFolder(folderManagement.newFolderName);
            if (success) {
              setShowFolderModal(false);
              setFolderModalError('');
            } else {
              setFolderModalError('Failed to create folder');
            }
          },
        }}
        showDeleteFolderModal={showDeleteFolderModal}
        deletingFolderName={deletingFolderName}
        setShowDeleteFolderModal={setShowDeleteFolderModal}
        handleDeleteFolder={folderHandlers.handleDeleteFolder}
        showFolderDeleteModal={showFolderDeleteModal}
        setShowFolderDeleteModal={setShowFolderDeleteModal}
        folderToDelete={folderToDelete}
        handleDeleteFolderWithAlbums={folderHandlers.handleDeleteFolderWithAlbums}
        localFolders={localFolders}
        localAlbums={localAlbums}
        showNewAlbumModal={showNewAlbumModal}
        setShowNewAlbumModal={handleCloseNewAlbumModal}
        newAlbumNameInput={newAlbumModalName}
        setNewAlbumNameInput={setNewAlbumModalName}
        newAlbumPublished={newAlbumPublished}
        setNewAlbumPublished={setNewAlbumPublished}
        newAlbumModalError={newAlbumModalError}
        handleCreateAlbumSubmit={handleCreateAlbumFromModal}
        targetFolderId={targetFolderId}
        showShareModal={showShareModal}
        shareAlbumName={shareAlbumName}
        setShowShareModal={setShowShareModal}
        showMoveToFolderModal={showMoveToFolderModal}
        moveToFolderAlbumName={moveToFolderAlbumName}
        setShowMoveToFolderModal={setShowMoveToFolderModal}
        handleMoveToFolder={handleMoveToFolder}
        showConfirmModal={showConfirmModal}
        confirmConfig={confirmConfig}
        setShowConfirmModal={setShowConfirmModal}
      />
    </>
  );
};

export default AlbumsManager;
