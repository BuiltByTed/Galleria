/**
 * Info Panel Component
 * Displays photo/video metadata and EXIF/video data
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Photo, ExifData } from './types';
import { formatFileSize } from '../../utils/formatters';
import { API_URL } from '../../config';
import LinkifiedText from '../LinkifiedText';

interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  rotation: number;
}

interface InfoPanelProps {
  show: boolean;
  photo: Photo;
  exifData: ExifData | null;
  loadingExif: boolean;
  imageTitle?: string | null;
  secretKey?: string;
  style?: React.CSSProperties;
}

/** Convert DMS [deg, min, sec] or decimal degrees, applying N/S/E/W ref. */
function dmsToDecimal(value: number | number[] | undefined, ref?: string): number | null {
  if (value === undefined || value === null) return null;
  let decimal: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    decimal = value;
  } else if (Array.isArray(value) && value.length >= 1) {
    const d = Number(value[0]) || 0;
    const m = Number(value[1]) || 0;
    const s = Number(value[2]) || 0;
    decimal = d + m / 60 + s / 3600;
    if (!Number.isFinite(decimal)) return null;
  } else {
    return null;
  }
  if (ref === 'S' || ref === 'W') {
    decimal = -Math.abs(decimal);
  }
  return decimal;
}

/** Prefer exifr latitude/longitude; fall back to raw GPS tags. */
function getGpsCoords(exif: ExifData): { lat: number; lon: number } | null {
  const lat =
    typeof exif.latitude === 'number' && Number.isFinite(exif.latitude)
      ? exif.latitude
      : dmsToDecimal(exif.GPSLatitude, exif.GPSLatitudeRef);
  const lon =
    typeof exif.longitude === 'number' && Number.isFinite(exif.longitude)
      ? exif.longitude
      : dmsToDecimal(exif.GPSLongitude, exif.GPSLongitudeRef);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function formatCoord(value: number, isLat: boolean): string {
  const abs = Math.abs(value);
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  return `${abs.toFixed(5)}° ${hemi}`;
}

function openStreetMapUrl(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
}

// formatFileSize function moved to utils/formatters.ts

const InfoPanel: React.FC<InfoPanelProps> = ({
  show,
  photo,
  exifData,
  loadingExif,
  imageTitle,
  secretKey,
  style,
}) => {
  const { t, i18n } = useTranslation();
  const [videoMetadata, setVideoMetadata] = useState<VideoMetadata | null>(null);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const isVideo = photo.media_type === 'video';
  
  // Fetch video metadata when showing info panel for a video
  useEffect(() => {
    if (show && isVideo) {
      const fetchVideoMetadata = async () => {
        setLoadingVideo(true);
        try {
          const filename = photo.id.split('/').pop();
          const queryString = secretKey ? `?key=${encodeURIComponent(secretKey)}` : '';
          const res = await fetch(`${API_URL}/api/videos/${photo.album}/${filename}/metadata${queryString}`, {
            credentials: 'include'
          });
          
          if (res.ok) {
            const data = await res.json();
            setVideoMetadata(data);
          }
        } catch (err) {
          console.error('Failed to fetch video metadata:', err);
        } finally {
          setLoadingVideo(false);
        }
      };
      
      fetchVideoMetadata();
    }
  }, [show, isVideo, photo.album, photo.id, secretKey]);
  
  // Format duration from seconds to MM:SS or HH:MM:SS
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };
  
  if (!show) return null;

  const gpsCoords =
    !isVideo && exifData && !exifData.error ? getGpsCoords(exifData) : null;

  return (
    <div className="modal-info-panel" style={style}>
      {imageTitle && (
        <div className="info-item" style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          <span className="info-value">{imageTitle}</span>
        </div>
      )}
      
      {photo.description && (
        <div className="info-item" style={{ fontSize: '0.95rem', marginBottom: '1rem', opacity: 0.9 }}>
          <span className="info-value">
            <LinkifiedText text={photo.description} />
          </span>
        </div>
      )}
      
      <div className="info-item">
        <span className="info-label">{t('photo.file')}:</span>
        <span className="info-value">{photo.id.split('/').pop()}</span>
      </div>
      
      <div className="info-item">
        <span className="info-label">{t('photo.titleLabel')}:</span>
        <span className="info-value">{photo.title}</span>
      </div>
      
      <div className="info-item">
        <span className="info-label">{t('photo.albumLabel')}:</span>
        <span className="info-value">{photo.album}</span>
      </div>
      
      {photo.metadata && (
        <div className="info-item">
          <span className="info-label">{t('photo.size')}:</span>
          <span className="info-value">{formatFileSize(photo.metadata.size)}</span>
        </div>
      )}
      
      {/* Video metadata section */}
      {isVideo && loadingVideo && (
        <div className="info-item">
          <span className="info-value">{t('photo.loadingExif')}</span>
        </div>
      )}
      
      {isVideo && videoMetadata && (
        <>
          <div className="info-item">
            <span className="info-label">{t('video.resolution')}:</span>
            <span className="info-value">{videoMetadata.width}x{videoMetadata.height}</span>
          </div>
          
          <div className="info-item">
            <span className="info-label">{t('video.duration')}:</span>
            <span className="info-value">{formatDuration(videoMetadata.duration)}</span>
          </div>
        </>
      )}
      
      {/* Photo EXIF section */}
      {!isVideo && loadingExif && (
        <div className="info-item">
          <span className="info-value">{t('photo.loadingExif')}</span>
        </div>
      )}
      
      {!isVideo && exifData && !exifData.error && (
        <>
          {exifData.Make && (
            <div className="info-item">
              <span className="info-label">{t('photo.camera')}:</span>
              <span className="info-value">{exifData.Make} {exifData.Model}</span>
            </div>
          )}
          
          {exifData.LensModel && (
            <div className="info-item">
              <span className="info-label">{t('photo.lens')}:</span>
              <span className="info-value">{exifData.LensModel}</span>
            </div>
          )}
          
          {exifData.FocalLength && (
            <div className="info-item">
              <span className="info-label">{t('photo.focalLength')}:</span>
              <span className="info-value">{exifData.FocalLength}mm</span>
            </div>
          )}
          
          {exifData.FNumber && (
            <div className="info-item">
              <span className="info-label">{t('photo.aperture')}:</span>
              <span className="info-value">f/{exifData.FNumber}</span>
            </div>
          )}
          
          {exifData.ExposureTime && (
            <div className="info-item">
              <span className="info-label">{t('photo.shutter')}:</span>
              <span className="info-value">
                {exifData.ExposureTime < 1 
                  ? `1/${Math.round(1/exifData.ExposureTime)}` 
                  : exifData.ExposureTime}s
              </span>
            </div>
          )}
          
          {exifData.ISO && (
            <div className="info-item">
              <span className="info-label">{t('photo.iso')}:</span>
              <span className="info-value">{exifData.ISO}</span>
            </div>
          )}
          
          {exifData.DateTimeOriginal && (
            <div className="info-item">
              <span className="info-label">{t('photo.dateTaken')}:</span>
              <span className="info-value">
                {new Date(exifData.DateTimeOriginal).toLocaleDateString(i18n.language, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}
              </span>
            </div>
          )}

          {gpsCoords && (
            <div className="info-item">
              <span className="info-label">{t('photo.location')}:</span>
              <span className="info-value">
                {formatCoord(gpsCoords.lat, true)}, {formatCoord(gpsCoords.lon, false)}{' '}
                <a
                  className="info-map-link"
                  href={openStreetMapUrl(gpsCoords.lat, gpsCoords.lon)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('photo.viewMap')}
                </a>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default InfoPanel;
