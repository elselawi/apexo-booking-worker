import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { baseConfig, resetDatabase, seedClinic, ADMIN_KEY, HANDLE, INBOX_KEY } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

describe("health", () => {
  it("reports whether the Turnstile secret is accepted", async () => {
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
        new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      const healthy = await SELF.fetch("https://book.test/health?deep=1");
      expect(await healthy.json()).toMatchObject({ ok: true, turnstile: "ok" });

      (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
        new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      const broken = await SELF.fetch("https://book.test/health?deep=1");
      expect(await broken.json()).toMatchObject({ turnstile: "invalid-secret" });

      const plain = await SELF.fetch("https://book.test/health");
      expect(await plain.json()).toEqual({ ok: true, version: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("public page", () => {
  it("escapes clinic text and ships a strict CSP with a nonce", async () => {
    await seedClinic({
      config: baseConfig({
        profile: {
          ...baseConfig().profile,
          name: '<script>alert("x")</script>',
          welcome: "Call <b>us</b>",
        },
      }),
    });
    const response = await SELF.fetch(`https://book.test/${HANDLE}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("Call &lt;b&gt;us&lt;/b&gt;");
    expect(html).toContain('dir="ltr"');

    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toMatch(/script-src 'self' 'nonce-[a-f0-9]+'/);
    expect(csp).toMatch(/style-src 'self' 'nonce-[a-f0-9]+'/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).not.toContain("pbaccountid");
  });

  it("renders Arabic right-to-left and honours an explicit language", async () => {
    await seedClinic();
    const response = await SELF.fetch(`https://book.test/${HANDLE}?lang=ar`);
    const html = await response.text();
    expect(html).toContain('lang="ar"');
    expect(html).toContain('dir="rtl"');
  });

  it("renders every shipped language, with the right-to-left ones mirrored", async () => {
    await seedClinic();
    const rtl = ["ar", "fa", "ku", "ur"];
    for (const language of ["en", "es", "el", "fa", "ku", "fr", "tr", "it", "ur", "ar"]) {
      const response = await SELF.fetch(`https://book.test/${HANDLE}?lang=${language}`);
      const html = await response.text();
      expect(html, language).toContain(`lang="${language}"`);
      expect(html, language).toContain(`dir="${rtl.includes(language) ? "rtl" : "ltr"}"`);
    }
  });

  it("offers a language picker and remembers an explicit choice", async () => {
    await seedClinic();
    const response = await SELF.fetch(`https://book.test/${HANDLE}?lang=fr`);
    const html = await response.text();
    expect(html).toContain('id="booking-language"');
    for (const name of ["English", "Français", "العربية", "Türkçe"]) {
      expect(html).toContain(name);
    }
    expect(html).toMatch(/<option value="fr" selected/);
    expect(response.headers.get("set-cookie")).toContain("booking_lang=fr");

    const remembered = await SELF.fetch(`https://book.test/${HANDLE}`, {
      headers: { cookie: "booking_lang=tr" },
    });
    const rememberedHtml = await remembered.text();
    expect(rememberedHtml).toContain('lang="tr"');
    expect(remembered.headers.get("set-cookie")).toBeNull();
  });

  it("starts the opening hours at the clinic-local today", async () => {
    await seedClinic();
    const response = await SELF.fetch(`https://book.test/${HANDLE}`);
    const html = await response.text();
    const order = [...html.matchAll(/class="day-name">([^<]+)</g)].map((m) => m[1]);
    expect(order).toHaveLength(7);
    // Each row carries the day it represents; today is first and marked.
    const firstRow = /<div class="hours-row is-today[^"]*"[^>]*><dt>.*?class="day-name">([^<]+)</.exec(html);
    expect(firstRow).not.toBeNull();
    expect(order[0]).toBe(firstRow![1]);
  });

  it("shows a notice instead of the form when intake is disabled", async () => {
    await seedClinic({ config: { ...baseConfig(), enabled: false } });
    const response = await SELF.fetch(`https://book.test/${HANDLE}`);
    const html = await response.text();
    expect(html).toContain("not currently accepting appointment requests");
    expect(html).not.toContain('id="booking-form"');
  });

  it("returns a generic 404 for unknown and suspended clinics", async () => {
    await seedClinic({ status: "suspended" });
    const suspended = await SELF.fetch(`https://book.test/${HANDLE}`);
    expect(suspended.status).toBe(404);
    const suspendedHtml = await suspended.text();
    expect(suspendedHtml).not.toContain("Jim Dental Clinic");

    const unknown = await SELF.fetch("https://book.test/nosuchclinic");
    expect(unknown.status).toBe(404);
  });

  it("lets the Flutter web client read current public hours and API errors", async () => {
    await seedClinic();
    const headers = { origin: "https://app.test" };
    const current = await SELF.fetch(`https://book.test/v1/clinics/${HANDLE}`, { headers });
    expect(current.status).toBe(200);
    expect(current.headers.get("access-control-allow-origin")).toBe(headers.origin);
    expect(await current.json()).toMatchObject({ timeZone: "UTC", hours: baseConfig().hours });
    const missing = await SELF.fetch("https://book.test/v1/clinics/unknownclinic", { headers });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(headers.origin);
  });

  it("serves the privacy notice", async () => {
    const response = await SELF.fetch("https://book.test/privacy");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Privacy notice");
  });

  it("serves the fingerprinted client bundle the page references", async () => {
    await seedClinic();
    const page = await SELF.fetch(`https://book.test/${HANDLE}`);
    const html = await page.text();

    const script = /\/assets\/booking-[a-f0-9]+\.js/.exec(html);
    expect(script).not.toBeNull();
    const scriptAsset = await SELF.fetch(`https://book.test${script![0]}`);
    expect(scriptAsset.status).toBe(200);
    expect(scriptAsset.headers.get("cache-control")).toContain("immutable");
    expect(scriptAsset.headers.get("content-type")).toContain("javascript");
    expect(await scriptAsset.text()).toContain("__BOOKING__");

    const stylesheet = /\/assets\/booking-[a-f0-9]+\.css/.exec(html);
    expect(stylesheet).not.toBeNull();
    const styleAsset = await SELF.fetch(`https://book.test${stylesheet![0]}`);
    expect(styleAsset.status).toBe(200);
    expect(styleAsset.headers.get("content-type")).toContain("text/css");
  });

  it("does not serve assets for a different fingerprint", async () => {
    const response = await SELF.fetch("https://book.test/assets/booking-deadbeef.css");
    expect(response.status).toBe(404);
  });

  it("answers liveness without tenant data", async () => {
    const response = await SELF.fetch("https://book.test/health");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true, version: 1 });
  });

  it("renders accessible 3-step form, noscript fallback, today hours emphasis, and contrast-safe accent tokens", async () => {
    await seedClinic({
      config: baseConfig({
        profile: {
          ...baseConfig().profile,
          accentColor: "#aabbcc",
        },
      }),
    });
    const response = await SELF.fetch(`https://book.test/${HANDLE}`);
    expect(response.status).toBe(200);
    const html = await response.text();

    // Exactly one h1
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // Light custom accent derives dark on-accent text for WCAG AA
    expect(html).toContain("--accent:#aabbcc;--on-accent:#0b131b;");
    // Opening hours marks today's row and closed days
    expect(html).toContain('aria-current="date"');
    expect(html).toContain('class="badge-closed"');
    // Honest no-JS fallback and receipt reset action
    expect(html).toContain("<noscript>");
    expect(html).toContain('id="request-another"');
    // No inline style attributes (CSP compliance)
    expect(html).not.toMatch(/\sstyle=/i);
  });
});

describe("public clinic projection", () => {
  it("publishes only the allowlisted fields", async () => {
    await seedClinic({
      config: baseConfig({
        contactEmail: "clinic@example.com",
        closedDates: ["2026-12-25"],
      }),
    });
    const response = await SELF.fetch(`https://book.test/v1/clinics/${HANDLE}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    const config = JSON.parse(body) as Record<string, unknown> & {
      configRevision: number;
      consentVersion: string;
      hours: { mon: string[][] };
    };
    expect(Object.keys(config).sort()).toEqual([
      "clinicId",
      "closedDates",
      "configRevision",
      "consentVersion",
      "dialCode",
      "enabled",
      "handle",
      "hours",
      "profile",
      "timeZone",
    ]);
    expect(body).not.toContain("clinic@example.com");
    expect(body).not.toContain("admin");
    expect(config.hours.mon).toEqual([["09:00", "13:00"]]);
    expect(config.configRevision).toBe(1);
    expect(config.consentVersion).toBe("booking-privacy-v1");
  });

  it("404s a suspended clinic’s public configuration", async () => {
    await seedClinic({ status: "suspended" });
    const response = await SELF.fetch(`https://book.test/v1/clinics/${HANDLE}`);
    expect(response.status).toBe(404);
  });
});

describe("CORS", () => {
  it("permits preflight only from the approved app origin", async () => {
    const approved = await SELF.fetch("https://book.test/v1/clinic/diagnostics", {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "POST" },
    });
    expect(approved.status).toBe(204);
    expect(approved.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(approved.headers.get("access-control-allow-headers")).toContain("authorization");

    const evil = await SELF.fetch("https://book.test/v1/clinic/diagnostics", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never reflects an unrecognized origin on a protected call", async () => {
    await seedClinic();
    const response = await SELF.fetch("https://book.test/v1/clinic/diagnostics", {
      method: "POST",
      headers: {
        authorization: `Bearer ${INBOX_KEY}`,
        "content-type": "application/json",
        origin: "https://evil.test",
      },
      body: "{}",
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
