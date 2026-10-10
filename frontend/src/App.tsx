/**
 * Main application component for the photography website.
 * This component handles the routing and layout of the entire application.
 */

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "./contexts/AuthContext";
import i18n from "./i18n/config";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useParams,
  useLocation,
  useNavigate,
  Link,
} from "react-router-dom";
import "./App.css";
import ContentGrid from "./components/ContentGrid";
import Header, { ExternalLink } from "./components/Header";
import Footer from "./components/Footer";
import ScrollToTop from "./components/Misc/ScrollToTop";
import { SEO } from "./components/Misc/SEO";
import { StructuredData } from "./components/Misc/StructuredData";
import { API_URL, SITE_URL } from "./config";
import { trackPageView, trackError } from "./utils/analytics";
import { fetchWithRateLimitCheck } from "./utils/fetchWrapper";
import { error, debug, verbose } from "./utils/logger";
import { SSEToasterProvider } from "./contexts/SSEToasterContext";
import { AuthProvider } from "./contexts/AuthContext";
import SSEToaster from "./components/SSEToaster";
import { filterAlbums, filterFolders } from "./utils/albumFilters";
import { useServiceWorkerNavigationReload } from "./utils/navigationInterceptor";

// Lazy load components that aren't needed on initial page load
const AdminPortal = lazy(() => import("./components/AdminPortal"));
const License = lazy(() => import("./components/Misc/License"));
const AuthError = lazy(() => import("./components/Misc/AuthError"));
import NotFound from "./components/Misc/NotFound";
const SharedAlbum = lazy(() => import("./components/SharedAlbum"));
const SetupWizard = lazy(() => import("./components/SetupWizard"));
const InviteSignup = lazy(() => import("./components/Misc/InviteSignup"));
const PasswordResetRequest = lazy(
  () => import("./components/Misc/PasswordResetRequest")
);
const PasswordResetComplete = lazy(
  () => import("./components/Misc/PasswordResetComplete")
);
const LogViewer = lazy(() => import("./components/LogViewer/LogViewer"));
const VideoPage = lazy(() => import("./components/VideoPage"));

interface AlbumBootstrapData {
  albums?: Array<{
    name: string;
    published: boolean | number;
    folder_id?: number | null;
  }>;
  folders?: Array<{
    id: number;
    name: string;
    published: boolean | number;
  }>;
}

type AlbumsBootstrapData =
  | AlbumBootstrapData
  | Array<string | { name: string; published: boolean }>;

interface ExternalLinksBootstrapData {
  externalLinks: ExternalLink[];
}

interface BrandingBootstrapData {
  siteName?: string;
  avatarPath?: string;
  primaryColor?: string;
  secondaryColor?: string;
  language?: string;
  headerTheme?: "light" | "dark" | "custom";
  headerBackgroundColor?: string;
  headerTextColor?: string;
  headerOpacity?: number;
  headerBlur?: number;
  headerBorderColor?: string;
  headerBorderOpacity?: number;
  headerDropdownTheme?: "light" | "dark";
  photoGridTheme?: "light" | "dark";
}

const DEFAULT_BRANDING: BrandingBootstrapData = {
  siteName: "Galleria",
  avatarPath: "/photos/avatar.png",
  primaryColor: "#4ade80",
  secondaryColor: "#3b82f6",
  language: "en",
  headerTheme: "light",
  headerBackgroundColor: "#e7e7e7",
  headerTextColor: "#1e1e1e",
  headerOpacity: 1,
  headerBlur: 0,
  headerBorderColor: "#1e1e1e",
  headerBorderOpacity: 0.2,
  headerDropdownTheme: "light",
  photoGridTheme: "dark",
};

async function fetchBootstrapEndpoint<T>(
  endpoint: string,
  label: string,
  fallback: T
): Promise<T> {
  try {
    const response = await fetchWithRateLimitCheck(`${API_URL}${endpoint}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${label}`);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.message === "Rate limited") {
      throw err;
    }

    const errorMessage =
      err instanceof Error ? err.message : `Failed to fetch ${label}`;
    error(errorMessage, err);
    trackError(errorMessage, "app_initialization");
    return fallback;
  }
}

// LicenseWrapper component to show footer when license page loads
function LicenseWrapper({
  setShowFooter,
  siteName,
}: {
  setShowFooter: (show: boolean) => void;
  siteName: string;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    setShowFooter(true);
  }, [setShowFooter]);

  return (
    <>
      <SEO
        title={t("seo.licenseTitle", { siteName })}
        description={t("seo.licenseDescription", { siteName })}
        url={`${SITE_URL}/license`}
      />
      <License />
    </>
  );
}

