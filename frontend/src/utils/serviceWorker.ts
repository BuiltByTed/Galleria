/**
 * Service Worker registration utility
 * Registers and manages the service worker for caching
 */

import { info, error as logError } from '../utils/logger';

export function registerServiceWorker() {
  // Disable service worker on localhost (development)
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    info('[SW] Service worker disabled on localhost - unregistering existing worker');
    
    // Actively unregister any existing service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          registration.unregister();
          info('[SW] Unregistered service worker:', registration.scope);
        }
      });
      
      // Clear all caches
      if ('caches' in window) {
        caches.keys().then((cacheNames) => {
          cacheNames.forEach((cacheName) => {
            caches.delete(cacheName);
            info('[SW] Deleted cache:', cacheName);
          });
        });
      }
    }
    
    return;
  }
  
  // Only register in production (when served over HTTPS)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      const swUrl = "/sw.js";

      navigator.serviceWorker
        .register(swUrl)
        .then((registration) => {
          info("✓ Service Worker registered:", registration.scope);

          // Force an immediate update check
          registration.update();

          // Check for updates periodically
          setInterval(() => {
            registration.update();
          }, 60 * 60 * 1000); // Check every hour

          // Listen for updates
          registration.addEventListener("updatefound", () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener("statechange", () => {
                if (
                  newWorker.state === "installed" &&
                  navigator.serviceWorker.controller
                ) {
                  // New service worker available
                  info("📦 New version available! Will reload on next navigation.");

                  // Set global flag to trigger reload on next navigation
                  window.__pendingServiceWorkerUpdate = true;
                  
                  // Store in sessionStorage as backup (survives if window object is cleared)
                  sessionStorage.setItem('pendingServiceWorkerUpdate', 'true');
                }
              });
            }
          });
        })
        .catch((error) => {
          logError("Service Worker registration failed:", error);
        });

      // Listen for messages from the service worker
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "CACHE_CLEARED") {
          info("✓ Cache cleared by service worker");
        }
      });
    });
  }
}

export function unregisterServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.unregister();
      })
      .catch((error) => {
        logError("Service Worker unregistration failed:", error);
      });
  }
}

export function clearServiceWorkerCache() {
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "CLEAR_CACHE" });
  }
}
