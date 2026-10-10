/**
 * Analytics route handler
 * Proxies analytics events to OpenObserve with authentication
 * This keeps credentials secure on the backend
 * 
 * Validates origin to prevent unauthorized tracking
 */

import { Router } from 'express';
import config from '../config.ts';
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { originsEqual } from '../utils/origins-equal.js';
import { timestampAnalyticsEvent } from '../utils/analytics-timestamp.js';

const router = Router();

// Explicit OPTIONS handler for CORS preflight
router.options('/track', (req, res) => {
  res.status(204).send();
});

// POST endpoint to receive analytics events from frontend
router.post('/track', async (req, res): Promise<void> => {
  try {
    // Get analytics configuration
    const analyticsConfig = config.analytics?.openobserve;
    
    if (!analyticsConfig || !analyticsConfig.enabled) {
      // Analytics disabled, return success without doing anything
      res.status(200).json({ success: true, message: 'Analytics disabled' });
      return;
    }

    const { endpoint, organization, stream, username, password } = analyticsConfig;

    if (!endpoint || !organization || !stream || !username || !password) {
      error('Analytics configuration incomplete');
      res.status(200).json({ success: true, message: 'Analytics not configured' });
      return;
    }

    // Construct the full URL: {endpoint}{organization}/{stream}/_multi
    const analyticsUrl = `${endpoint}${organization}/${stream}/_multi`;

    // Validate origin - only allow requests from allowed origins
    const origin = req.get('Origin') || req.get('Referer');
    const allowedOrigins = config.backend.allowedOrigins;
    
    if (origin) {
      // Exact origin match (not startsWith — confusable subdomain bypass; same as CSRF #3439)
      const isAllowedOrigin = allowedOrigins.some((allowed: string) => originsEqual(origin, allowed));
      if (!isAllowedOrigin) {
        warn('Analytics request from unauthorized origin:', origin);
        res.status(403).json({ error: 'Unauthorized origin' });
        return;
      }
    }

    // Extract client IP address
    // Check X-Forwarded-For header first (for proxies/load balancers)
    // Then fall back to X-Real-IP, and finally to socket remote address
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    let clientIp = req.socket.remoteAddress || 'unknown';
    
    if (typeof forwardedFor === 'string') {
      // X-Forwarded-For can contain multiple IPs, take the first one (original client)
      clientIp = forwardedFor.split(',')[0].trim();
    } else if (typeof realIp === 'string') {
      clientIp = realIp;
    }

    // Add IP address to each event in the array
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const ingestionTime = Date.now();
    const eventsWithIp = events.map((event: unknown) => ({
      ...timestampAnalyticsEvent(event, ingestionTime),
      client_ip: clientIp,
    }));

    // Forward the event(s) to OpenObserve with authentication
    // Use newline-delimited JSON format for _multi endpoint
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    const ndjsonPayload = eventsWithIp.map((event) => JSON.stringify(event)).join('\n');
    
    const response = await fetch(analyticsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
      },
      body: ndjsonPayload,
    });

      if (!response.ok) {
        const errorText = await response.text();
        // Log detailed error on server, but don't send to client
        error('OpenObserve error:', response.status, errorText);
        // Return success anyway to not break frontend or leak infrastructure details
        res.status(200).json({ success: true });
        return;
      }

      res.status(200).json({ success: true });
    } catch (err) {
      error('Analytics proxy error:', err);
      // Return success anyway to not break frontend or leak error details
      res.status(200).json({ success: true });
    }
  });

export default router;
