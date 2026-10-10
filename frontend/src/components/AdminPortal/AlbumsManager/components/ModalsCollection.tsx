/**
 * ModalsCollection Component
 * Contains all modal dialogs used in AlbumsManager
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../../../config';
import { createPortal } from 'react-dom';
import ShareModal from '../../ShareModal';
import MoveToFolderModal from './MoveToFolderModal';
import MoveToAlbumModal from './MoveToAlbumModal';
import { Photo, Folder } from '../types';
import { cacheBustValue } from '../../../../config';
import { MagicWandIcon, FolderArrowIcon } from '../../../icons';
import { error } from '../../../../utils/logger';
import VideoThumbnailPicker from './VideoThumbnailPicker';


interface ConfirmModalConfig {
  message: string;
  onConfirm: () => void;
  confirmText?: string;
  isDanger?: boolean;
  photo?: {
    thumbnail: string;
    title?: string;
    filename: string;
  };
}

interface ModalsCollectionProps {
  // Edit Photo Modal
  showEditModal: boolean;
  editingPhoto: Photo | null;
  editTitleValue: string;
  setEditTitleValue: (value: string) => void;
  editDescriptionValue: string;
  setEditDescriptionValue: (value: string) => void;
  handleCloseEditModal: () => void;
  handleSaveTitle: () => void;
  onOpenMoveFromEdit?: () => void;

  // Move Photo to Album Modal
  showMoveToAlbumModal?: boolean;
  movePhotoAlbum?: string | null;
  movePhotoFilename?: string | null;
  movePhotoTitle?: string;
  setShowMoveToAlbumModal?: (show: boolean) => void;
  handleMovePhotoToAlbum?: (destinationAlbum: string) => void;
  isMovingPhoto?: boolean;
  
  // Rename Album Modal
  showRenameModal: boolean;
  renamingAlbum: string | null;
  newAlbumName: string;
  setNewAlbumName: (value: string) => void;
  setShowRenameModal: (show: boolean) => void;
  handleRenameAlbum: () => void;
  
  // New Folder Modal
  showFolderModal: boolean;
  setShowFolderModal: (show: boolean) => void;
  folderModalError: string;
  setFolderModalError: (error: string) => void;
  folderManagement: {
    newFolderName: string;
    setNewFolderName: (value: string) => void;
    isCreatingFolder: boolean;
    handleCreateFolder: () => Promise<void>;
  };
  
  // Delete Folder Modal
  showDeleteFolderModal: boolean;
  deletingFolderName: string | null;
  setShowDeleteFolderModal: (show: boolean) => void;
  handleDeleteFolder: (folderName: string) => void;
  
  // Folder Delete Modal (with album options)
  showFolderDeleteModal: boolean;
  setShowFolderDeleteModal: (show: boolean) => void;
  folderToDelete: { name: string; albumCount: number } | null;
  handleDeleteFolderWithAlbums: (folderName: string, deleteAlbums: boolean) => void;
  
  localFolders: Folder[];
  localAlbums: any[];
  
  // New Album Modal
  showNewAlbumModal: boolean;
  setShowNewAlbumModal: (show: boolean) => void;
  newAlbumNameInput: string;
  setNewAlbumNameInput: (value: string) => void;
  newAlbumPublished: boolean;
  setNewAlbumPublished: (value: boolean) => void;
  newAlbumModalError: string;
  handleCreateAlbumSubmit: () => void;
  targetFolderId: number | null;
  
  // Share Modal
  showShareModal: boolean;
  shareAlbumName: string | null;
  setShowShareModal: (show: boolean) => void;
  
  // Move to Folder Modal
  showMoveToFolderModal: boolean;
  moveToFolderAlbumName: string | null;
  setShowMoveToFolderModal: (show: boolean) => void;
  handleMoveToFolder: (albumName: string, folderId: number | null) => void;
  
  // Confirm Modal
  showConfirmModal: boolean;
  confirmConfig: ConfirmModalConfig | null;
  setShowConfirmModal: (show: boolean) => void;
}

const ModalsCollection: React.FC<ModalsCollectionProps> = ({
  // Edit Photo Modal
  showEditModal,
  editingPhoto,
  editTitleValue,
  setEditTitleValue,
  editDescriptionValue,
  setEditDescriptionValue,
  handleCloseEditModal,
  handleSaveTitle,
  onOpenMoveFromEdit,

  // Move Photo to Album Modal
  showMoveToAlbumModal = false,
  movePhotoAlbum = null,
  movePhotoFilename = null,
  movePhotoTitle = '',
  setShowMoveToAlbumModal,
  handleMovePhotoToAlbum,
  isMovingPhoto = false,
  
  // Rename Album Modal
  showRenameModal,
  renamingAlbum,
  newAlbumName,
  setNewAlbumName,
  setShowRenameModal,
  handleRenameAlbum,
  
  // New Folder Modal
  showFolderModal,
  setShowFolderModal,
  folderModalError,
  setFolderModalError,
  folderManagement,
  
  // Delete Folder Modal
  showDeleteFolderModal,
  deletingFolderName,
  setShowDeleteFolderModal,
  handleDeleteFolder,
  
  // Folder Delete Modal (with album options)
  showFolderDeleteModal,
  setShowFolderDeleteModal,
  folderToDelete,
  handleDeleteFolderWithAlbums,
  
  localFolders,
  localAlbums,
  
  // New Album Modal
  showNewAlbumModal,
  setShowNewAlbumModal,
  newAlbumNameInput,
  setNewAlbumNameInput,
  newAlbumPublished,
  setNewAlbumPublished,
  newAlbumModalError,
  handleCreateAlbumSubmit,
  targetFolderId,
  
  // Share Modal
  showShareModal,
  shareAlbumName,
  setShowShareModal,
  
  // Move to Folder Modal
  showMoveToFolderModal,
  moveToFolderAlbumName,
  setShowMoveToFolderModal,
  handleMoveToFolder,
  
  // Confirm Modal
  showConfirmModal,
  confirmConfig,
  setShowConfirmModal,
}) => {
  const { t, i18n } = useTranslation();
  // Check if OpenAI is configured
  const [hasOpenAI, setHasOpenAI] = useState(false);
  const [generatingAITitle, setGeneratingAITitle] = useState(false);
  const [aiTitleError, setAiTitleError] = useState<string | null>(null);
  
  useEffect(() => {
    const checkOpenAI = async () => {
      try {
        const res = await fetch(`${API_URL}/api/config`, {
          credentials: 'include',
        });
        if (res.ok) {
          const config = await res.json();
          setHasOpenAI(!!config.openai?.apiKey);
        }
      } catch (err) {
        error('Failed to check OpenAI config:', err);
      }
    };
    
    if (showEditModal) {
      checkOpenAI();
      setAiTitleError(null); // Clear error when modal opens
    }
  }, [showEditModal]);
  
  // Generate AI title for current photo
  const handleGenerateAITitle = async () => {
    if (!editingPhoto || generatingAITitle) return;
    
    setGeneratingAITitle(true);
    setAiTitleError(null);
    try {
      const parts = editingPhoto.id.split('/');
      const album = parts[0];
      const filename = parts[1];
      
      const res = await fetch(`${API_URL}/api/ai-titles/generate-single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ album, filename, language: i18n.language }),
        credentials: 'include',
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t('albumsManager.failedToRetryAIGeneration'));
      }
      
      const data = await res.json();
      if (data.title) {
        setEditTitleValue(data.title);
      }
    } catch (err) {
      error('Failed to generate AI title:', err);
      setAiTitleError(err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setGeneratingAITitle(false);
    }
  };
  
  return (
    <>
      {/* Edit Photo/Video Title Modal */}
      {showEditModal && editingPhoto && createPortal(
        <div 
          className="edit-title-modal" 
          onClick={handleCloseEditModal}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
                  <h3>{t('albumsManager.editMetadata')}</h3>
              <button 
                className="modal-close-btn"
                onClick={handleCloseEditModal}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              {/* Only show thumbnail preview for photos, not videos */}
              {editingPhoto.media_type !== 'video' && (
                <div className="edit-modal-photo">
                  <img 
                    src={`${API_URL}${editingPhoto.thumbnail}?i=${cacheBustValue}`}
                    alt=""
                  />
                </div>
              )}
              
              {/* Video Thumbnail Picker - show first for videos */}
              {editingPhoto.media_type === 'video' && (
                <VideoThumbnailPicker
                  album={editingPhoto.album}
                  filename={editingPhoto.id.split('/').pop() || editingPhoto.id}
                  onThumbnailUpdated={() => {
                    // Force thumbnail reload everywhere by updating timestamp
                    const timestamp = Date.now();
                    
                    // Update modal thumbnail
                    const modalImg = document.querySelector('.edit-modal-photo img') as HTMLImageElement;
                    if (modalImg) {
                      const src = modalImg.src.split('?')[0];
                      modalImg.src = `${src}?t=${timestamp}`;
                    }
                    
                    // Update grid/list thumbnails for this video
                    const gridImages = document.querySelectorAll(`img[src*="${editingPhoto.thumbnail}"]`);
                    gridImages.forEach((img) => {
                      const htmlImg = img as HTMLImageElement;
                      const src = htmlImg.src.split('?')[0];
                      htmlImg.src = `${src}?i=${timestamp}`;
                    });
                  }}
                />
              )}
              
              <div className="edit-modal-info" style={{ marginTop: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'rgba(255, 255, 255, 0.9)' }}>
                  {t('albumsManager.titleLabel')}
                </label>
                <div style={{ position: 'relative', marginBottom: '1rem' }}>
                  <input
                    type="text"
                    value={editTitleValue}
                    onChange={(e) => setEditTitleValue(e.target.value)}
                    className="edit-modal-input"
                    placeholder={t('albumsManager.enterTitle')}
                    style={{ paddingRight: hasOpenAI ? '3rem' : undefined }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSaveTitle();
                      } else if (e.key === 'Escape') {
                        handleCloseEditModal();
                      }
                    }}
                  />
                  {hasOpenAI && (
                    <button
                      onClick={handleGenerateAITitle}
                      disabled={generatingAITitle}
                      style={{
                        position: 'absolute',
                        right: '0.5rem',
                        top: '55%',
                        transform: 'translateY(-50%)',
                        background: 'transparent',
                        border: 'none',
                        cursor: generatingAITitle ? 'wait' : 'pointer',
                        color: generatingAITitle ? '#888' : '#4ade80',
                        padding: '0.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s ease',
                        opacity: generatingAITitle ? 0.5 : 1,
                      }}
                      title={generatingAITitle ? t('albumsManager.generatingAITitle') : t('albumsManager.generateAITitle')}
                      type="button"
                    >
                      {generatingAITitle ? (
                        <div style={{
                          width: '18px',
                          height: '18px',
                          border: '1px solid transparent',
                          borderTopColor: '#888',
                          borderRadius: '50%',
                          animation: 'spin 0.8s linear infinite'
                        }} />
                      ) : (
                        <MagicWandIcon width="18" height="18" />
                      )}
                    </button>
                  )}
                </div>
                {aiTitleError && (
                  <p style={{ 
                    color: '#ff4444', 
                    fontSize: '0.875rem', 
                    marginTop: '-0.5rem',
                    marginBottom: '1rem'
                  }}>
                    {aiTitleError}
                  </p>
                )}
                
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'rgba(255, 255, 255, 0.9)' }}>
                  {t('albumsManager.descriptionLabel')}
                </label>
                <textarea
                  value={editDescriptionValue}
                  onChange={(e) => setEditDescriptionValue(e.target.value)}
                  className="edit-modal-input"
                  placeholder={t('albumsManager.enterDescription')}
                  rows={3}
                  style={{ resize: 'vertical', minHeight: '80px' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.ctrlKey) {
                      handleSaveTitle();
                    } else if (e.key === 'Escape') {
                      handleCloseEditModal();
                    }
                  }}
                />
              </div>
            </div>
            
            <div className="edit-modal-footer" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              {onOpenMoveFromEdit && (
                <button
                  onClick={onOpenMoveFromEdit}
                  className="btn-secondary"
                  type="button"
                  style={{
                    flex: '1 1 100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                  }}
                >
                  <FolderArrowIcon width="16" height="16" />
                  {t('albumsManager.moveToAlbum')}
                </button>
              )}
              <button 
                onClick={handleCloseEditModal}
                className="btn-secondary"
                style={{ flex: 1 }}
              >
                {t('common.cancel')}
              </button>
              <button 
                className="btn-primary"
                onClick={handleSaveTitle}
                style={{ flex: 1 }}
              >
                {t('albumsManager.saveTitle')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Move Photo to Album Modal */}
      {showMoveToAlbumModal && movePhotoAlbum && movePhotoFilename && setShowMoveToAlbumModal && handleMovePhotoToAlbum && createPortal(
        <MoveToAlbumModal
          photoTitle={movePhotoTitle || ''}
          filename={movePhotoFilename}
          currentAlbum={movePhotoAlbum}
          albums={localAlbums}
          onClose={() => !isMovingPhoto && setShowMoveToAlbumModal(false)}
          onMoveToAlbum={handleMovePhotoToAlbum}
          isMoving={isMovingPhoto}
        />,
        document.body
      )}

      {/* Rename Album Modal */}
      {showRenameModal && renamingAlbum && createPortal(
        <div 
          className="edit-title-modal" 
          onClick={() => setShowRenameModal(false)}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>{t('albumsManager.renameAlbum')}</h3>
              <button 
                className="modal-close-btn"
                onClick={() => setShowRenameModal(false)}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              <div className="edit-modal-info" style={{ width: '100%' }}>
                <label className="edit-modal-label">{t('albumsManager.currentName')}</label>
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(255, 255, 255, 0.05)', 
                  borderRadius: '4px',
                  marginBottom: '1rem',
                  color: '#888'
                }}>
                  {renamingAlbum}
                </div>
                
                <label className="edit-modal-label">{t('albumsManager.newName')}</label>
                <input
                  type="text"
                  value={newAlbumName}
                  onChange={(e) => setNewAlbumName(e.target.value)}
                  className="edit-modal-input"
                  placeholder={t('albumsManager.enterNewAlbumName')}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleRenameAlbum();
                    } else if (e.key === 'Escape') {
                      setShowRenameModal(false);
                    }
                  }}
                />
                <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                  {t('albumsManager.albumNameRules')}
                </p>
              </div>
            </div>
            
            <div className="edit-modal-footer">
              <button
                onClick={() => setShowRenameModal(false)}
                className="btn-secondary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleRenameAlbum}
                className="btn-primary"
              >
                {t('albumsManager.renameAlbum')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* New Folder Modal */}
      {showFolderModal && createPortal(
        <div 
          className="edit-title-modal" 
          onClick={() => {
            setShowFolderModal(false);
            setFolderModalError('');
          }}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>{t('albumsManager.createFolder')}</h3>
              <button 
                className="modal-close-btn"
                onClick={() => {
                  setShowFolderModal(false);
                  setFolderModalError('');
                }}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              <div className="edit-modal-info" style={{ width: '100%', marginTop: '1rem' }}>
                <label className="edit-modal-label">{t('albumsManager.folderName')}</label>
                <input
                  type="text"
                  value={folderManagement.newFolderName}
                  onChange={(e) => folderManagement.setNewFolderName(e.target.value)}
                  className="edit-modal-input"
                  placeholder={t('albumsManager.folderNamePlaceholder')}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !folderManagement.isCreatingFolder) {
                      folderManagement.handleCreateFolder();
                    } else if (e.key === 'Escape') {
                      setShowFolderModal(false);
                      setFolderModalError('');
                    }
                  }}
                />
                {folderModalError && (
                  <p style={{ color: '#ff4444', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                    {folderModalError}
                  </p>
                )}
                <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                  {t('albumsManager.foldersHelpOrganize')}
                </p>
              </div>
            </div>
            
            <div className="edit-modal-footer">
              <button
                onClick={() => {
                  setShowFolderModal(false);
                  setFolderModalError('');
                }}
                className="btn-secondary"
                disabled={folderManagement.isCreatingFolder}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={folderManagement.handleCreateFolder}
                className="btn-primary"
                disabled={folderManagement.isCreatingFolder}
              >
                {folderManagement.isCreatingFolder ? t('common.creating') : t('albumsManager.createFolder')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Folder Confirmation Modal */}
      {showDeleteFolderModal && deletingFolderName && createPortal(
        <div 
          className="edit-title-modal" 
          onClick={() => setShowDeleteFolderModal(false)}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>{t('albumsManager.deleteFolder')}</h3>
              <button 
                className="modal-close-btn"
                onClick={() => setShowDeleteFolderModal(false)}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              <div className="edit-modal-info" style={{ width: '100%' }}>
                <p style={{ marginBottom: '1rem' }}>
                  {t('albumsManager.deleteFolderConfirm', { folderName: deletingFolderName })}
                </p>
                
                {(() => {
                  const folder = localFolders.find(f => f.name === deletingFolderName);
                  const albumsInFolder = localAlbums.filter(a => a.folder_id === folder?.id);
                  
                  if (albumsInFolder.length > 0) {
                    return (
                      <div style={{ 
                        padding: '1rem', 
                        background: 'rgba(255, 180, 0, 0.1)', 
                        border: '1px solid rgba(255, 180, 0, 0.3)',
                        borderRadius: '4px',
                        marginBottom: '1rem'
                      }}>
                        <p style={{ color: '#ffb400', marginBottom: '0.5rem', fontWeight: 600 }}>
                          {t('albumsManager.deleteFolderWarning')}
                        </p>
                        <p style={{ color: '#ffb400', marginBottom: '0.5rem' }} dangerouslySetInnerHTML={{
                          __html: t('albumsManager.folderContainsAlbums', { 
                            count: albumsInFolder.length,
                            album: albumsInFolder.length !== 1 ? t('common.albums') : t('common.album')
                          })
                        }} />
                        <ul style={{ 
                          color: '#ffb400', 
                          marginLeft: '1.5rem', 
                          marginTop: '0.5rem',
                          marginBottom: '0.5rem'
                        }}>
                          {albumsInFolder.slice(0, 5).map(album => (
                            <li key={album.name}>{album.name}</li>
                          ))}
                          {albumsInFolder.length > 5 && (
                            <li>{t('albumsManager.andMore', { count: albumsInFolder.length - 5 })}</li>
                          )}
                        </ul>
                        <p style={{ color: '#ffb400', marginTop: '0.5rem' }} dangerouslySetInnerHTML={{
                          __html: t('albumsManager.albumsWillMoveToUncategorized')
                        }} />
                      </div>
                    );
                  }
                  
                  return null;
                })()}
                
                <p style={{ color: '#888', fontSize: '0.9rem' }}>
                  {t('common.actionCannotBeUndone')}
                </p>
              </div>
            </div>
            
            <div className="edit-modal-footer">
              <button
                onClick={() => setShowDeleteFolderModal(false)}
                className="btn-secondary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  handleDeleteFolder(deletingFolderName);
                  setShowDeleteFolderModal(false);
                }}
                className="btn-danger"
              >
                {t('albumsManager.deleteFolder')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Folder Delete Modal (with album options) */}
      {showFolderDeleteModal && folderToDelete && createPortal(
        <div 
          className="edit-title-modal" 
          onClick={() => setShowFolderDeleteModal(false)}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '550px' }}>
            <div className="edit-modal-header">
              <h3>{t('albumsManager.deleteFolderQuestion')}</h3>
              <button 
                className="modal-close-btn"
                onClick={() => setShowFolderDeleteModal(false)}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              <div className="edit-modal-info" style={{ width: '100%', marginTop: '1rem' }}>
                {/* Option 1: Release Albums */}
                <div
                  onClick={() => {
                    handleDeleteFolderWithAlbums(folderToDelete.name, false);
                    setShowFolderDeleteModal(false);
                  }}
                  style={{
                    padding: '1rem',
                    background: 'rgba(34, 197, 94, 0.1)',
                    border: '1px solid rgba(34, 197, 94, 0.3)',
                    borderRadius: '6px',
                    marginBottom: '0.75rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(34, 197, 94, 0.15)';
                    e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.5)';
                    e.currentTarget.style.transform = 'translateX(4px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(34, 197, 94, 0.1)';
                    e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                    e.currentTarget.style.transform = 'translateX(0)';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <span style={{ fontSize: '1.4rem', marginTop: '1px' }}>📤</span>
                    <div>
                      <p style={{ 
                        fontWeight: 600, 
                        fontSize: '0.95rem',
                        marginBottom: '0.35rem',
                        color: '#4ade80'
                      }}>
                        {t('albumsManager.releaseAlbums', { count: folderToDelete.albumCount, album: folderToDelete.albumCount === 1 ? t('common.album') : t('common.albums') })}
                      </p>
                      <p style={{ 
                        fontSize: '0.85rem', 
                        color: '#aaa',
                        margin: 0,
                        lineHeight: '1.3'
                      }}>
                        {t('albumsManager.releaseAlbumsDescription')}
                      </p>
                    </div>
                  </div>
                </div>
                
                {/* Option 2: Delete All */}
                <div
                  onClick={() => {
                    handleDeleteFolderWithAlbums(folderToDelete.name, true);
                    setShowFolderDeleteModal(false);
                  }}
                  style={{
                    padding: '1rem',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                    e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
                    e.currentTarget.style.transform = 'translateX(4px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                    e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                    e.currentTarget.style.transform = 'translateX(0)';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <span style={{ fontSize: '1.4rem', marginTop: '1px' }}>🗑️</span>
                    <div>
                      <p style={{ 
                        fontWeight: 600, 
                        fontSize: '0.95rem',
                        marginBottom: '0.35rem',
                        color: '#f87171'
                      }}>
                        {t('albumsManager.deleteEverything')}
                      </p>
                      <p style={{ 
                        fontSize: '0.85rem', 
                        color: '#aaa',
                        margin: 0,
                        lineHeight: '1.3'
                      }}>
                        {t('albumsManager.deleteEverythingDescription')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="edit-modal-footer">
              <button
                onClick={() => setShowFolderDeleteModal(false)}
                className="btn-secondary"
                style={{ width: '100%' }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* New Album Modal */}
      {showNewAlbumModal && createPortal(
        <div 
          className="edit-title-modal" 
          onClick={() => setShowNewAlbumModal(false)}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>{t('albumsManager.createAlbum')}</h3>
              <button 
                className="modal-close-btn"
                onClick={() => setShowNewAlbumModal(false)}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              <div className="edit-modal-info" style={{ width: '100%', marginTop: '1rem' }}>
                <label className="edit-modal-label">{t('albumsManager.albumName')}</label>
                <input
                  type="text"
                  value={newAlbumNameInput}
                  onChange={(e) => setNewAlbumNameInput(e.target.value)}
                  className="edit-modal-input"
                  placeholder={t('albumsManager.albumNamePlaceholder')}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleCreateAlbumSubmit();
                    } else if (e.key === 'Escape') {
                      setShowNewAlbumModal(false);
                    }
                  }}
                />
                {newAlbumModalError && newAlbumModalError === 'HOMEPAGE_RESERVED' ? (
                  <div style={{ 
                    marginTop: '1rem',
                    padding: '1rem',
                    background: 'rgba(59, 130, 246, 0.1)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '8px'
                  }}>
                    <p style={{ color: '#60a5fa', fontSize: '0.95rem', margin: '0 0 0.75rem 0', fontWeight: 500 }}>
                      {t('albumsManager.homepageReservedMessage')}
                    </p>
                    <p style={{ color: '#ccc', fontSize: '0.9rem', margin: '0 0 0.75rem 0', lineHeight: '1.5' }}>
                      {t('albumsManager.homepageReservedInstructions')}
                    </p>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.75rem',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '6px',
                      border: '1px solid rgba(255, 255, 255, 0.1)'
                    }}>
                      <span style={{ color: '#aaa', fontSize: '0.9rem' }}>{t('albumsManager.showOnHomepage')}</span>
                      <div style={{
                        position: 'relative',
                        width: '44px',
                        height: '24px',
                        background: '#4ade80',
                        borderRadius: '12px',
                        boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)'
                      }}>
                        <div style={{
                          position: 'absolute',
                          top: '2px',
                          right: '2px',
                          width: '20px',
                          height: '20px',
                          background: '#fff',
                          borderRadius: '50%',
                          boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                        }} />
                      </div>
                    </div>
                  </div>
                ) : newAlbumModalError ? (
                  <p style={{ color: '#ff4444', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                    {newAlbumModalError}
                  </p>
                ) : null}
                {!newAlbumModalError && (
                  <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                    {t('albumsManager.albumNameRules')}
                  </p>
                )}
                
                {(() => {
                  // If creating in uncategorized (no folder), show the publish toggle
                  if (targetFolderId === null) {
                    return (
                      <div style={{ marginTop: '1rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={newAlbumPublished}
                            onChange={(e) => setNewAlbumPublished(e.target.checked)}
                            style={{ 
                              marginRight: '0.75rem',
                              width: '18px',
                              height: '18px',
                              cursor: 'pointer'
                            }}
                          />
                          <span style={{ color: '#fff', fontSize: '1rem' }}>{t('albumsManager.publishAlbumImmediately')}</span>
                        </label>
                        <p style={{ color: '#aaa', fontSize: '0.875rem', marginTop: '0.375rem', marginLeft: '1.875rem' }}>
                          {t('albumsManager.publishedAlbumsVisible')}
                        </p>
                      </div>
                    );
                  }
                  
                  // If creating in a folder, check if folder is published
                  const targetFolder = localFolders.find(f => f.id === targetFolderId);
                  if (targetFolder && targetFolder.published) {
                    // Published folder - show green informational text (localized below)
                    return (
                      <div style={{ 
                        marginTop: '1rem',
                        padding: '0.75rem 1rem',
                        background: 'rgba(34, 197, 94, 0.1)',
                        border: '1px solid rgba(34, 197, 94, 0.3)',
                        borderRadius: '6px'
                      }}>
                        <p style={{ color: '#4ade80', fontSize: '0.9rem', margin: 0 }}>
                          {t('albumsManager.albumWillBePublished')}
                        </p>
                        <p style={{ color: '#aaa', fontSize: '0.85rem', marginTop: '0.25rem', marginBottom: 0 }}>
                          {t('albumsManager.albumsInPublishedFolders')}
                        </p>
                      </div>
                    );
                  } else if (targetFolder && !targetFolder.published) {
                    // Unpublished folder - show lock informational text
                    return (
                      <div style={{ 
                        marginTop: '1rem',
                        padding: '0.75rem 1rem',
                        background: 'rgba(255, 180, 0, 0.1)',
                        border: '1px solid rgba(255, 180, 0, 0.3)',
                        borderRadius: '6px'
                      }}>
                        <p style={{ color: '#ffb400', fontSize: '0.9rem', margin: 0 }}>
                          {t('albumsManager.albumWillBePrivate')}
                        </p>
                        <p style={{ color: '#aaa', fontSize: '0.85rem', marginTop: '0.25rem', marginBottom: 0 }}>
                          {t('albumsManager.albumsInUnpublishedFolders')}
                        </p>
                      </div>
                    );
                  }
                  
                  return null;
                })()}
              </div>
            </div>
            
            <div className="edit-modal-footer">
              <button
                onClick={() => setShowNewAlbumModal(false)}
                className="btn-secondary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreateAlbumSubmit}
                className="btn-primary"
              >
                {t('albumsManager.createAlbum')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Share Modal */}
      {showShareModal && shareAlbumName && (
        <ShareModal
          album={shareAlbumName}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {/* Move to Folder Modal */}
      {showMoveToFolderModal && moveToFolderAlbumName && (
        <MoveToFolderModal
          albumName={moveToFolderAlbumName}
          folders={localFolders}
          currentFolderId={localAlbums.find(a => a.name === moveToFolderAlbumName)?.folder_id}
          onClose={() => setShowMoveToFolderModal(false)}
          onMoveToFolder={handleMoveToFolder}
        />
      )}

      {/* Generic Confirmation Modal */}
      {showConfirmModal && confirmConfig && (
        <div 
          className="edit-title-modal" 
          onClick={() => setShowConfirmModal(false)}
        >
          <div className="edit-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h3>{confirmConfig.photo 
                ? (confirmConfig.confirmText?.includes('video') || confirmConfig.confirmText?.includes('Video') 
                    ? t('albumsManager.deleteVideoQuestion') 
                    : t('albumsManager.deletePhotoQuestion'))
                : t('albumsManager.confirmAction')}</h3>
              <button 
                className="modal-close-btn"
                onClick={() => setShowConfirmModal(false)}
                title={t('common.close')}
              >
                ×
              </button>
            </div>
            
            <div className="edit-modal-body">
              <div className="edit-modal-info" style={{ width: '100%', marginTop: '1rem' }}>
                {confirmConfig.photo ? (
                  <div style={{ 
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center'
                  }}>
                    <div className="edit-modal-photo">
                      <img 
                        src={`${API_URL}${confirmConfig.photo.thumbnail}?i=${cacheBustValue}`}
                        alt=""
                      />
                    </div>
                  </div>
                ) : (
                  <p style={{ color: '#ccc', margin: 0 }}>{confirmConfig.message}</p>
                )}
              </div>
            </div>
            
            <div className="edit-modal-footer">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="btn-secondary"
                style={{ flex: 1 }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  confirmConfig.onConfirm();
                  setShowConfirmModal(false);
                }}
                className={confirmConfig.isDanger ? 'btn-danger' : 'btn-primary'}
                style={{ flex: 1 }}
              >
                {confirmConfig.confirmText || t('albumsManager.confirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ModalsCollection;

