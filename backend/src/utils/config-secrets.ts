/**
 * Mask / restore sensitive config fields for the config API.
 * GET responses never re-emit raw secrets; PUT restores mask tokens from disk.
 */

/** Placeholder written for non-empty secrets on GET. Presence checks stay truthy. */
export const SECRET_MASK = "********";

/** Leaf keys treated as secrets (walked recursively). */
const SENSITIVE_KEYS = new Set([
  "clientSecret",
  "sessionSecret",
  "password",
  "apiKey",
  "vapidPrivateKey",
  "pass",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (SENSITIVE_KEYS.has(key) && typeof val === "string" && val.length > 0) {
      obj[key] = SECRET_MASK;
    } else if (isPlainObject(val)) {
      maskObject(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (isPlainObject(item)) {
          maskObject(item);
        }
      }
    }
  }
}

/**
 * Deep-clone config and replace non-empty sensitive string fields with SECRET_MASK.
 */
export function maskSensitiveFields<T>(config: T): T {
  if (config === null || config === undefined) {
    return config;
  }
  const clone = structuredClone(config) as T;
  if (isPlainObject(clone)) {
    maskObject(clone);
  }
  return clone;
}

/**
 * When a sensitive field is still SECRET_MASK, keep the on-disk value so a
 * round-trip save does not wipe secrets the admin did not re-enter.
 * Empty strings are left alone (intentional clear).
 */
export function restoreSensitiveFields(
  incoming: unknown,
  current: unknown
): void {
  if (!isPlainObject(incoming) || !isPlainObject(current)) {
    return;
  }

  for (const key of Object.keys(incoming)) {
    const inVal = incoming[key];
    const curVal = current[key];

    if (SENSITIVE_KEYS.has(key) && typeof inVal === "string") {
      if (inVal === SECRET_MASK && typeof curVal === "string") {
        incoming[key] = curVal;
      }
      continue;
    }

    if (isPlainObject(inVal) && isPlainObject(curVal)) {
      restoreSensitiveFields(inVal, curVal);
    } else if (Array.isArray(inVal) && Array.isArray(curVal)) {
      for (let i = 0; i < inVal.length; i++) {
        if (isPlainObject(inVal[i]) && isPlainObject(curVal[i])) {
          restoreSensitiveFields(inVal[i], curVal[i]);
        }
      }
    }
  }
}
