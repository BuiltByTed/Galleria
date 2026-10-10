/**
 * Shared types for PhotoModal components
 */

// Photo interface moved to canonical location: types/photo.ts
export type { Photo } from '../../types/photo';

export interface ExifData {
  Make?: string;
  Model?: string;
  LensModel?: string;
  FocalLength?: number;
  FNumber?: number;
  ExposureTime?: number;
  ISO?: number;
  DateTimeOriginal?: string;
  /** Decimal degrees from exifr GPS merge (preferred). */
  latitude?: number;
  longitude?: number;
  /** Raw EXIF GPS tags when present (number or DMS array). */
  GPSLatitude?: number | number[];
  GPSLongitude?: number | number[];
  GPSLatitudeRef?: string;
  GPSLongitudeRef?: string;
  error?: string;
}

