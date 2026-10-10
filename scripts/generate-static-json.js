#!/usr/bin/env node

/**
 * Generate static JSON files for all albums
 * Standalone script that reads directly from SQLite database
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH = path.join(dataDir, 'gallery.db');
const CONFIG_PATH = path.join(dataDir, 'config.json');
const OUTPUT_DIR = path.join(__dirname, '../frontend/dist/albums-data');

console.log('🚀 Starting static JSON generation...');
console.log(`   Database: ${DB_PATH}`);
console.log(`   Output directory: ${OUTPUT_DIR}`);

try {
  // Open database
  const db = new Database(DB_PATH, { readonly: true });
  
  // Load config for branding settings
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const shuffleHomepage = config.branding?.shuffleHomepage ?? true;

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`   Created output directory`);
  }

  function writeJSON(filename, data) {
    const filepath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(data));
    const size = (fs.statSync(filepath).size / 1024).toFixed(1);
    console.log(`   ✅ Generated: ${filename} (${Array.isArray(data) ? data.length : 'N/A'} items, ${size} KB)`);
  }

  const albumColumns = db.pragma('table_info(albums)');
  const hasDownloadsEnabled = albumColumns.some(col => col.name === 'downloads_enabled');
  const downloadsEnabledSelect = hasDownloadsEnabled ? 'downloads_enabled' : '1 AS downloads_enabled';
  const homepageDownloadsEnabledSelect = hasDownloadsEnabled ? 'a.downloads_enabled' : '1 AS downloads_enabled';

  // Optimized format: [filename, title, media_type] arrays
  // Frontend will reconstruct full photo objects
  // media_type: 0 = photo, 1 = video (kept as number to minimize JSON size)
  // Format: [filename, title, media_type, description, downloads_enabled]
  function transformImageToOptimized(image, downloadsEnabled = true) {
    return [
      image.filename,
      image.title || image.filename,
      image.media_type === 'video' ? 1 : 0,
      image.description || null,
      downloadsEnabled ? 1 : 0
    ];
  }

  // Get only published albums for public static JSON.
  console.log('\n📁 Fetching albums...');
  const albums = db.prepare(`
    SELECT name, ${downloadsEnabledSelect}
    FROM albums
    WHERE published = 1
    ORDER BY sort_order, name
  `).all();
  const albumNames = albums.map(a => a.name);
  console.log(`   Found ${albums.length} published albums`);

  const existingFiles = fs.readdirSync(OUTPUT_DIR);
  const albumJsonFiles = existingFiles.filter(file =>
    file.endsWith('.json') &&
    file !== 'homepage.json' &&
    file !== 'albums-list.json' &&
    file !== '_metadata.json'
  );

  for (const file of albumJsonFiles) {
    const albumName = file.slice(0, -'.json'.length);

    if (!albumNames.includes(albumName)) {
      fs.unlinkSync(path.join(OUTPUT_DIR, file));
      console.log(`   🧹 Removed stale public JSON: ${file}`);
    }
  }

  // Generate JSON for each album
  console.log('\n📸 Generating album JSON files...');
  for (const albumRow of albums) {
    const album = albumRow.name;
    try {
      const images = db.prepare(`
        SELECT filename, title, description, media_type 
        FROM image_metadata 
        WHERE album = ? 
        ORDER BY sort_order, filename
      `).all(album);
      
      // Generate optimized format: array of [filename, title]
      const photos = images.map(image => transformImageToOptimized(image, albumRow.downloads_enabled === 1));
      writeJSON(`${album}.json`, photos);
    } catch (error) {
      console.error(`   ⚠️  Error generating JSON for "${album}":`, error.message);
    }
  }

  // Generate homepage JSON (shuffled photos from albums with show_on_homepage = 1)
  console.log('\n🏠 Generating homepage JSON...');
  try {
    const homepageAlbums = db.prepare('SELECT name FROM albums WHERE published = 1 AND show_on_homepage = 1').all();
    const homepageAlbumNames = homepageAlbums.map(a => a.name);
    
    if (homepageAlbumNames.length > 0) {
      const placeholders = homepageAlbumNames.map(() => '?').join(',');
      const images = db.prepare(`
        SELECT im.filename, im.title, im.description, im.album, im.media_type, im.sort_order, a.sort_order as album_sort_order, ${homepageDownloadsEnabledSelect}
        FROM image_metadata im
        INNER JOIN albums a ON im.album = a.name
        WHERE im.album IN (${placeholders})
        ORDER BY a.sort_order, a.name, im.sort_order, im.filename
      `).all(...homepageAlbumNames);
      
      // Homepage format: [filename, title, album, media_type, description] (need album for multi-album homepage)
      // media_type: 0 = photo, 1 = video
      const photos = images.map(img => [
        img.filename,
        img.title || img.filename,
        img.album,
        img.media_type === 'video' ? 1 : 0,
        img.description || null,
        img.downloads_enabled === 1 ? 1 : 0
      ]);
      
      // Include shuffle setting in homepage JSON
      const homepageData = {
        shuffle: shuffleHomepage,
        photos: photos
      };
      
      writeJSON('homepage.json', homepageData);
      console.log(`   Using ${homepageAlbumNames.length} albums for homepage (shuffle: ${shuffleHomepage})`);
    } else {
      const homepageData = {
        shuffle: shuffleHomepage,
        photos: []
      };
      writeJSON('homepage.json', homepageData);
      console.log(`   No albums configured for homepage`);
    }
  } catch (error) {
    console.error(`   ⚠️  Could not generate homepage.json:`, error.message);
  }

  // Generate albums list
  console.log('\n📋 Generating albums list...');
  writeJSON('albums-list.json', albumNames);

  // Generate metadata file
  const metadata = {
    generatedAt: new Date().toISOString(),
    albumCount: albums.length,
    albums: albumNames
  };
  writeJSON('_metadata.json', metadata);

  db.close();

  console.log('\n✨ Static JSON generation complete!');
  console.log(`   Total albums: ${albums.length}`);
  process.exit(0);
} catch (error) {
  console.error('\n❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
