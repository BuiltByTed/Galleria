#!/usr/bin/env node
/**
 * Build script that reads config.json and builds both frontend and backend
 * Injects safe config values into frontend via environment variables
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { publicApiUrl, publicSiteUrl } from './shared/deployment.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read config.json
const configPath = path.join(__dirname, 'data', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Set ALL environment variables from config.json
const frontendConfig = config.environment.frontend;

const apiUrl = publicApiUrl(config.environment);
const siteUrl = publicSiteUrl(config.environment);

process.env.VITE_API_URL = apiUrl;
process.env.VITE_SITE_URL = siteUrl;
process.env.VITE_SITE_NAME = config.branding.siteName;
process.env.VITE_ANALYTICS_ENABLED = String(config.analytics?.openobserve?.enabled || false);

// Additional values for HTML meta tags
process.env.VITE_SITE_URL_FULL = siteUrl;
process.env.VITE_API_URL_FULL = apiUrl;
process.env.VITE_AVATAR_PATH = config.branding.avatarPath;
process.env.SITE_URL = siteUrl; // For backend sitemap generation

console.log('Environment variables set from config.json:');
console.log(`  VITE_API_URL=${process.env.VITE_API_URL}`);
console.log(`  VITE_SITE_URL=${process.env.VITE_SITE_URL}`);
console.log(`  VITE_SITE_NAME=${process.env.VITE_SITE_NAME}`);
console.log(`  VITE_ANALYTICS_ENABLED=${process.env.VITE_ANALYTICS_ENABLED}`);

// Generate static JSON files for albums (requires backend database)
console.log('\nGenerating static JSON files...');
try {
  execSync('node scripts/generate-static-json.js', {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env }
  });
  console.log('✓ Static JSON files generated');
} catch (error) {
  console.warn('⚠ Warning: Static JSON generation failed (this is okay if database is not available yet)');
  console.warn('  You can generate them later with: npm run generate-static-json');
}

// Build frontend
console.log('\nBuilding frontend...');
try {
  execSync('npm run build', { 
    cwd: path.join(__dirname, 'frontend'),
    stdio: 'inherit',
    env: { ...process.env }
  });
  console.log('✓ Frontend built successfully');
} catch (error) {
  console.error('✗ Frontend build failed');
  process.exit(1);
}

// Note: HTML placeholders are NOT replaced during build
// They are replaced at runtime by server.js for dynamic branding updates
console.log('\\n✓ HTML placeholders will be replaced at runtime');

// Build backend (just compile TypeScript)
console.log('\nCompiling backend...');
try {
  execSync('npm run build', { 
    cwd: path.join(__dirname, 'backend'),
    stdio: 'inherit'
  });
  console.log('✓ Backend compiled successfully');
} catch (error) {
  console.error('✗ Backend build failed');
  process.exit(1);
}

console.log('\n✓ Build complete!');

