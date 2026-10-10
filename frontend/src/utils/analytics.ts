/**
 * Analytics tracking utility for sending events to the backend API.
 * The backend then forwards events to OpenObserve with authentication.
 * This keeps credentials secure and never exposes them in the frontend.
 * 
 * Events are validated by origin on the backend to prevent unauthorized tracking.
 */

import { API_URL } from '../config';
import { debug } from '../utils/logger';
// import { showToast } from './toast'; // Disabled - working correctly

interface AnalyticsEvent {
  event_type: string;
  timestamp: string;
  page_url: string;
  page_path: string;
  referrer: string;
  user_agent: string;
  screen_width: number;
  screen_height: number;
  viewport_width: number;
  viewport_height: number;
  [key: string]: string | number | boolean;
}

let analyticsEnabled = false;
let eventQueue: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 5000; // 5 seconds
const BATCH_SIZE = 20; // events

/**
 * Initialize analytics
 */
export function initAnalytics(enabled: boolean) {
  analyticsEnabled = enabled;

  if (enabled) {
    // Flush events when page is being unloaded
    window.addEventListener('beforeunload', () => {
      flushQueue(true);
    });

    // Flush events when page visibility changes (e.g., user switches tabs or minimizes)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushQueue(true);
      }
    });

    // Flush events on page freeze (mobile browsers)
    window.addEventListener('pagehide', () => {
      flushQueue(true);
    });
  }
}

/**
 * Get base event data that's common to all events
 */
function getBaseEventData(): Partial<AnalyticsEvent> {
  const timestamp = new Date().toISOString();
  return {
    timestamp,
    page_url: window.location.href,
    page_path: window.location.pathname,
    referrer: document.referrer || 'direct',
    user_agent: navigator.userAgent,
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
  };
}

/**
 * Flush the event queue by sending all queued events to the backend
 */
async function flushQueue(useBeacon = false): Promise<void> {
  if (eventQueue.length === 0) {
    return;
  }

  // Take all events from the queue
  const eventsToSend = [...eventQueue];
  eventQueue = [];

  // Clear the flush timer if it exists
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Use sendBeacon for page unload if available, otherwise use fetch
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(eventsToSend)], { type: 'application/json' });
      navigator.sendBeacon(`${API_URL}/api/analytics/track`, blob);
    } else {
      await fetch(`${API_URL}/api/analytics/track`, {
        method: 'POST',
        headers,
        body: JSON.stringify(eventsToSend),
        credentials: 'include', // Include cookies for session-based validation
        keepalive: useBeacon, // Keep request alive during page unload
      });
    }
  } catch (error) {
    // Silently fail - don't break the app if analytics fails
    debug('Analytics tracking failed:', error);
  }
}

/**
 * Schedule a flush of the event queue
 */
function scheduleFlush() {
  if (flushTimer) {
    return; // Timer already scheduled
  }

  flushTimer = setTimeout(() => {
    flushQueue();
  }, FLUSH_INTERVAL);
}

/**
 * Queue an event and flush if needed
 */
async function queueEvent(eventData: Partial<AnalyticsEvent>) {
  if (!analyticsEnabled) {
    return;
  }

  const event: AnalyticsEvent = {
    ...getBaseEventData(),
    ...eventData,
  } as AnalyticsEvent;

  eventQueue.push(event);

  // Flush immediately if we've reached the batch size
  if (eventQueue.length >= BATCH_SIZE) {
    await flushQueue();
  } else {
    // Schedule a flush if not already scheduled
    scheduleFlush();
  }
}

/**
 * Send an event (now queued for batching)
 * The backend validates the request origin to prevent unauthorized tracking
 */
async function sendEvent(eventData: Partial<AnalyticsEvent>) {
  return queueEvent(eventData);
}

/**
 * Track a page view
 */
export function trackPageView(pagePath: string, pageTitle?: string) {
  sendEvent({
    event_type: 'pageview',
    page_title: pageTitle || document.title,
    page_path: pagePath,
  });
}

/**
 * Track a photo click (opening modal)
 */
export function trackPhotoClick(photoId: string, album: string, photoTitle: string) {
  sendEvent({
    event_type: 'photo_click',
    photo_id: photoId,
    album: album,
    photo_title: photoTitle,
  });
}

/**
 * Track photo navigation in modal
 */
export function trackPhotoNavigation(direction: 'next' | 'previous', photoId: string, album: string, photoTitle: string, viewDuration?: number) {
  sendEvent({
    event_type: 'photo_navigation',
    direction: direction,
    photo_id: photoId,
    album: album,
    photo_title: photoTitle,
    view_duration_ms: viewDuration,
  });
}

/**
 * Track photo download
 */
