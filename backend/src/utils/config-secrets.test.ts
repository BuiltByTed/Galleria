import assert from "node:assert/strict";
import test from "node:test";
import {
  SECRET_MASK,
  maskSensitiveFields,
  restoreSensitiveFields,
} from "./config-secrets.js";

const sampleConfig = () => ({
  environment: {
    auth: {
      google: {
        enabled: true,
        clientId: "public-client-id",
        clientSecret: "google-secret-value",
      },
      sessionSecret: "session-secret-value",
      authorizedEmails: ["admin@example.com"],
    },
  },
  email: {
    enabled: true,
    smtp: {
      host: "smtp.example.com",
      port: 587,
      auth: {
        user: "smtp-user",
        pass: "smtp-password",
      },
    },
  },
  openai: {
    apiKey: "sk-test-openai-key",
  },
  pushNotifications: {
    enabled: true,
    vapidPublicKey: "vapid-public",
    vapidPrivateKey: "vapid-private-secret",
  },
  analytics: {
    openobserve: {
      enabled: true,
      endpoint: "https://oo.example.com",
      username: "oo-user",
      password: "oo-password",
    },
  },
  branding: {
    siteName: "Galleria",
  },
});

test("maskSensitiveFields redacts known secrets and leaves non-secrets", () => {
  const masked = maskSensitiveFields(sampleConfig());

  assert.equal(masked.environment.auth.google.clientSecret, SECRET_MASK);
  assert.equal(masked.environment.auth.sessionSecret, SECRET_MASK);
  assert.equal(masked.email.smtp.auth.pass, SECRET_MASK);
  assert.equal(masked.openai.apiKey, SECRET_MASK);
  assert.equal(masked.pushNotifications.vapidPrivateKey, SECRET_MASK);
  assert.equal(masked.analytics.openobserve.password, SECRET_MASK);

  // Non-secrets preserved
  assert.equal(masked.environment.auth.google.clientId, "public-client-id");
  assert.equal(masked.email.smtp.auth.user, "smtp-user");
  assert.equal(masked.pushNotifications.vapidPublicKey, "vapid-public");
  assert.equal(masked.analytics.openobserve.username, "oo-user");
  assert.equal(masked.branding.siteName, "Galleria");
});

test("maskSensitiveFields does not mutate the original object", () => {
  const original = sampleConfig();
  maskSensitiveFields(original);
  assert.equal(original.openai.apiKey, "sk-test-openai-key");
  assert.equal(original.environment.auth.sessionSecret, "session-secret-value");
});

test("maskSensitiveFields leaves empty secrets empty", () => {
  const masked = maskSensitiveFields({
    openai: { apiKey: "" },
    environment: { auth: { sessionSecret: "", google: { clientSecret: "" } } },
  });
  assert.equal(masked.openai.apiKey, "");
  assert.equal(masked.environment.auth.sessionSecret, "");
  assert.equal(masked.environment.auth.google.clientSecret, "");
});

test("restoreSensitiveFields restores mask tokens from current config", () => {
  const current = sampleConfig();
  const incoming = maskSensitiveFields(current);
  // Simulate admin toggling a non-secret
  incoming.branding.siteName = "Updated";

  restoreSensitiveFields(incoming, current);

  assert.equal(incoming.environment.auth.sessionSecret, "session-secret-value");
  assert.equal(incoming.environment.auth.google.clientSecret, "google-secret-value");
  assert.equal(incoming.email.smtp.auth.pass, "smtp-password");
  assert.equal(incoming.openai.apiKey, "sk-test-openai-key");
  assert.equal(incoming.pushNotifications.vapidPrivateKey, "vapid-private-secret");
  assert.equal(incoming.analytics.openobserve.password, "oo-password");
  assert.equal(incoming.branding.siteName, "Updated");
});

test("restoreSensitiveFields allows intentional clear via empty string", () => {
  const current = sampleConfig();
  const incoming = maskSensitiveFields(current);
  incoming.openai.apiKey = "";

  restoreSensitiveFields(incoming, current);

  assert.equal(incoming.openai.apiKey, "");
  assert.equal(incoming.environment.auth.sessionSecret, "session-secret-value");
});

test("restoreSensitiveFields accepts a new secret value", () => {
  const current = sampleConfig();
  const incoming = maskSensitiveFields(current);
  incoming.openai.apiKey = "sk-new-key";

  restoreSensitiveFields(incoming, current);

  assert.equal(incoming.openai.apiKey, "sk-new-key");
});
