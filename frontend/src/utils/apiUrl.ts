/**
 * Get the API URL, preferring runtime injection over build-time value
 * This allows OOBE to work without rebuilding the frontend
 */

declare global {
  interface Window {
    __RUNTIME_API_URL__?: string;
  }
}

export function getApiUrl(): string {
  // Prefer runtime API URL (injected by server during OOBE)
  if (typeof window !== 'undefined' && typeof window.__RUNTIME_API_URL__ === 'string') {
    return window.__RUNTIME_API_URL__;
  }
  
  // Fall back to build-time API URL
  return import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '');
}