export function trackPhotoDownload(photoId: string, album: string, photoTitle: string) {
  sendEvent({
    event_type: 'photo_download',
    photo_id: photoId,
    album: album,
    photo_title: photoTitle,
  });
}

/**
 * Track modal close
 */
export function trackModalClose(photoId: string, album: string, photoTitle: string, viewDuration?: number) {
  sendEvent({
    event_type: 'modal_close',
    photo_id: photoId,
    album: album,
    photo_title: photoTitle,
    view_duration_ms: viewDuration,
  });
}

/**
 * Track album navigation
 */
export function trackAlbumNavigation(albumName: string, source: 'header' | 'footer' | 'mobile_menu') {
  sendEvent({
    event_type: 'album_navigation',
    album: albumName,
    navigation_source: source,
  });
}

/**
 * Track external link click
 */
export function trackExternalLinkClick(linkTitle: string, linkUrl: string, source: 'header' | 'mobile_menu') {
  sendEvent({
    event_type: 'external_link_click',
    link_title: linkTitle,
    link_url: linkUrl,
    navigation_source: source,
  });
}

/**
 * Track dropdown interactions
 */
export function trackDropdownOpen(dropdownType: 'albums' | 'links' | 'mobile_menu') {
  sendEvent({
    event_type: 'dropdown_interaction',
    action: 'open',
    dropdown_type: dropdownType,
  });
}

/**
 * Track dropdown close
 */
export function trackDropdownClose(dropdownType: 'albums' | 'links' | 'mobile_menu', reason: 'click' | 'scroll' | 'navigation' | 'outside_click') {
  sendEvent({
    event_type: 'dropdown_interaction',
    action: 'close',
    dropdown_type: dropdownType,
    close_reason: reason,
  });
}

/**
 * Track error events
 */
export function trackError(errorMessage: string, errorContext?: string) {
  sendEvent({
    event_type: 'error',
    error_message: errorMessage,
    error_context: errorContext || 'unknown',
  });
}

/**
 * Track search or filter actions
 */
export function trackSearch(query: string, resultCount: number) {
  sendEvent({
    event_type: 'search',
    search_query: query,
    result_count: resultCount,
  });
}

/**
 * Track successful admin login/portal access
 */
export function trackLoginSucceeded(userEmail?: string, userName?: string) {
  sendEvent({
    event_type: 'login_succeeded',
    user_email: userEmail || 'unknown',
    user_name: userName,
  });
}

/**
 * Track logout
 */
export function trackLogout(userEmail?: string) {
  sendEvent({
    event_type: 'logout',
    user_email: userEmail || 'unknown',
  });
}

/**
 * Track admin tab navigation
 */
export function trackAdminTabChange(tabName: string) {
  sendEvent({
    event_type: 'admin_tab_change',
    tab_name: tabName,
  });
}

/**
 * Track album creation
 */
export function trackAlbumCreated(album: string) {
  sendEvent({
    event_type: 'album_created',
    album: album,
  });
}

/**
 * Track album deletion
 */
export function trackAlbumDeleted(album: string) {
  sendEvent({
    event_type: 'album_deleted',
    album: album,
  });
}

/**
 * Track photo upload
 */
export function trackPhotoUploaded(album: string, photoCount: number, photoTitles: string[]) {
  sendEvent({
    event_type: 'photo_uploaded',
    album: album,
    photo_count: photoCount,
    photo_titles: photoTitles.join(', '),
  });
}

/**
 * Track photo deletion
 */
export function trackPhotoDeleted(album: string, photoId: string, photoTitle: string) {
  sendEvent({
    event_type: 'photo_deleted',
    album: album,
    photo_id: photoId,
    photo_title: photoTitle,
  });
}

/**
 * Track photo/video moved to another album
 */
export function trackPhotoMoved(
  sourceAlbum: string,
  destinationAlbum: string,
  photoId: string,
  photoTitle: string
) {
  sendEvent({
    event_type: 'photo_moved',
    album: sourceAlbum,
    destination_album: destinationAlbum,
    photo_id: photoId,
    photo_title: photoTitle,
  });
}

/**
 * Track external links management
 */
export function trackExternalLinksUpdate(linkCount: number) {
  sendEvent({
    event_type: 'admin_external_links_update',
    link_count: linkCount,
  });
}

/**
 * Track branding settings updates
 */
export function trackBrandingUpdate(fields: string[]) {
  sendEvent({
    event_type: 'admin_branding_update',
    updated_fields: fields.join(','),
    field_count: fields.length,
  });
}

/**
 * Track avatar uploads
 */
export function trackAvatarUpload() {
  sendEvent({
    event_type: 'admin_avatar_upload',
  });
}

/**
 * Track album rename
 */
