// Public URLs are independent of the internal address used by the web proxy.
// Keep legacy environment variables and persisted split-domain configurations.
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || ['', '-', 'none', 'null', 'notset'].includes(value.trim().toLowerCase())) return '';
  const trimmed = value.trim();
  const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Domain must be an HTTP(S) origin without a path or credentials');
  }
  return url.origin;
}

export function publicApiUrl(environment = {}, env = process.env) {
  return normalizeOrigin(env.API_URL) || normalizeOrigin(env.BACKEND_DOMAIN) ||
    (normalizeOrigin(env.DOMAIN) ? '' : normalizeOrigin(environment.frontend?.apiUrl));
}

export function publicSiteUrl(environment = {}, env = process.env, fallback = '') {
  const explicit = normalizeOrigin(env.FRONTEND_DOMAIN) || normalizeOrigin(env.DOMAIN) || normalizeOrigin(environment.frontend?.siteUrl);
  if (explicit) return explicit;
  // Preserve old configurations that predate siteUrl.
  if (fallback) return normalizeOrigin(fallback);
  const origin = environment.backend?.allowedOrigins?.[0];
  return normalizeOrigin(origin) || publicApiUrl(environment, env);
}

export function requestOrigin(req) {
  const first = value => (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
  const protocol = first(req.headers['x-forwarded-proto']) || (req.secure ? 'https' : 'http');
  const host = first(req.headers['x-forwarded-host']) || req.headers.host;
  return normalizeOrigin(`${protocol}://${host}`);
}
