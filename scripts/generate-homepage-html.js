#!/usr/bin/env node

/**
 * Generate pre-rendered homepage HTML with all initial data baked in
 * This eliminates network requests and dramatically improves initial page load time
 * 
 * Usage: node scripts/generate-homepage-html.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
const frontendDistDir = path.join(projectRoot, 'frontend', 'dist');
const configPath = path.join(dataDir, 'config.json');
const dbPath = path.join(dataDir, 'gallery.db');
const photosDir = path.join(dataDir, 'photos');
const homepageJsonPath = path.join(frontendDistDir, 'albums-data', 'homepage.json');
const indexHtmlPath = path.join(frontendDistDir, 'index.html');
const outputPath = path.join(frontendDistDir, 'homepage-prerendered.html');

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function log(message) {
  console.log(`${colors.blue}[Homepage SSR]${colors.reset} ${message}`);
}

function success(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function warn(message) {
  console.warn(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function error(message) {
  console.error(`${colors.red}✗${colors.reset} ${message}`);
}

/**
 * Escape HTML special characters for safe insertion
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Fetch albums data from database
 * For static homepage (non-authenticated), only return published albums and folders
 */
function getAlbumsData() {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    // Check if folder_id column exists in albums table
    const columns = db.prepare(`PRAGMA table_info(albums)`).all();
    const hasFolderId = columns.some(col => col.name === 'folder_id');
    
    // Get ONLY published albums (static HTML is for non-authenticated users)
    const albumsQuery = hasFolderId
      ? `SELECT name, published, folder_id FROM albums WHERE name != 'homepage' AND published = 1 ORDER BY name`
      : `SELECT name, published FROM albums WHERE name != 'homepage' AND published = 1 ORDER BY name`;
    
    const albums = db.prepare(albumsQuery).all();

    // Get ONLY published folders (if table exists)
    let folders = [];
    try {
      const foldersTableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='folders'
      `).get();
      
      if (foldersTableExists) {
        folders = db.prepare(`
          SELECT id, name, published
          FROM folders
          WHERE published = 1
          ORDER BY name
        `).all();
      }
    } catch (err) {
      // Folders table doesn't exist, use empty array
      warn('Folders table not found, skipping folder data');
    }

    // Normalize published field from SQLite 1/0 to true/false
    const normalizedAlbums = albums.map(album => ({
      ...album,
      published: true, // Already filtered to published albums
      folder_id: album.folder_id ?? null
    }));
    const normalizedFolders = folders.map(folder => ({
      ...folder,
      published: true // Already filtered to published folders
    }));

    return { albums: normalizedAlbums, folders: normalizedFolders };
  } finally {
    db.close();
  }
}

/**
 * Fetch external links from config.json
 */
function getExternalLinks(config) {
  // External links are stored in config.json, not in database
  const externalLinks = config.externalLinks || [];
  
  if (externalLinks.length > 0) {
    success(`Loaded ${externalLinks.length} external links from config.json`);
  } else {
    log('No external links found in config.json');
  }
  
  return { externalLinks };
}

/**
 * Replace runtime placeholders with current config values
 */
function replaceRuntimePlaceholders(html, config, apiUrl, siteUrl) {
  const siteName = config.branding?.siteName || "Galleria";
  const avatarPath = config.branding?.avatarPath || "/photos/avatar.png";

  return html
    .replace(/__RUNTIME_SITE_NAME__/g, escapeHtml(siteName))
    .replace(/__RUNTIME_AVATAR_PATH__/g, escapeHtml(avatarPath))
    .replace(/__RUNTIME_SITE_URL__/g, escapeHtml(siteUrl));
}

/**
 * Main function to generate pre-rendered homepage HTML
 */
async function generateHomepageHtml() {
  try {
    log('Starting homepage HTML generation...');

    // Check if required files exist
    if (!fs.existsSync(configPath)) {
      error(`Config file not found: ${configPath}`);
      process.exit(1);
    }

    if (!fs.existsSync(dbPath)) {
      error(`Database not found: ${dbPath}`);
      process.exit(1);
    }

    if (!fs.existsSync(indexHtmlPath)) {
      error(`Index HTML template not found: ${indexHtmlPath}`);
      process.exit(1);
    }

    // Read config
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Determine API URL from environment or config
    // Priority: environment variable > config file > default
    const apiUrl = '__GALLERIA_API_ORIGIN__';
    const siteUrl = '__GALLERIA_SITE_ORIGIN__';

    // Read homepage.json if it exists
    let homepageData = null;
    if (fs.existsSync(homepageJsonPath)) {
      homepageData = JSON.parse(fs.readFileSync(homepageJsonPath, 'utf8'));
      success(`Loaded homepage.json (${JSON.stringify(homepageData).length} bytes)`);
    } else {
      warn('homepage.json not found, skipping photo data injection');
    }

    // Get albums from database and external links from config
    const albumsData = getAlbumsData();
    const externalLinksData = getExternalLinks(config);
    success(`Loaded ${albumsData.albums.length} albums, ${albumsData.folders.length} folders`);
    success(`Loaded ${externalLinksData.externalLinks.length} external links`);

    // Read index.html template
    let html = fs.readFileSync(indexHtmlPath, 'utf8');

    // Get branding data
    const siteName = config.branding?.siteName || "Galleria";
    const safeSiteName = escapeHtml(siteName);

    // Update meta tags for homepage
    const gridUrl = `${apiUrl}/api/preview-grid/homepage`;
    html = html
      .replace(/<title>.*?<\/title>/, `<title>${safeSiteName}</title>`)
      .replace(
        /<meta property="og:image" content=".*?" \/>/,
        `<meta property="og:image" content="${gridUrl}" />\n    <meta property="og:image:secure_url" content="${gridUrl.replace(
          "http://",
          "https://"
        )}" />\n    <meta property="og:image:alt" content="Photography by ${safeSiteName}" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />`
      )
      .replace(
        /<meta property="twitter:image" content=".*?" \/>/,
        `<meta property="twitter:image" content="${gridUrl}" />`
      );

    // Replace runtime placeholders
    html = replaceRuntimePlaceholders(html, config, apiUrl, siteUrl);

    // Add cache busting to favicon and icon links
    // This ensures browsers fetch updated icons when avatar changes
    const cacheBuster = Date.now();
    html = html
      .replace(/href="\/favicon\.ico"/g, `href="/favicon.ico?v=${cacheBuster}"`)
      .replace(/href="\/icon-192\.png"/g, `href="/icon-192.png?v=${cacheBuster}"`)
      .replace(/href="\/icon-512\.png"/g, `href="/icon-512.png?v=${cacheBuster}"`)
      .replace(/href="\/apple-touch-icon\.png"/g, `href="/apple-touch-icon.png?v=${cacheBuster}"`);
    
    success(`Added cache buster to favicon/icon links: v=${cacheBuster}`);

    // Load header avatar as base64 for instant display
    let headerAvatarBase64 = null;
    const headerAvatarFilePath = path.join(photosDir, 'avatar-header.webp');
    if (fs.existsSync(headerAvatarFilePath)) {
      try {
        const avatarBuffer = fs.readFileSync(headerAvatarFilePath);
        headerAvatarBase64 = `data:image/webp;base64,${avatarBuffer.toString('base64')}`;
        success(`Loaded header avatar as base64 (${Math.round(headerAvatarBase64.length / 1024)}KB)`);
      } catch (err) {
        warn(`Failed to load header avatar: ${err.message}`);
      }
    }

    // Build branding data
    const brandingData = {
      siteName: config.branding?.siteName || "Galleria",
      avatarPath: config.branding?.avatarPath || "/photos/avatar.png",
      headerAvatarPath: config.branding?.headerAvatarPath || "/photos/avatar-header.webp",
      headerAvatarBase64: headerAvatarBase64,
      avatarCacheBust: config.branding?.avatarCacheBust || 0,
      primaryColor: config.branding?.primaryColor || "#4ade80",
      secondaryColor: config.branding?.secondaryColor || "#3b82f6",
      language: config.branding?.language || "en",
      headerTheme: config.branding?.headerTheme || "light",
      headerBackgroundColor: config.branding?.headerBackgroundColor || "#e7e7e7",
      headerTextColor: config.branding?.headerTextColor || "#1e1e1e",
      headerOpacity: config.branding?.headerOpacity ?? 1,
      headerBlur: config.branding?.headerBlur ?? 0,
      headerBorderColor: config.branding?.headerBorderColor || "#1e1e1e",
      headerBorderOpacity: config.branding?.headerBorderOpacity ?? 0.2,
      headerDropdownTheme: config.branding?.headerDropdownTheme || "light",
      photoGridTheme: config.branding?.photoGridTheme || "dark",
      gridColumns0: config.branding?.gridColumns0,
      gridColumns600: config.branding?.gridColumns600,
      gridColumns900: config.branding?.gridColumns900,
      gridColumns1200: config.branding?.gridColumns1200,
      gridColumns1600: config.branding?.gridColumns1600
    };

    // Inject custom CSS if present
    const customCSS = config.branding?.customCSS || "";
    if (customCSS) {
      html = html.replace(
        '</head>',
        `<style id="custom-css">${customCSS}</style>\n  </head>`
      );
    }

    // Build initial data object
    const initialData = {
      homepage: homepageData,
      albums: albumsData,
      externalLinks: externalLinksData,
    };

    // Build inline script that applies theme immediately (before React hydrates)
    const themeScript = `window.__RUNTIME_API_URL__ = "${apiUrl}"; window.__RUNTIME_BRANDING__ = ${JSON.stringify(brandingData)}; window.__INITIAL_DATA__ = ${JSON.stringify(initialData)}; (function(){var b=window.__RUNTIME_BRANDING__;if(b){document.documentElement.setAttribute("data-header-theme",b.headerTheme||"light");document.documentElement.setAttribute("data-header-dropdown-theme",b.headerDropdownTheme||"light");document.documentElement.setAttribute("data-photo-grid-theme",b.photoGridTheme||"dark");if(b.headerTheme==="custom"){var s=document.documentElement.style;s.setProperty("--header-bg-color",b.headerBackgroundColor||"#e7e7e7");s.setProperty("--header-text-color",b.headerTextColor||"#1e1e1e");s.setProperty("--header-opacity",b.headerOpacity??1);s.setProperty("--header-blur",b.headerBlur??0);s.setProperty("--header-border-color",b.headerBorderColor||"#1e1e1e");s.setProperty("--header-border-opacity",b.headerBorderOpacity??0.2)}}})();`;

    // Inject runtime config, branding, and initial data
    html = html.replace(
      '<script type="module"',
      `<script>${themeScript}</script>\n    <script type="module"`
    );

    // Add marker comment to identify pre-rendered HTML
    const timestamp = new Date().toISOString();
    html = html.replace(
      '</head>',
      `  <!-- Pre-rendered at ${timestamp} -->\n  </head>`
    );

    // Write pre-rendered HTML to disk
    fs.writeFileSync(outputPath, html, 'utf8');
    
    const htmlSize = (html.length / 1024).toFixed(2);
    const dataSize = (JSON.stringify(initialData).length / 1024).toFixed(2);
    success(`Generated homepage HTML: ${htmlSize} KB (including ${dataSize} KB of data)`);
    success(`Saved to: ${path.relative(projectRoot, outputPath)}`);

    return true;
  } catch (err) {
    error(`Failed to generate homepage HTML: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run the script
generateHomepageHtml()
  .then(() => {
    console.log(`\n${colors.green}${colors.bright}Homepage HTML generation complete!${colors.reset}\n`);
    process.exit(0);
  })
  .catch((err) => {
    error(`Unexpected error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });

