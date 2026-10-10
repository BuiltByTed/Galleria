/**
 * Move to Album Modal
 * Select a destination album for a single photo/video
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '../../../icons';

interface AlbumOption {
  name: string;
  published?: boolean;
  photoCount?: number;
}

interface MoveToAlbumModalProps {
  photoTitle: string;
  filename: string;
  currentAlbum: string;
  albums: AlbumOption[];
  onClose: () => void;
  onMoveToAlbum: (destinationAlbum: string) => void;
  isMoving?: boolean;
}

const MoveToAlbumModal: React.FC<MoveToAlbumModalProps> = ({
  photoTitle,
  filename,
  currentAlbum,
  albums,
  onClose,
  onMoveToAlbum,
  isMoving = false,
}) => {
  const { t } = useTranslation();
  const destinations = albums
    .filter((a) => a.name !== currentAlbum)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const displayName = photoTitle || filename;

  return (
    <>
      <div className="modal-backdrop" onClick={isMoving ? undefined : onClose} />
      <div className="move-folder-modal">
        <div className="move-folder-modal-header">
          <h3>{t('albumsManager.moveToAlbumTitle')}</h3>
          <button
            onClick={onClose}
            className="modal-close-btn"
            disabled={isMoving}
            type="button"
          >
            <CloseIcon width="20" height="20" />
          </button>
        </div>
        <div className="move-folder-modal-body">
          <p className="move-folder-hint">
            {t('albumsManager.moveToAlbumHint', { name: displayName })}
          </p>
          <p className="move-folder-hint" style={{ opacity: 0.7, marginTop: '-0.5rem' }}>
            {t('albumsManager.moveToAlbumFrom', { album: currentAlbum })}
          </p>

          {destinations.length === 0 ? (
            <p className="move-folder-hint">
              {t('albumsManager.moveToAlbumNoDestinations')}
            </p>
          ) : (
            <div className="folder-list">
              {destinations.map((album) => (
                <button
                  key={album.name}
                  className="folder-option"
                  onClick={() => onMoveToAlbum(album.name)}
                  disabled={isMoving}
                  type="button"
                >
                  <span className="folder-option-icon">
                    {album.published === false ? '🔒' : '📷'}
                  </span>
                  <span className="folder-option-name">{album.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default MoveToAlbumModal;
