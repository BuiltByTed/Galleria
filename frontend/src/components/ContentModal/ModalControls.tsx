/**
 * Modal Controls Component
 * Renders the top control buttons: info, copy link, download, play/pause, fullscreen, close
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Photo } from './types';
import {
  InfoIcon,
  CheckmarkIcon,
  LinkIcon,
  DownloadIcon,
  PlayIcon,
  PauseIcon,
  FullscreenIcon,
  CloseIcon,
} from '../icons/';

interface ModalControlsProps {
  show: boolean;
  showInfo: boolean;
  copiedLink: boolean;
  isFullscreen: boolean;
  isAutoplay: boolean;
  onToggleInfo: () => void;
  onCopyLink: (photo: Photo) => void;
  onDownload: (photo: Photo) => void;
  onToggleAutoplay: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  selectedPhoto: Photo;
  isVideo?: boolean;
  style?: React.CSSProperties;
}

const ModalControls: React.FC<ModalControlsProps> = ({
  show,
  showInfo,
  copiedLink,
  isFullscreen,
  isAutoplay,
  onToggleInfo,
  onCopyLink,
  onDownload,
  onToggleAutoplay,
  onToggleFullscreen,
  onClose,
  selectedPhoto,
  isVideo = false,
  style,
}) => {
  const { t } = useTranslation();
  const canDownload = !isVideo && selectedPhoto.downloads_enabled !== false && Boolean(selectedPhoto.download);
  
  return (
    <div
      className="modal-controls-top"
      style={{ opacity: show ? 1 : 0, ...style }}
    >
      <div className="modal-controls-left">
        {/* Info button */}
        <button
          onClick={onToggleInfo}
          className={showInfo ? 'active' : ''}
          title={t('photo.photoInformation')}
        >
          <InfoIcon width="20" height="20" />
        </button>

        {/* Copy link button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCopyLink(selectedPhoto);
          }}
          title={copiedLink ? t('photo.copied') : t('photo.copyLink')}
          className={copiedLink ? "copied" : ""}
        >
          {copiedLink ? (
            <CheckmarkIcon width="20" height="20" />
          ) : (
            <LinkIcon width="20" height="20" />
          )}
        </button>

        {/* Download button - hidden for videos */}
        {canDownload && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDownload(selectedPhoto);
            }}
            title={t('photo.downloadPhoto')}
          >
            <DownloadIcon width="20" height="20" />
          </button>
        )}
      </div>

      <div className="modal-controls-right">
        {/* Slideshow play/pause — next to fullscreen */}
        <button
          className={`slideshow-autoplay-toggle${isAutoplay ? ' active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleAutoplay();
          }}
          title={isAutoplay ? t('photo.pauseSlideshow') : t('photo.playSlideshow')}
          aria-pressed={isAutoplay}
          aria-label={isAutoplay ? t('photo.pauseSlideshow') : t('photo.playSlideshow')}
        >
          {isAutoplay ? (
            <PauseIcon width="20" height="20" />
          ) : (
            <PlayIcon width="20" height="20" />
          )}
        </button>

        {/* Fullscreen button */}
        <button
          className="fullscreen-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFullscreen();
          }}
          title={isFullscreen ? t('photo.exitFullscreen') : t('photo.fullscreen')}
        >
          <FullscreenIcon width="24" height="24" isExit={isFullscreen} />
        </button>

        {/* Close button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('photo.close')}
        >
          <CloseIcon width="24" height="24" />
        </button>
      </div>
    </div>
  );
};

export default ModalControls;
