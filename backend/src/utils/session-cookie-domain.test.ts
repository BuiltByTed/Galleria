import assert from "node:assert/strict";
import test from "node:test";
import { getSessionCookieDomain } from "./session-cookie-domain.js";

test("derives cookie domains using multi-label public suffixes", () => {
  assert.equal(
    getSessionCookieDomain("api.example.co.uk"),
    ".example.co.uk"
  );
  assert.equal(
    getSessionCookieDomain("photos.example.com.au"),
    ".example.com.au"
  );
  assert.equal(
    getSessionCookieDomain("admin.example.co.jp"),
    ".example.co.jp"
  );
});

test("derives cookie domains using private public suffixes", () => {
  assert.equal(
    getSessionCookieDomain("api.tenant.github.io"),
    ".tenant.github.io"
  );
});

test("preserves ordinary registrable-domain behavior", () => {
  assert.equal(getSessionCookieDomain("api.example.com"), ".example.com");
  assert.equal(getSessionCookieDomain("EXAMPLE.COM."), ".example.com");
});

test("uses host-only cookies when no registrable domain exists", () => {
  assert.equal(getSessionCookieDomain("co.uk"), undefined);
  assert.equal(getSessionCookieDomain("github.io"), undefined);
  assert.equal(getSessionCookieDomain("localhost"), undefined);
  assert.equal(getSessionCookieDomain("127.0.0.1"), undefined);
  assert.equal(getSessionCookieDomain("::1"), undefined);
  assert.equal(getSessionCookieDomain(""), undefined);
});
