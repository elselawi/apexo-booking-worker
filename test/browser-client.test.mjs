import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../assets/booking.js', import.meta.url), 'utf8');

function browser(storage, send) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', checked: false, hidden: false, disabled: false, textContent: '',
      listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; },
      querySelectorAll: () => [], querySelector: () => null,
      setAttribute() {}, removeAttribute() {}, closest: () => null, focus() {}, reset() {},
    });
    return nodes.get(id);
  };
  for (const [id, value] of Object.entries({ name: 'Jane Doe', phone: '+966551234567',
    'exact-date': '2026-11-09', 'exact-from': '09:00', 'exact-to': '12:00',
    weekday: '1', weeks: '1' })) node(id).value = value;
  node('consent').checked = true;
  const config = { storageKey: 'booking:test', i18n: {}, language: 'en',
    consentVersion: 'v1', apiPath: '/requests', turnstileSiteKey: '' };
  vm.runInNewContext(script, {
    window: { __BOOKING__: config, crypto: webcrypto },
    document: { getElementById: node, querySelectorAll: () => [],
      querySelector: (selector) => selector.includes('preference-kind') ? { value: 'exact' } : node(selector) },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    navigator: {}, TextEncoder, Uint8Array, URL, fetch: send,
  });
  return {
    node,
    async submit() {
      node('booking-form').listeners.submit({ preventDefault() {} });
      for (let tries = 0; node('submit').disabled && tries < 1000; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(node('submit').disabled, false, 'submission must finish');
    },
  };
}

test('ambiguous network retries survive reload without storing patient fields', async () => {
  const storage = new Map();
  const calls = [];
  const send = async (_path, init) => { calls.push(init); throw new Error('response lost'); };
  await browser(storage, send).submit();
  const metadata = JSON.parse(storage.get('booking:test'));
  assert.deepEqual(Object.keys(metadata).sort(), ['fingerprint', 'idem']);
  assert.match(metadata.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!storage.get('booking:test').includes('Jane'));
  await browser(storage, send).submit();
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
});

test('editing a failed submission starts a different idempotency attempt', async () => {
  const calls = [];
  const app = browser(new Map(), async (_path, init) => {
    calls.push(init);
    return { status: 422, json: async () => ({ ok: false, error: { code: 'invalid_fields' } }) };
  });
  await app.submit();
  app.node('exact-date').value = '2026-11-10';
  await app.submit();
  assert.notEqual(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
});

test('a receipt restored from storage keeps its idempotency key', () => {
  const storage = new Map([['booking:test', JSON.stringify({ reference: '1109-01', idem: 'saved-key' })]]);
  const app = browser(storage, () => { throw new Error('must not submit'); });
  assert.equal(app.node('booking-form').hidden, true);
  assert.equal(app.node('receipt-id').textContent, '1109-01');
  assert.equal(JSON.parse(storage.get('booking:test')).idem, 'saved-key');
});
