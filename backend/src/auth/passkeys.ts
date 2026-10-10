/**
 * Passkeys (WebAuthn) Module
 * Handles passkey registration and authentication
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/types";
import config, { isEnvSet, getCurrentConfig } from "../config.js";
import { publicSiteUrl } from "../../../shared/deployment.js";
import { debug, warn } from "../utils/logger.js";

// Get RP (Relying Party) configuration from environment or config
const getRPConfig = () => {
  // Dynamically determine RP ID from environment or config
  let rpID = process.env.RP_ID;
  let origin = process.env.ORIGIN;

  // If not set via env vars, try to infer from environment variables or config
  if (!rpID || !origin) {
    try {
      const siteUrl = publicSiteUrl(getCurrentConfig());
      if (siteUrl) {
        const frontendUrl = new URL(siteUrl);
        rpID = rpID || frontendUrl.hostname;
        origin = origin || frontendUrl.origin;
      }
    } catch (err) {
      warn(
        "[Passkeys] Could not infer RP config from environment or config:",
        err
      );
    }
  }

  // Fallback to defaults
  rpID = rpID || "localhost";
  origin = origin || "http://localhost:3000";
  const rpName = process.env.RP_NAME || "Galleria";

  debug("[Passkeys] RP Config:", { rpID, rpName, origin });

  return { rpID, rpName, origin };
};

/**
 * Generate options for passkey registration
 */
export async function generatePasskeyRegistrationOptions(
  userId: number,
  userEmail: string,
  userName: string,
  existingPasskeys: any[] = []
) {
  const { rpID, rpName } = getRPConfig();

  // Encode user ID as base64url to ensure it's valid for WebAuthn
  // Convert to Uint8Array as expected by v9 API
  const userIdBuffer = new Uint8Array(Buffer.from(`user-${userId}`, "utf-8"));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: userIdBuffer,
    userName: userEmail,
    userDisplayName: userName || userEmail,
    attestationType: "none",
    // @ts-ignore - v9 API type mismatch, works at runtime
    excludeCredentials: existingPasskeys.map((passkey) => ({
      id: passkey.credentialID,
      type: "public-key",
      transports: passkey.transports,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
      // Remove platform restriction to allow security keys too
    },
  });

  return options;
}

/**
 * Verify passkey registration response
 */
export async function verifyPasskeyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string
): Promise<VerifiedRegistrationResponse> {
  const { rpID, origin } = getRPConfig();

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });

  return verification;
}

/**
 * Generate options for passkey authentication.
 *
 * Always discoverable: allowCredentials is intentionally empty regardless of
 * any caller-supplied passkeys. Populating allowCredentials from a public
 * email lookup enables account/credential enumeration (ticket #3444).
 *
 * @param _existingPasskeys unused — kept for call-site compatibility
 */
export async function generatePasskeyAuthenticationOptions(
  _existingPasskeys: any[] = []
) {
  const { rpID } = getRPConfig();

  debug("[Passkeys] Generating auth options for RP:", rpID);

  // Empty allowCredentials: discoverable credentials only. Password managers
  // (e.g. 1Password) offer stored passkeys without server-side credential lists.
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials: [],
  });

  return options;
}

/**
 * Verify passkey authentication response
 */
export async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credentialPublicKey: string,
  credentialCounter: number
): Promise<VerifiedAuthenticationResponse> {
  const { rpID, origin } = getRPConfig();

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    authenticator: {
      credentialPublicKey: Buffer.from(credentialPublicKey, "base64url"),
      credentialID: Buffer.from(response.id, "base64url"),
      counter: credentialCounter,
    },
  } as any); // v9 API uses 'authenticator' despite type definitions

  return verification;
}