// AlbumRoute component handles the routing for individual album pages
function AlbumRoute({
  onAlbumNotFound,
  onLoadComplete,
  siteName,
}: {
  onAlbumNotFound: () => void;
  onLoadComplete: () => void;
  siteName: string;
}) {
  const { t } = useTranslation();
  const { album } = useParams();
  const [urlPath, setUrlPath] = useState(window.location.pathname);
  
  // Watch for URL changes and force re-render
  // This handles the case where React Router's state doesn't update but the URL does
  useEffect(() => {
    const checkUrl = () => {
      const currentPath = window.location.pathname;
      if (currentPath !== urlPath) {
        setUrlPath(currentPath);
      }
    };
    
    // Check immediately
    checkUrl();
    
    // Check every 100ms for URL changes
    const interval = setInterval(checkUrl, 100);
    
    // Also listen for popstate
    window.addEventListener('popstate', checkUrl);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('popstate', checkUrl);
    };
  }, [urlPath]);
  
  // Decode URI-encoded album name from params
  const decodedAlbum = album ? decodeURIComponent(album) : "";
  
  // Extract album from URL directly (handles React Router not updating)
  const urlAlbumMatch = urlPath.match(/^\/album\/(.+)$/);
  const actualAlbum = urlAlbumMatch ? decodeURIComponent(urlAlbumMatch[1].split('?')[0]) : decodedAlbum;
  
  // Use actual album from URL if it differs from params (React Router didn't update)
  const effectiveAlbum = actualAlbum || decodedAlbum;

  return (
    <>
      <SEO
        title={t("seo.albumTitle", { albumName: effectiveAlbum, siteName })}
        description={t("seo.albumDescription", {
          albumName: effectiveAlbum,
          siteName,
        })}
        url={`${SITE_URL}/album/${encodeURIComponent(effectiveAlbum)}`}
        image={`${SITE_URL}/photos/avatar.png`}
      />
      <ContentGrid
        key={`${urlPath}-${effectiveAlbum}`} // Force remount when URL path or album changes
        album={effectiveAlbum}
        onAlbumNotFound={onAlbumNotFound}
        onLoadComplete={onLoadComplete}
      />
    </>
  );
}

// PrimesRedirect component forces a full page load to the primes static page
function PrimesRedirect() {
  const { t } = useTranslation();
  useEffect(() => {
    // Force a full page reload to the primes page
    window.location.replace("/primes/");
  }, []);
  return <div className="loading">{t("common.loading")}</div>;
}

// NotFoundRedirect component updates URL to /404 for catch-all routes
function NotFoundRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Only redirect if we're not already at /404
    if (location.pathname !== "/404") {
      navigate("/404", { replace: true });
    }
  }, [navigate, location.pathname]);

  return <NotFound />;
}

// RateLimitError component for 429 error page
function RateLimitError() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Only redirect if we're not already at /429
    if (location.pathname !== "/429") {
      navigate("/429", { replace: true });
    }
  }, [navigate, location.pathname]);

  return (
    <div className="error rate-limit-error">
      <div className="rate-limit-icon">🤠</div>
      <h2>{t("app.rateLimitTitle")}</h2>
      <p>{t("app.rateLimitMessage")}</p>
      <p>{t("app.rateLimitAction")}</p>
      <div className="not-found-actions">
        <Link to="/" className="home-button">
          {t("app.headBackHome")}
        </Link>
      </div>
    </div>
  );
}

/**
 * Main App component that:
 * - Manages application state
 * - Handles data fetching
 * - Sets up routing
 * - Renders the main layout
 */
