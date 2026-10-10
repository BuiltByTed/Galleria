/**
 * Exact origin equality (scheme + host + port via URL.origin).
 * Rejects confusable subdomain prefixes that string startsWith would accept
 * (e.g. https://www.example.com.evil.tld when allowed is https://www.example.com).
 * Regression of #537 / ticket 3439.
 */
export function originsEqual(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
