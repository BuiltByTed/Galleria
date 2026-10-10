import assert from 'node:assert/strict';
import test from 'node:test';

// Minimal RP env so generateAuthenticationOptions does not need full app config.
process.env.RP_ID = process.env.RP_ID || 'localhost';
process.env.ORIGIN = process.env.ORIGIN || 'http://localhost:5173';

const { generatePasskeyAuthenticationOptions } = await import('./passkeys.js');

test('generatePasskeyAuthenticationOptions never populates allowCredentials', async () => {
  const withPasskeys = await generatePasskeyAuthenticationOptions([
    {
      id: 1,
      name: 'yubikey',
      credentialID: 'AAAA',
      transports: ['usb'],
    },
    {
      id: 2,
      name: 'phone',
      credentialID: 'BBBB',
      transports: ['internal'],
    },
  ]);
  const without = await generatePasskeyAuthenticationOptions([]);
  const omitted = await generatePasskeyAuthenticationOptions();

  for (const options of [withPasskeys, without, omitted]) {
    assert.ok(options.challenge, 'challenge present');
    assert.ok(options.rpId || options.rpID, 'rp id present');
    // Empty list or absent — never a list of real credential IDs
    const allow = (options as { allowCredentials?: unknown[] }).allowCredentials;
    if (allow !== undefined) {
      assert.deepEqual(allow, []);
    }
  }

  // Shape must not depend on whether fake passkeys were supplied
  assert.equal(
    (withPasskeys as { allowCredentials?: unknown[] }).allowCredentials?.length ?? 0,
    (without as { allowCredentials?: unknown[] }).allowCredentials?.length ?? 0
  );
  // Must not echo caller-supplied credential IDs
  const serialized = JSON.stringify(withPasskeys);
  assert.equal(serialized.includes('AAAA'), false);
  assert.equal(serialized.includes('BBBB'), false);
});
