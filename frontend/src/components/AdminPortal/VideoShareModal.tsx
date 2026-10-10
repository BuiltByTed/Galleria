/**
 * VideoShareModal Component
 * Modal for listing, creating, and revoking share links for individual videos
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL, SITE_URL } from '../../config';
import { trackShareLinkCreated, trackShareLinkDeleted } from '../../utils/analytics';
import { formatDate } from '../../utils/formatters';
import CustomDropdown from './ConfigManager/components/CustomDropdown';
import './GenericModal.css';
import { error as logError } from '../../utils/logger';

interface VideoShareModalProps {
  album: string;
  filename: string;
  videoTitle: string;
  onClose: () => void;
}

interface ShareLinkItem {
  id: number;
  album: string;
  secretKey: string;
  expiresAt: string | null;
  createdAt: string;
  expired: boolean;
}

const getExpirationOptions = (t: (key: string) => string) => [
  { minutes: 60, label: t('shareModal.oneHour') },
  { minutes: 1440, label: t('shareModal.oneDay') },
  { minutes: 10080, label: t('shareModal.oneWeek') },
  { minutes: 43200, label: t('shareModal.oneMonth') },
  { minutes: null, label: t('shareModal.never') },
  { minutes: -1, label: t('shareModal.custom') },
];

function videoLinkUrl(secretKey: string, filename: string): string {
  return `${SITE_URL}/shared/${secretKey}?video=${encodeURIComponent(filename)}`;
}

export default function VideoShareModal({ album, filename, videoTitle, onClose }: VideoShareModalProps) {
  const { t } = useTranslation();
  const [selectedExpiration, setSelectedExpiration] = useState<number | null>(1440);
  const [links, setLinks] = useState<ShareLinkItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [customMinutes, setCustomMinutes] = useState<string>('');

  const loadLinks = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${API_URL}/api/share-links/album/${encodeURIComponent(album)}`,
        { credentials: 'include' }
      );
      if (!response.ok) {
        throw new Error(t('shareModal.failedToLoad'));
      }
      const data = await response.json();
      setLinks(data.shareLinks || []);
    } catch (err) {
      logError('Error loading share links:', err);
      setError(err instanceof Error ? err.message : t('shareModal.failedToLoad'));
    } finally {
      setListLoading(false);
    }
  }, [album, t]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  const createLink = async (expirationMinutes: number | null) => {
    setCreating(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/share-links/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          album,
          expirationMinutes,
        }),
      });

      if (!response.ok) {
        throw new Error(t('shareModal.failedToCreate'));
      }

      const data = await response.json();
      trackShareLinkCreated(album, expirationMinutes);

      if (data.shareLink) {
        const created: ShareLinkItem = {
          id: data.shareLink.id,
          album: data.shareLink.album,
          secretKey: data.shareLink.secretKey,
          expiresAt: data.shareLink.expiresAt,
          createdAt: data.shareLink.createdAt,
          expired: false,
        };
        setLinks((prev) => [created, ...prev.filter((l) => l.id !== created.id)]);
      } else {
        await loadLinks();
      }
    } catch (err) {
      logError('Error generating video share link:', err);
      setError(err instanceof Error ? err.message : t('shareModal.failedToGenerate'));
    } finally {
      setCreating(false);
    }
  };

  const handleExpirationChange = (newExpiration: number | null) => {
    if (newExpiration === -1) {
      setIsCustom(true);
      return;
    }
    setIsCustom(false);
    setCustomMinutes('');
    setSelectedExpiration(newExpiration);
  };

  const handleCreateClick = () => {
    if (isCustom) {
      const minutes = parseInt(customMinutes, 10);
      if (isNaN(minutes) || minutes < 1) {
        setError(t('shareModal.invalidCustomTime'));
        return;
      }
      setSelectedExpiration(minutes);
      createLink(minutes);
      return;
    }
    createLink(selectedExpiration);
  };

  const handleCopy = async (link: ShareLinkItem) => {
    try {
      await navigator.clipboard.writeText(videoLinkUrl(link.secretKey, filename));
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 2000);
    } catch (err) {
      logError('Failed to copy link:', err);
    }
  };

  const handleRevoke = async (link: ShareLinkItem) => {
    setRevokingId(link.id);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/share-links/${link.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(t('shareModal.failedToRevoke'));
      }
      trackShareLinkDeleted(album, link.id);
      setLinks((prev) => prev.filter((l) => l.id !== link.id));
    } catch (err) {
      logError('Error revoking share link:', err);
      setError(err instanceof Error ? err.message : t('shareModal.failedToRevoke'));
    } finally {
      setRevokingId(null);
    }
  };

  const formatExpiry = (link: ShareLinkItem) => {
    if (link.expired) {
      return t('shareModal.expired');
    }
    if (!link.expiresAt) {
      return t('shareModal.neverExpires');
    }
    return formatDate(link.expiresAt);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="generic-modal" onClick={(e) => e.stopPropagation()}>
        <div className="generic-modal-header">
          <h2>{t('videoShare.shareVideo')}</h2>
          <button className="close-button" onClick={onClose} type="button">
            ×
          </button>
        </div>

        <div className="generic-modal-content">
          <div className="video-share-info">
            <div className="video-share-title">{videoTitle}</div>
            <div className="video-share-album">{album}</div>
          </div>

          <p className="share-description">
            {t('videoShare.description')}
          </p>

          <div className="share-links-section">
            <h3 className="share-links-heading">{t('shareModal.activeLinks')}</h3>
            {listLoading ? (
              <div className="share-loading">{t('shareModal.loadingLinks')}</div>
            ) : links.length === 0 ? (
              <div className="share-links-empty">{t('shareModal.noActiveLinks')}</div>
            ) : (
              <ul className="share-links-list">
                {links.map((link) => (
                  <li
                    key={link.id}
                    className={`share-link-row${link.expired ? ' share-link-row--expired' : ''}`}
                  >
                    <div className="share-link-meta">
                      <div className="share-link-meta-line">
                        <span className="share-link-meta-label">{t('shareModal.created')}:</span>{' '}
                        {formatDate(link.createdAt)}
                      </div>
                      <div className="share-link-meta-line">
                        <span className="share-link-meta-label">{t('shareModal.expires')}:</span>{' '}
                        {formatExpiry(link)}
                      </div>
                    </div>
                    <div className="share-link-row-actions">
                      <button
                        type="button"
                        className="share-link-action-btn share-link-copy-btn"
                        onClick={() => handleCopy(link)}
                        disabled={link.expired}
                      >
                        {copiedId === link.id ? t('shareModal.copied') : t('shareModal.copyLink')}
                      </button>
                      <button
                        type="button"
                        className="share-link-action-btn share-link-revoke-btn"
                        onClick={() => handleRevoke(link)}
                        disabled={revokingId === link.id}
                      >
                        {revokingId === link.id ? t('shareModal.revoking') : t('shareModal.revoke')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="share-create-section">
            <h3 className="share-links-heading">{t('shareModal.createNew')}</h3>
            <div className="expiration-selector">
              <label htmlFor="expiration" style={{ display: 'block', marginBottom: '0.5rem' }}>
                {t('shareModal.linkExpiresIn')}:
              </label>
              <CustomDropdown
                value={isCustom ? '-1' : (selectedExpiration === null ? 'null' : String(selectedExpiration))}
                options={getExpirationOptions(t).map((option) => ({
                  value: option.minutes === null ? 'null' : String(option.minutes),
                  label: option.label,
                  emoji: option.minutes === null ? '♾️' :
                         option.minutes === -1 ? '⚙️' :
                         option.minutes <= 60 ? '⏱️' :
                         option.minutes <= 1440 ? '⏰' :
                         option.minutes <= 10080 ? '📅' : '📆'
                }))}
                onChange={(value) => {
                  const newExpiration = value === 'null' ? null : parseInt(value, 10);
                  handleExpirationChange(newExpiration);
                }}
                disabled={creating}
                portal
              />
            </div>

            {isCustom && (
              <div className="custom-expiration-input">
                <input
                  type="number"
                  min="1"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  placeholder={t('shareModal.enterMinutes')}
                />
              </div>
            )}

            {error && <div className="share-error">{error}</div>}

            <button
              type="button"
              className="copy-link-button"
              onClick={handleCreateClick}
              disabled={creating || listLoading}
            >
              {creating ? t('shareModal.generating') : t('shareModal.createLink')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
