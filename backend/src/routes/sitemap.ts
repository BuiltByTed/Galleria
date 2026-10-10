import { publicSiteUrl, requestOrigin } from '../../../shared/deployment.js';
import { getCurrentConfig } from '../config.js';
/**
 * Sitemap route handler
 * Generates XML sitemap for search engines
 */

import { Router } from 'express';
import { getAllAlbums } from '../database.js';
import { isEnvSet } from '../config.js';
import { error } from '../utils/logger.js';

const router = Router();

/**
 * Get all published albums
 */
function getPublishedAlbums(): string[] {
  try {
    // Get all albums and filter to published ones
    return getAllAlbums()
      .filter(a => a.published && a.name !== 'homepage')
      .map(a => a.name);
  } catch (err) {
    error('[Sitemap] Failed to get albums for sitemap:', err);
    return [];
  }
}

/**
 * Dynamically determine the site URL from the request
 */
function getSiteUrl(req: any): string {
  // First, try SITE_URL environment variable (set by build.js)
  if (isEnvSet(process.env.SITE_URL)) {
    return process.env.SITE_URL!;
  }
  
  return publicSiteUrl(getCurrentConfig(), process.env, requestOrigin(req));
}

router.get('/sitemap.xml', (req, res) => {
  const albums = getPublishedAlbums();
  const baseUrl = getSiteUrl(req);
  const today = new Date().toISOString().split('T')[0];
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/license</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`;

  albums.forEach(albumName => {
    const encodedAlbum = encodeURIComponent(albumName);
    const albumUrl = `${baseUrl}/album/${encodedAlbum}`;
    
    xml += `
  <url>
    <loc>${albumUrl}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
  });

  xml += '\n</urlset>';
  
  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

router.get('/robots.txt', (req, res) => {
  const baseUrl = getSiteUrl(req);
  
  const robotsTxt = `User-agent: *
Disallow: /primes/

Sitemap: ${baseUrl}/sitemap.xml
`;
  
  res.header('Content-Type', 'text/plain');
  res.send(robotsTxt);
});

export default router;

