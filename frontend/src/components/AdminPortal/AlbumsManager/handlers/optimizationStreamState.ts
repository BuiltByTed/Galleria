import type { Photo, UploadingImage } from '../types';

export interface CompleteOptimizationUpdate {
  state: 'complete';
  album: string;
  filename: string;
  title?: string;
  error?: string;
}

export const applyCompleteOptimizationUpdate = (
  image: UploadingImage,
  update: CompleteOptimizationUpdate
): UploadingImage => {
  const { album, filename, title, error } = update;
  const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(filename);
  const mediaType = isVideo ? 'video' : 'photo';
  const thumbnailFilename = isVideo ? filename.replace(/\.[^.]+$/, '.jpg') : filename;

  const completedPhoto: Photo = {
    id: `${album}/${filename}`,
    thumbnail: `/optimized/thumbnail/${encodeURIComponent(album)}/${encodeURIComponent(thumbnailFilename)}`,
    modal: `/optimized/modal/${encodeURIComponent(album)}/${encodeURIComponent(thumbnailFilename)}`,
    download: isVideo ? '' : `/optimized/download/${encodeURIComponent(album)}/${encodeURIComponent(filename)}`,
    title: title || '',
    album,
    media_type: mediaType,
    ...(error ? { aiError: error } : {})
  };

  return {
    ...image,
    state: 'complete',
    photo: completedPhoto
  };
};