export function trackAlbumRenamed(oldAlbumName: string, newAlbumName: string) {
  sendEvent({
    event_type: 'album_renamed',
    old_album_name: oldAlbumName,
    new_album_name: newAlbumName,
  });
}

/**
 * Track album publish/unpublish
 */
export function trackAlbumPublishToggle(albumName: string, published: boolean) {
  sendEvent({
    event_type: 'album_publish_toggle',
    album: albumName,
    published: published,
  });
}

/**
 * Track album show on homepage toggle
 */
export function trackAlbumHomepageToggle(albumName: string, showOnHomepage: boolean) {
  sendEvent({
    event_type: 'album_homepage_toggle',
    album: albumName,
    show_on_homepage: showOnHomepage,
  });
}

/**
 * Track album moved to folder
 */
export function trackAlbumMovedToFolder(albumName: string, folderName: string | null, folderId: number | null) {
  sendEvent({
    event_type: 'album_moved_to_folder',
    album: albumName,
    folder_name: folderName || 'uncategorized',
    folder_id: folderId || 0,
  });
}

/**
 * Track share link created
 */
export function trackShareLinkCreated(albumName: string, expirationMinutes: number | null) {
  sendEvent({
    event_type: 'share_link_created',
    album: albumName,
    expiration_minutes: expirationMinutes || 0,
    expires_never: expirationMinutes === null,
  });
}

/**
 * Track share link deleted
 */
export function trackShareLinkDeleted(albumName: string, shareId: number) {
  sendEvent({
    event_type: 'share_link_deleted',
    album: albumName,
    share_id: shareId,
  });
}

/**
 * Track AI title generation started
 */
export function trackAITitleGenerationStarted(forceRegenerate: boolean) {
  sendEvent({
    event_type: 'ai_title_generation_started',
    force_regenerate: forceRegenerate,
  });
}

/**
 * Track AI title generation stopped
 */
export function trackAITitleGenerationStopped(manuallyStopped: boolean) {
  sendEvent({
    event_type: 'ai_title_generation_stopped',
    manually_stopped: manuallyStopped,
  });
}

/**
 * Track image optimization started
 */
export function trackImageOptimizationStarted(scope: 'all' | 'single', album?: string, filename?: string) {
  sendEvent({
    event_type: 'image_optimization_started',
    scope: scope,
    album: album || '',
    filename: filename || '',
  });
}

/**
 * Track image optimization stopped
 */
export function trackImageOptimizationStopped(manuallyStopped: boolean) {
  sendEvent({
    event_type: 'image_optimization_stopped',
    manually_stopped: manuallyStopped,
  });
}

/**
 * Track photo title edited
 */
export function trackPhotoTitleEdited(album: string, photoId: string, oldTitle: string, newTitle: string) {
  sendEvent({
    event_type: 'photo_title_edited',
    album: album,
    photo_id: photoId,
    old_title: oldTitle,
    new_title: newTitle,
  });
}

/**
 * Track photo order saved
 */
export function trackPhotoOrderSaved(album: string, photoCount: number) {
  sendEvent({
    event_type: 'photo_order_saved',
    album: album,
    photo_count: photoCount,
  });
}

/**
 * Track photo shuffle
 */
export function trackPhotoShuffle(album: string) {
  sendEvent({
    event_type: 'photo_shuffle',
    album: album,
  });
}

/**
 * Track photo retry optimization
 */
export function trackPhotoRetryOptimization(album: string, photoId: string) {
  sendEvent({
    event_type: 'photo_retry_optimization',
    album: album,
    photo_id: photoId,
  });
}

/**
 * Track photo retry AI title generation
 */
export function trackPhotoRetryAI(album: string, photoId: string) {
  sendEvent({
    event_type: 'photo_retry_ai',
    album: album,
    photo_id: photoId,
  });
}

/**
 * Track folder created
 */
export function trackFolderCreated(folderName: string) {
  sendEvent({
    event_type: 'folder_created',
    folder_name: folderName,
  });
}

/**
 * Track folder deleted
 */
export function trackFolderDeleted(folderName: string, deleteAlbums: boolean, albumCount: number) {
  sendEvent({
    event_type: 'folder_deleted',
    folder_name: folderName,
    delete_albums: deleteAlbums,
    album_count: albumCount,
  });
}

/**
 * Track folder renamed
 */
export function trackFolderRenamed(oldFolderName: string, newFolderName: string) {
  sendEvent({
    event_type: 'folder_renamed',
    old_folder_name: oldFolderName,
    new_folder_name: newFolderName,
  });
}

/**
 * Track folder publish/unpublish toggle
 */
export function trackFolderPublishToggle(folderName: string, published: boolean, albumsUpdated: number) {
  sendEvent({
    event_type: 'folder_publish_toggle',
    folder_name: folderName,
    published: published,
    albums_updated: albumsUpdated,
  });
}

