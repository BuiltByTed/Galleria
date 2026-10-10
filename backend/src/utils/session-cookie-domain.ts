import { getDomain } from "tldts";

/**
 * Return a cookie domain shared by subdomains of the same registrable domain.
 * Hosts without a registrable domain use the browser's host-only default.
 */
export function getSessionCookieDomain(hostname: string): string | undefined {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalizedHostname) {
    return undefined;
  }

  const registrableDomain = getDomain(normalizedHostname, {
    allowPrivateDomains: true,
  });

  return registrableDomain ? `.${registrableDomain}` : undefined;
}
