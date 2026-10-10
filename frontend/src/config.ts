/**
 * Frontend config - ALL values are injected from config.json via build process
 * NO hardcoded values - everything comes from config/config.json
 * 
 * During OOBE, runtime API URL may be injected by the server to override build-time value
 */

import { getApiUrl } from './utils/apiUrl';

// API URL prefers runtime injection (for OOBE) over build-time value
export const API_URL = getApiUrl();

// Other config values from build process
export const SITE_URL = typeof window !== 'undefined' ? window.location.origin : import.meta.env.VITE_SITE_URL;
export const SITE_NAME = import.meta.env.VITE_SITE_NAME;
export const ANALYTICS_ENABLED = import.meta.env.VITE_ANALYTICS_ENABLED === 'true';
export const cacheBustValue = 0;

// Additional values for HTML meta tags
export const SITE_URL_FULL = SITE_URL;
export const API_URL_FULL = getApiUrl();
export const AVATAR_PATH = import.meta.env.VITE_AVATAR_PATH;

// Validate that required config is present (allow missing config during OOBE)
const isOOBE = typeof window !== 'undefined' && window.location.pathname === '/setup';
if (!isOOBE && (!API_URL || !SITE_URL || !SITE_NAME)) {
  throw new Error('Missing required configuration. Run: npm run build');
} 