/**
 * Track config settings saved
 */
export function trackConfigSettingsSaved(section: string) {
  sendEvent({
    event_type: 'admin_config_settings_saved',
    section: section,
  });
}

/**
 * Track user invited
 */
export function trackUserInvited(userEmail: string, role: string) {
  sendEvent({
    event_type: 'admin_user_invited',
    user_email: userEmail,
    role: role,
  });
}

/**
 * Track user deleted
 */
export function trackUserDeleted(userEmail: string, userId: number) {
  sendEvent({
    event_type: 'admin_user_deleted',
    user_email: userEmail,
    user_id: userId,
  });
}

/**
 * Track user role changed
 */
export function trackUserRoleChanged(userEmail: string, userId: number, oldRole: string, newRole: string) {
  sendEvent({
    event_type: 'admin_user_role_changed',
    user_email: userEmail,
    user_id: userId,
    old_role: oldRole,
    new_role: newRole,
  });
}

/**
 * Track MFA reset
 */
export function trackMFAReset(userEmail: string, userId: number) {
  sendEvent({
    event_type: 'admin_mfa_reset',
    user_email: userEmail,
    user_id: userId,
  });
}

/**
 * Track password reset sent
 */
export function trackPasswordResetSent(userEmail: string, userId: number) {
  sendEvent({
    event_type: 'admin_password_reset_sent',
    user_email: userEmail,
    user_id: userId,
  });
}

/**
 * Track shared album view
 */
export function trackSharedAlbumView(albumName: string, secretKeyHash: string) {
  sendEvent({
    event_type: 'shared_album_view',
    album: albumName,
    secret_key_hash: secretKeyHash, // Hashed for privacy
  });
}

/**
 * Track video play (when play starts)
 */
export function trackVideoPlay(videoId: string, album: string, videoTitle: string, currentTime: number, duration: number) {
  sendEvent({
    event_type: 'video_play',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    current_time_seconds: Math.round(currentTime),
    duration_seconds: Math.round(duration),
    watch_percentage: Math.round((currentTime / duration) * 100),
  });
}

/**
 * Track video pause
 */
export function trackVideoPause(videoId: string, album: string, videoTitle: string, currentTime: number, duration: number) {
  sendEvent({
    event_type: 'video_pause',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    current_time_seconds: Math.round(currentTime),
    duration_seconds: Math.round(duration),
    watch_percentage: Math.round((currentTime / duration) * 100),
  });
}

/**
 * Track video ended (completed watching)
 */
export function trackVideoEnd(videoId: string, album: string, videoTitle: string, duration: number, totalWatchTime: number) {
  sendEvent({
    event_type: 'video_ended',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    duration_seconds: Math.round(duration),
    total_watch_time_seconds: Math.round(totalWatchTime),
    completion_percentage: 100,
  });
}

/**
 * Track video progress milestones (25%, 50%, 75%, 100%)
 */
export function trackVideoProgress(videoId: string, album: string, videoTitle: string, currentTime: number, duration: number, milestone: number) {
  sendEvent({
    event_type: 'video_progress',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    current_time_seconds: Math.round(currentTime),
    duration_seconds: Math.round(duration),
    milestone_percentage: milestone,
  });
}

/**
 * Track video seek (user jumps to different time)
 */
export function trackVideoSeek(videoId: string, album: string, videoTitle: string, fromTime: number, toTime: number, duration: number) {
  sendEvent({
    event_type: 'video_seek',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    from_time_seconds: Math.round(fromTime),
    to_time_seconds: Math.round(toTime),
    duration_seconds: Math.round(duration),
    seek_distance_seconds: Math.round(Math.abs(toTime - fromTime)),
  });
}

/**
 * Track video quality change
 */
export function trackVideoQualityChange(videoId: string, album: string, videoTitle: string, quality: string, isAutomatic: boolean) {
  sendEvent({
    event_type: 'video_quality_change',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    quality: quality,
    automatic: isAutomatic,
  });
}

/**
 * Track video session summary (when modal closes or video changes)
 */
export function trackVideoSession(videoId: string, album: string, videoTitle: string, duration: number, totalWatchTime: number, maxPercentageReached: number, playCount: number, pauseCount: number, seekCount: number) {
  sendEvent({
    event_type: 'video_session_summary',
    video_id: videoId,
    album: album,
    video_title: videoTitle,
    duration_seconds: Math.round(duration),
    total_watch_time_seconds: Math.round(totalWatchTime),
    max_percentage_reached: maxPercentageReached,
    play_count: playCount,
    pause_count: pauseCount,
    seek_count: seekCount,
    engagement_rate: totalWatchTime > 0 ? Math.round((totalWatchTime / duration) * 100) : 0,
  });
}