function App() {
  const { t } = useTranslation();

  // Read initial data from SSR (server-rendered) for instant load - no waiting for fetchData
  const initialData = (window as any).__INITIAL_DATA__;
  const runtimeBranding = (window as any).__RUNTIME_BRANDING__;

  // Parse initial albums data synchronously for instant render
  const getInitialAlbums = () => {
    if (!initialData?.albums) return [];
    const albumsData = initialData.albums;
    if (albumsData && typeof albumsData === "object" && "albums" in albumsData) {
      // New format - filter to published only (assume not authenticated on initial load)
      return (albumsData.albums || [])
        .filter((a: { name: string; published?: boolean }) =>
          a.name !== "homepage" && a.published !== false
        );
    }
    // Old format
    return Array.isArray(albumsData)
      ? albumsData.filter((a: string | { name: string }) =>
          typeof a === "string" ? a !== "homepage" : a.name !== "homepage"
        )
      : [];
  };

  const getInitialFolders = () => {
    if (!initialData?.albums) return [];
    const albumsData = initialData.albums;
    if (albumsData && typeof albumsData === "object" && "folders" in albumsData) {
      return (albumsData.folders || [])
        .filter((f: { published?: boolean | number }) => f.published)
        .map((f: { id: number; name: string; published: boolean | number }) =>
          ({ ...f, published: !!f.published })
        );
    }
    return [];
  };

  const getInitialExternalLinks = () => {
    return initialData?.externalLinks?.externalLinks || [];
  };

  // Application state - initialize from SSR data for instant render
  const [albums, setAlbums] = useState<
    string[] | Array<{ name: string; folder_id?: number | null }>
  >(getInitialAlbums);
  const [folders, setFolders] = useState<
    Array<{ id: number; name: string; published: boolean }>
  >(getInitialFolders);
  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>(getInitialExternalLinks);

  // Read branding from injected runtime config (server-rendered) for instant load
  const [siteName, setSiteName] = useState(runtimeBranding?.siteName || "Galleria");
  const [avatarPath, setAvatarPath] = useState(runtimeBranding?.avatarPath || "/photos/avatar.png");
  const [headerAvatarPath] = useState(runtimeBranding?.headerAvatarPath || "/photos/avatar-header.webp");
  const [headerAvatarBase64] = useState<string | null>(runtimeBranding?.headerAvatarBase64 || null);
  const [avatarCacheBust, setAvatarCacheBust] = useState(runtimeBranding?.avatarCacheBust || 0);
  const [primaryColor, setPrimaryColor] = useState(runtimeBranding?.primaryColor || "#4ade80");
  const [secondaryColor, setSecondaryColor] = useState(runtimeBranding?.secondaryColor || "#3b82f6");
  const [headerTheme, setHeaderTheme] = useState<'light' | 'dark' | 'custom'>(runtimeBranding?.headerTheme || "light");
  const [headerBackgroundColor, setHeaderBackgroundColor] = useState(runtimeBranding?.headerBackgroundColor || "#e7e7e7");
  const [headerTextColor, setHeaderTextColor] = useState(runtimeBranding?.headerTextColor || "#1e1e1e");
  const [headerOpacity, setHeaderOpacity] = useState<number>(runtimeBranding?.headerOpacity ?? 1);
  const [headerBlur, setHeaderBlur] = useState<number>(runtimeBranding?.headerBlur ?? 0);
  const [headerBorderColor, setHeaderBorderColor] = useState(runtimeBranding?.headerBorderColor || "#1e1e1e");
  const [headerBorderOpacity, setHeaderBorderOpacity] = useState<number>(runtimeBranding?.headerBorderOpacity ?? 0.2);
  const [headerDropdownTheme, setHeaderDropdownTheme] = useState<'light' | 'dark'>(runtimeBranding?.headerDropdownTheme || "light");
  const [photoGridTheme, setPhotoGridTheme] = useState<'light' | 'dark'>(runtimeBranding?.photoGridTheme || "dark");
  const [errorState, setErrorState] = useState<string | null>(null);

  // Set language immediately if provided in runtime branding
  useEffect(() => {
    if (runtimeBranding?.language && i18n.language !== runtimeBranding.language) {
      i18n.changeLanguage(runtimeBranding.language);
    }
  }, [runtimeBranding]);
  const [currentAlbum, setCurrentAlbum] = useState<string | undefined>(
    undefined
  );
  const [showFooter, setShowFooter] = useState(true);  // Start visible, hide on navigation if needed
  const [hideAlbumTitle, setHideAlbumTitle] = useState(false);
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  
  // Intercept navigation to reload when service worker update is pending
  useServiceWorkerNavigationReload();

  // Check if initial setup is complete
  useEffect(() => {
    const checkSetup = async () => {
      try {
        const response = await fetch(`${API_URL}/api/setup/status`);
        const data = await response.json();
        setSetupComplete(data.setupComplete);

        // Setup status checked
      } catch (err) {
        error("Setup check failed:", err);
        // Assume setup is complete if check fails (backward compatibility)
        setSetupComplete(true);
      }
    };

    checkSetup();
  }, []);

  // Global rate limit handler - any component can trigger this
  useEffect(() => {
    (window as any).handleRateLimit = () => {
      setErrorState("RATE_LIMIT");
    };

    return () => {
      delete (window as any).handleRateLimit;
    };
  }, []);

  // Apply theme colors to CSS custom properties
  useEffect(() => {
    document.documentElement.style.setProperty("--primary-color", primaryColor);
    document.documentElement.style.setProperty(
      "--secondary-color",
      secondaryColor
    );
  }, [primaryColor, secondaryColor]);

  // Apply header theme to document for CSS styling
  useEffect(() => {
    document.documentElement.setAttribute("data-header-theme", headerTheme);
    document.documentElement.setAttribute("data-photo-grid-theme", photoGridTheme);
    document.documentElement.setAttribute("data-header-dropdown-theme", headerDropdownTheme);
    // Apply custom colors as CSS variables when custom theme is selected
    if (headerTheme === "custom") {
      document.documentElement.style.setProperty("--header-bg-color", headerBackgroundColor);
      document.documentElement.style.setProperty("--header-text-color", headerTextColor);
      document.documentElement.style.setProperty("--header-opacity", String(headerOpacity));
      document.documentElement.style.setProperty("--header-blur", String(headerBlur));
      document.documentElement.style.setProperty("--header-border-color", headerBorderColor);
      document.documentElement.style.setProperty("--header-border-opacity", String(headerBorderOpacity));
    }
  }, [headerTheme, headerBackgroundColor, headerTextColor, headerOpacity, headerBlur, headerBorderColor, headerBorderOpacity, headerDropdownTheme, photoGridTheme]);

  // Listen for live preview of header theme changes from settings
  useEffect(() => {
    const handleHeaderThemePreview = (event: CustomEvent<{
      headerTheme?: 'light' | 'dark' | 'custom';
      headerBackgroundColor?: string;
      headerTextColor?: string;
      headerOpacity?: number;
      headerBlur?: number;
      headerBorderColor?: string;
      headerBorderOpacity?: number;
      headerDropdownTheme?: 'light' | 'dark';
      photoGridTheme?: 'light' | 'dark';
    }>) => {
      const { headerTheme: newTheme, headerBackgroundColor: newBgColor, headerTextColor: newTextColor, headerOpacity: newOpacity, headerBlur: newBlur, headerBorderColor: newBorderColor, headerBorderOpacity: newBorderOpacity, headerDropdownTheme: newDropdownTheme, photoGridTheme: newPhotoGridTheme } = event.detail;
      if (newTheme !== undefined) {
        setHeaderTheme(newTheme);
      }
      if (newBgColor !== undefined) {
        setHeaderBackgroundColor(newBgColor);
      }
      if (newTextColor !== undefined) {
        setHeaderTextColor(newTextColor);
      }
      if (newOpacity !== undefined) {
        setHeaderOpacity(newOpacity);
      }
      if (newBlur !== undefined) {
        setHeaderBlur(newBlur);
      }
      if (newBorderColor !== undefined) {
        setHeaderBorderColor(newBorderColor);
      }
      if (newBorderOpacity !== undefined) {
        setHeaderBorderOpacity(newBorderOpacity);
      }
      if (newDropdownTheme !== undefined) {
        setHeaderDropdownTheme(newDropdownTheme);
      }
      if (newPhotoGridTheme !== undefined) {
        setPhotoGridTheme(newPhotoGridTheme);
      }
    };

    window.addEventListener('header-theme-preview', handleHeaderThemePreview as EventListener);
    return () => {
      window.removeEventListener('header-theme-preview', handleHeaderThemePreview as EventListener);
    };
  }, []);

  // Hide footer on navigation (except homepage)
  useEffect(() => {
    // Don't hide footer on homepage - it should show immediately via SSR
    if (location.pathname !== "/") {
      setShowFooter(false);
    }
  }, [location.pathname]);

  // Update current album based on route changes and track page views
  useEffect(() => {
    const path = location.pathname;
    // Reset hideAlbumTitle when route changes
    setHideAlbumTitle(false);

    if (path.startsWith("/album/")) {
      // Extract album name, handling trailing slashes and removing any extra path segments
      const encodedAlbum = path
        .split("/album/")[1]
        .split("/")[0]
        .split("?")[0]
        .trim();
      // Only set if album name is not empty
      if (encodedAlbum) {
        const albumName = decodeURIComponent(encodedAlbum);
        setCurrentAlbum(albumName);
        trackPageView(path, `${albumName} - Album`);
      } else {
        setCurrentAlbum(undefined);
        trackPageView(path);
      }
    } else if (path === "/") {
      setCurrentAlbum(undefined);
      trackPageView(path, "Homepage");
    } else if (path === "/license") {
      setCurrentAlbum(undefined);
      trackPageView(path, "License");
    } else {
      setCurrentAlbum(undefined);
      trackPageView(path);
    }
  }, [location]);

  // Fetch albums, external links, and branding data
  const fetchData = async () => {
    try {
      // Check if initial data was server-side rendered (SSR) into the page
      const initialData = (window as any).__INITIAL_DATA__;
      
      let albumsData: AlbumsBootstrapData;
      let externalLinksData: ExternalLinksBootstrapData;
      let brandingData: BrandingBootstrapData;
      
      if (initialData && initialData.albums && initialData.externalLinks) {
        // Use pre-injected data from SSR (no network requests!)
        debug("✓ Using server-side rendered initial data (no network requests)");
        albumsData = initialData.albums;
        externalLinksData = initialData.externalLinks;
        
        // Use already-injected branding from SSR (no network request!)
        const runtimeBranding = (window as any).__RUNTIME_BRANDING__;
        brandingData = {
          ...DEFAULT_BRANDING,
          ...runtimeBranding,
        };
        
        // Clear remaining SSR data after using it (homepage was already cleared by ContentGrid)
        delete (window as any).__INITIAL_DATA__;
      } else {
        // Fallback to API requests if SSR data not available
        debug("⚠ SSR data not available, fetching from API");
        [albumsData, externalLinksData, brandingData] = await Promise.all([
          fetchBootstrapEndpoint<AlbumsBootstrapData>(
            "/api/albums",
            "albums",
            []
          ),
          fetchBootstrapEndpoint<ExternalLinksBootstrapData>(
            "/api/external-pages",
            "external links",
            { externalLinks: [] }
          ),
          fetchBootstrapEndpoint<BrandingBootstrapData>(
            "/api/branding",
            "branding",
            DEFAULT_BRANDING
          ),
        ]);
      }

      // Handle new API format: { albums: [...], folders: [...] } or old format: [...]
      if (
        albumsData &&
        typeof albumsData === "object" &&
        "albums" in albumsData
      ) {
        // New format with folders
        const filteredAlbums = filterAlbums(
          albumsData.albums || [],
          isAuthenticated
        );
        const filteredFolders = filterFolders(
          albumsData.folders || [],
          isAuthenticated
        );

        debug("🔍 App.tsx fetchData - isAuthenticated:", isAuthenticated);
        verbose(
          "🔍 App.tsx fetchData - Raw folders from backend:",
          albumsData.folders
        );
        verbose("🔍 App.tsx fetchData - Filtered folders:", filteredFolders);
        verbose("🔍 App.tsx fetchData - Filtered albums:", filteredAlbums);

        setAlbums(filteredAlbums);
        // Normalize published field to boolean (SQLite returns 0/1)
        setFolders(
          filteredFolders.map((f) => ({ ...f, published: !!f.published }))
        );
      } else {
        // Old format (array of strings or objects)
        const albumNames = Array.isArray(albumsData)
          ? albumsData
              .filter(
                (album: string | { name: string; published: boolean }) => {
                  if (typeof album === "string") return album !== "homepage";
                  if (album.name === "homepage") return false;
                  // If it's an object, include all albums if authenticated, only published if not
                  if (isAuthenticated) return true;
                  return album.published === true;
                }
              )
              .map((album: string | { name: string; published: boolean }) =>
                typeof album === "string" ? album : album.name
              )
          : [];

        setAlbums(albumNames);
        setFolders([]);
      }
      
      setExternalLinks(externalLinksData.externalLinks || []);
      setSiteName(brandingData.siteName || "Galleria");
      
      // Only update avatar cache bust if the avatar path actually changed
      const newAvatarPath = brandingData.avatarPath || "/photos/avatar.png";
      if (newAvatarPath !== avatarPath) {
        setAvatarPath(newAvatarPath);
        setAvatarCacheBust(Date.now());
      }
      
      setPrimaryColor(brandingData.primaryColor || "#4ade80");
      setSecondaryColor(brandingData.secondaryColor || "#3b82f6");
      setHeaderTheme(brandingData.headerTheme || "light");
      setHeaderBackgroundColor(brandingData.headerBackgroundColor || "#e7e7e7");
      setHeaderTextColor(brandingData.headerTextColor || "#1e1e1e");
      setHeaderOpacity(brandingData.headerOpacity ?? 1);
      setHeaderBlur(brandingData.headerBlur ?? 0);
      setHeaderBorderColor(brandingData.headerBorderColor || "#1e1e1e");
      setHeaderBorderOpacity(brandingData.headerBorderOpacity ?? 0.2);
      setHeaderDropdownTheme(brandingData.headerDropdownTheme || "light");
      setPhotoGridTheme(brandingData.photoGridTheme || "dark");

      // Update language from branding config if available
      if (brandingData.language && i18n.language !== brandingData.language) {
        i18n.changeLanguage(brandingData.language);
      }
      
      setErrorState(null);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "An error occurred";

      // Don't set error state if it's a rate limit (already handled globally)
      if (errorMessage === "Rate limited") {
        return;
      }

      setErrorState(errorMessage);
      setAlbums([]);
      setFolders([]);
      setExternalLinks([]);
      setSiteName("Galleria");
      setAvatarPath("/photos/avatar.png");
      trackError(errorMessage, "app_initialization");
    }
  };

  useEffect(() => {
    // Only fetch data if setup is complete
    if (setupComplete === true) {
      fetchData();
    }

    // Silent update for navigation without triggering loading state
    const updateNavigationSilently = async () => {
      debug("🔄 albums-updated event received, updating navigation...");
      try {
        const albumsResponse = await fetchWithRateLimitCheck(
          `${API_URL}/api/albums`
        );
        if (albumsResponse.ok) {
          const albumsData = await albumsResponse.json();
          debug("✅ Navigation updated with folders:", albumsData.folders);

          // Handle new API format: { albums: [...], folders: [...] } or old format: [...]
          if (
            albumsData &&
            typeof albumsData === "object" &&
            "albums" in albumsData
          ) {
            // New format with folders
            const filteredAlbums = filterAlbums(
              albumsData.albums || [],
              isAuthenticated
            );
            const filteredFolders = filterFolders(
              albumsData.folders || [],
              isAuthenticated
            );

            setAlbums(filteredAlbums);
            // Normalize published field to boolean (SQLite returns 0/1)
            setFolders(
              filteredFolders.map((f) => ({ ...f, published: !!f.published }))
            );
          } else {
            // Old format (array of strings or objects)
            const albumNames = Array.isArray(albumsData)
              ? albumsData
                  .filter(
                    (album: string | { name: string; published: boolean }) => {
                      if (typeof album === "string")
                        return album !== "homepage";
                      if (album.name === "homepage") return false;
                      // Include all albums if authenticated, only published if not
                      if (isAuthenticated) return true;
                      return album.published === true;
                    }
                  )
                  .map((album: string | { name: string; published: boolean }) =>
                    typeof album === "string" ? album : album.name
                  )
              : [];

            setAlbums(albumNames);
            setFolders([]);
          }
        }
      } catch (err) {
        // Silently fail - don't disrupt user experience
        error("Failed to update navigation:", err);
      }
    };

    // Listen for admin changes to refresh navigation silently
    window.addEventListener("albums-updated", updateNavigationSilently);
    window.addEventListener("external-links-updated", fetchData);
    window.addEventListener("branding-updated", fetchData);

    return () => {
      window.removeEventListener("albums-updated", updateNavigationSilently);
      window.removeEventListener("external-links-updated", fetchData);
      window.removeEventListener("branding-updated", fetchData);
    };
  }, [isAuthenticated, setupComplete]); // Re-fetch when authentication or setup changes

  // Show setup wizard if setup is not complete
  if (setupComplete === false) {
    return (
      <Suspense
        fallback={
          <div className="photo-grid-loading">
            <div className="loading-spinner"></div>
            <p>{t("app.loadingSetup")}</p>
          </div>
        }
      >
        <SetupWizard />
      </Suspense>
    );
  }

  // Loading and error states
  // Skip loading state - let individual components (PhotoGrid, AdminPortal) handle their own loading
  // The header and footer can load asynchronously without blocking the page

  if (errorState) {
    if (errorState === "RATE_LIMIT") {
      return (
        <div className="app">
          <Header
            albums={albums}
            folders={folders}
            externalLinks={externalLinks}
            currentAlbum={undefined}
            siteName={siteName}
            headerAvatarPath={headerAvatarPath}
            headerAvatarBase64={headerAvatarBase64}
            avatarCacheBust={avatarCacheBust}
          />
          <main className="main-content">
            <RateLimitError />
          </main>
          <div className="footer-wrapper visible">
            <Footer
              albums={
                Array.isArray(albums) &&
                albums.length > 0 &&
                typeof albums[0] === "object"
                  ? albums.map((a) => (typeof a === "string" ? a : a.name))
                  : (albums as string[])
              }
              externalLinks={externalLinks}
              currentAlbum={undefined}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="error backend-error">
        <div className="error-icon-large">❌</div>
        <h2>{t("app.backendError")}</h2>
        <p className="error-description">{t("app.unableToConnect")}</p>
        <button
          onClick={() => window.location.reload()}
          className="retry-button"
        >
          {t("app.reloadPage")}
        </button>
      </div>
    );
  }

  // Check if current route is a standalone page (no main layout)
  const isStandalonePage =
    location.pathname.startsWith("/shared/") ||
    location.pathname.startsWith("/setup") ||
    location.pathname.startsWith("/logs") ||
    location.pathname.startsWith("/video/");

  // Standalone pages render without the main layout
  if (isStandalonePage) {
    return (
      <div className="app">
        <Suspense
          fallback={
            <div className="photo-grid-loading">
              <div className="loading-spinner"></div>
              <p>{t("common.loading")}</p>
            </div>
          }
        >
          <Routes>
            <Route path="/shared/:secretKey" element={<SharedAlbum />} />
            <Route path="/setup" element={<SetupWizard />} />
            <Route path="/logs" element={<LogViewer />} />
            <Route path="/video/:album/:filename" element={<VideoPage />} />
          </Routes>
        </Suspense>
      </div>
    );
  }

  // Main application layout for regular pages
  return (
    <div className="app">
      <Header
        albums={albums}
        folders={folders}
        externalLinks={externalLinks}
        currentAlbum={currentAlbum}
        siteName={siteName}
        headerAvatarPath={headerAvatarPath}
        headerAvatarBase64={headerAvatarBase64}
        avatarCacheBust={avatarCacheBust}
      />

      {/* Global SSE Toaster - appears across all pages */}
      <SSEToaster />

      <main className="main-content">
        {currentAlbum && currentAlbum.length > 0 && !hideAlbumTitle && (
          <h1 className="main-content-title">{currentAlbum}</h1>
        )}
        <StructuredData siteName={siteName} />
        <Suspense
          fallback={
            <div className="photo-grid-loading">
              <div className="loading-spinner"></div>
              <p>{t('common.loading')}</p>
            </div>
          }
        >
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <SEO
                    title={t("seo.homepageTitle", { siteName })}
                    description={t("seo.homepageDescription", { siteName })}
                  />
                  <ContentGrid
                    album="homepage"
                    onLoadComplete={() => setShowFooter(true)}
                  />
                </>
              }
            />
            <Route
              path="/album/:album"
              element={
                <AlbumRoute
                  key={location.pathname} // Force remount when pathname changes
                  onAlbumNotFound={() => setHideAlbumTitle(true)}
                  onLoadComplete={() => setShowFooter(true)}
                  siteName={siteName}
                />
              }
            />
            <Route
              path="/license"
              element={
                <LicenseWrapper
                  setShowFooter={setShowFooter}
                  siteName={siteName}
                />
              }
            />
            <Route path="/admin" element={<AdminPortal />} />
            <Route path="/admin/login" element={<AdminPortal />} />
            <Route path="/admin/login/password" element={<AdminPortal />} />
            <Route path="/admin/login/passkey" element={<AdminPortal />} />
            <Route path="/admin/albums" element={<AdminPortal />} />
            <Route path="/admin/metrics" element={<AdminPortal />} />
            <Route path="/admin/settings" element={<AdminPortal />} />
            <Route path="/admin/settings/*" element={<AdminPortal />} />
            <Route path="/admin/profile" element={<AdminPortal />} />
            <Route path="/logs" element={<LogViewer />} />
            <Route
              path="/auth/error"
              element={
                <>
                  <SEO
                    title={t("seo.authErrorTitle", { siteName })}
                    description={t("seo.authErrorDescription")}
                    url={`${SITE_URL}/auth/error`}
                  />
                  <AuthError />
                </>
              }
            />
            <Route
              path="/invite/:token"
              element={
                <>
                  <SEO
                    title={t("seo.inviteTitle", { siteName })}
                    description={t("seo.inviteDescription")}
                    url={`${SITE_URL}/invite`}
                  />
                  <InviteSignup />
                </>
              }
            />
            <Route
              path="/reset-password"
              element={
                <>
                  <SEO
                    title={t("seo.passwordResetTitle", { siteName })}
                    description={t("seo.passwordResetDescription")}
                    url={`${SITE_URL}/reset-password`}
                  />
                  <PasswordResetRequest />
                </>
              }
            />
            <Route
              path="/reset-password/:token"
              element={
                <>
                  <SEO
                    title={t("seo.passwordResetCompleteTitle", { siteName })}
                    description={t("seo.passwordResetCompleteDescription")}
                    url={`${SITE_URL}/reset-password`}
                  />
                  <PasswordResetComplete />
                </>
              }
            />
            <Route path="/primes" element={<PrimesRedirect />} />
            <Route path="/primes/*" element={<PrimesRedirect />} />
            <Route
              path="/404"
              element={
                <>
                  <SEO
                    title={t("seo.notFoundTitle", { siteName })}
                    description={t("seo.notFoundDescription")}
                    url={`${SITE_URL}/404`}
                  />
                  <NotFound />
                </>
              }
            />
            <Route
              path="/429"
              element={
                <>
                  <SEO
                    title={t("seo.rateLimitTitle", { siteName })}
                    description={t("seo.rateLimitDescription")}
                    url={`${SITE_URL}/429`}
                  />
                  <RateLimitError />
                </>
              }
            />
            <Route
              path="*"
              element={
                <>
                  <SEO
                    title={t("seo.notFoundTitle", { siteName })}
                    description={t("seo.notFoundDescription")}
                    url={`${SITE_URL}/404`}
                  />
                  <NotFoundRedirect />
                </>
              }
            />
          </Routes>
        </Suspense>
      </main>
      {!location.pathname.startsWith("/admin") && (
        <div
          className={`footer-wrapper ${
            showFooter ||
            location.pathname === "/404" ||
            location.pathname === "/429"
              ? "visible"
              : ""
          }`}
        >
          <Footer
            albums={
              Array.isArray(albums) &&
              albums.length > 0 &&
              typeof albums[0] === "object"
                ? albums.map((a) => (typeof a === "string" ? a : a.name))
                : (albums as string[])
            }
            externalLinks={externalLinks}
            currentAlbum={
              location.pathname === "/"
                ? "homepage"
                : location.pathname.startsWith("/album/")
                ? decodeURIComponent(
                    location.pathname
                      .split("/album/")[1]
                      .split("/")[0]
                      .split("?")[0]
                      .trim()
                  ) || undefined
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * AppWrapper component that:
 * - Sets up the router
 * - Includes ScrollToTop component
 * - Wraps app with SSEToasterProvider for global job state
 * - Renders the main App component
 */
function AppWrapper() {
  return (
    <Router>
      <NavigationSync />
      <AuthProvider>
        <SSEToasterProvider>
          <ScrollToTop />
          <App />
        </SSEToasterProvider>
      </AuthProvider>
    </Router>
  );
}

/**
 * NavigationSync component ensures React Router detects URL changes
 * even when navigation happens programmatically. This fixes the issue where
 * navigating from video-only album pages doesn't trigger React Router updates.
 */
function NavigationSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const lastPathnameRef = useRef(location.pathname);
  const lastSyncAttemptRef = useRef<string | null>(null);
  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    // Continuously check for URL/location mismatches
    const checkUrlSync = () => {
      const currentPath = window.location.pathname;
      const routerPath = location.pathname;
      
      // If URL changed but React Router location didn't, force sync
      if (currentPath !== routerPath) {
        // Only attempt sync if we haven't tried this path recently (prevent infinite loops)
        if (lastSyncAttemptRef.current !== currentPath) {
          lastSyncAttemptRef.current = currentPath;
          
          // Clear any pending sync
          if (syncTimeoutRef.current) {
            clearTimeout(syncTimeoutRef.current);
          }
          
          // Try to force React Router to update by using window.history directly
          // and then triggering a popstate event
          syncTimeoutRef.current = setTimeout(() => {
            // If navigate() didn't work, try forcing via history API
            if (window.location.pathname !== routerPath) {
              // Replace current history entry to match URL
              window.history.replaceState({}, '', currentPath);
              // Force React Router to update by dispatching popstate
              window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
            }
          }, 50);
        }
      } else {
        // They match - reset sync attempt tracking
        lastPathnameRef.current = routerPath;
        lastSyncAttemptRef.current = null;
      }
    };
    
    // Check immediately
    checkUrlSync();
    
    // Check every 200ms (less frequent to avoid spam)
    checkIntervalRef.current = setInterval(checkUrlSync, 200);
    
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
      }
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [location.pathname, navigate]);
  
  // Also listen for popstate events (browser back/forward)
  useEffect(() => {
    const handlePopState = () => {
      const currentPath = window.location.pathname;
      if (currentPath !== location.pathname) {
        navigate(currentPath, { replace: true });
      }
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [location.pathname, navigate]);
  
  return null;
}

export default AppWrapper;
