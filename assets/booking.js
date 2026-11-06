(function () {
  "use strict";

  var config = window.__BOOKING__;
  if (!config) return;

  function el(id) {
    return document.getElementById(id);
  }

  var form = el("booking-form");
  if (!form) return;

  var pending = null;
  try {
    pending = sessionStorage.getItem(config.storageKey);
  } catch (error) {
    /* storage may be unavailable in private modes */
  }
  var idemKey = null;
  var idemFingerprint = null;
  var turnstileWidget = null;
  var turnstileReady = false;

  function t(key, replacements) {
    var value = config.i18n[key] || key;
    if (replacements) {
      Object.keys(replacements).forEach(function (token) {
        value = value.split("{" + token + "}").join(replacements[token]);
      });
    }
    return value;
  }

  function controlsForField(field) {
    if (field === "name") return [el("name")];
    if (field === "phone") return [el("phone")];
    if (field === "email") return [el("email")];
    if (field === "note") return [el("note")];
    if (field === "consentAccepted") return [el("consent")];
    if (field === "preference") {
      var kind = preferenceKind();
      if (kind === "exact") return [el("exact-date"), el("exact-from"), el("exact-to")];
      if (kind === "range") {
        return [el("range-start"), el("range-end"), el("range-from"), el("range-to")];
      }
      return [el("weekday"), el("weeks"), el("weekday-from"), el("weekday-to")];
    }
    return [];
  }

  function clearErrors() {
    document.querySelectorAll("[data-error-for]").forEach(function (node) {
      node.textContent = "";
    });
    form.querySelectorAll('[aria-invalid="true"]').forEach(function (control) {
      control.removeAttribute("aria-invalid");
    });
    form.querySelectorAll(".has-error").forEach(function (wrapper) {
      wrapper.classList.remove("has-error");
    });
  }

  function showError(field, message) {
    var node = document.querySelector('[data-error-for="' + field + '"]');
    if (node) node.textContent = message;
    controlsForField(field).forEach(function (control) {
      if (!control) return;
      control.setAttribute("aria-invalid", "true");
      var wrapper = control.closest(".field, .consent-box");
      if (wrapper) wrapper.classList.add("has-error");
    });
  }

  function focusFirstInvalid() {
    var first = form.querySelector('[aria-invalid="true"]');
    if (first && typeof first.focus === "function") {
      first.focus();
    }
  }

  function setFormError(message) {
    var node = el("form-error");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function preferenceKind() {
    var checked = document.querySelector('input[name="preference-kind"]:checked');
    return checked ? checked.value : "exact";
  }

  function syncPreferenceFields() {
    var kind = preferenceKind();
    el("exact-fields").hidden = kind !== "exact";
    el("range-fields").hidden = kind !== "range";
    el("weekday-fields").hidden = kind !== "weekday";
    el("weekday-summary").textContent = weekdaySummary();
  }

  function weekdaySummary() {
    var day = Number(el("weekday").value);
    var weeks = Number(el("weeks").value);
    var label = config.i18n["weekday" + day] || "";
    return t("nextOccurrences", { count: weeks, day: label });
  }

  function digits(value) {
    return value
      .replace(/[\u0660-\u0669]/g, function (d) {
        return String(d.charCodeAt(0) - 0x0660);
      })
      .replace(/[\u06f0-\u06f9]/g, function (d) {
        return String(d.charCodeAt(0) - 0x06f0);
      });
  }

  function normalizePhone(value) {
    var stripped = digits(value)
      .trim()
      .replace(/[ \-.()]/g, "");
    return /^\+[1-9][0-9]{7,14}$/.test(stripped) ? stripped : null;
  }

  function normalizeEmail(value) {
    var trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.length > 254 || /\s/.test(trimmed)) return null;
    var parts = trimmed.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return trimmed;
  }

  function codePoints(value) {
    return Array.from(value).length;
  }

  function buildPreference() {
    var kind = preferenceKind();
    if (kind === "exact") {
      return {
        kind: "exact",
        date: el("exact-date").value,
        from: el("exact-from").value,
        to: el("exact-to").value,
      };
    }
    if (kind === "range") {
      return {
        kind: "range",
        start: el("range-start").value,
        end: el("range-end").value,
        from: el("range-from").value,
        to: el("range-to").value,
      };
    }
    return {
      kind: "weekday",
      weekday: Number(el("weekday").value),
      weeks: Number(el("weeks").value),
      from: el("weekday-from").value,
      to: el("weekday-to").value,
    };
  }

  function validate(body) {
    clearErrors();
    var valid = true;
    if (!body.name) {
      showError("name", t("fieldName"));
      valid = false;
    }
    if (!body.phone) {
      showError("phone", t("fieldPhone"));
      valid = false;
    }
    // The address is optional: only a value that is present but malformed is
    // an error. `normalizeEmail("")` is "" and an invalid address is null.
    var emailInput = el("email").value.trim();
    if (emailInput && normalizeEmail(emailInput) === null) {
      showError("email", t("fieldEmail"));
      valid = false;
    }
    if (body.note && codePoints(body.note) > 500) {
      showError("note", t("fieldNote"));
      valid = false;
    }
    var preference = body.preference;
    var datesOk = true;
    if (preference.kind === "exact") {
      datesOk = !!preference.date;
    } else if (preference.kind === "range") {
      datesOk = !!preference.start && !!preference.end && preference.start <= preference.end;
    }
    if (!datesOk || !preference.from || !preference.to || preference.from >= preference.to) {
      showError("preference", t("fieldPreference"));
      valid = false;
    }
    if (!body.consentAccepted) {
      showError("consentAccepted", t("fieldConsent"));
      valid = false;
    }
    return valid;
  }

  function currentTurnstileToken() {
    if (!turnstileReady || !window.turnstile || turnstileWidget === null) return "";
    return window.turnstile.getResponse(turnstileWidget) || "";
  }

  function resetTurnstile() {
    if (turnstileReady && window.turnstile && turnstileWidget !== null) {
      window.turnstile.reset(turnstileWidget);
    }
  }

  function errorMessage(code) {
    var map = {
      rate_limited: "errorRateLimited",
      queue_full: "errorQueueFull",
      clinic_disabled: "errorClinicDisabled",
      unknown_clinic: "errorUnknownClinic",
      too_large: "errorTooLarge",
      invalid_fields: "errorInvalidFields",
      verification_failed: "errorVerification",
      unavailable: "errorUnavailable",
      idempotency_conflict: "errorIdempotency",
    };
    return t(map[code] || "errorGeneric");
  }

  function markFields(fields) {
    if (!fields) return;
    Object.keys(fields).forEach(function (key) {
      showError(key, t("fieldInvalid"));
    });
  }

  function newIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.from(bytes, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
    return (
      hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" + hex.slice(20)
    );
  }

  function submit(body, button) {
    if (!validate(body)) {
      focusFirstInvalid();
      return;
    }
    var token = currentTurnstileToken();
    if (config.turnstileSiteKey && !token) {
      setFormError(t("errorVerification"));
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = t("sending");
    setFormError("");

    // Persist only retry metadata, never the patient's submitted fields.
    window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)))
      .then(function (digest) {
        var fingerprint = Array.from(new Uint8Array(digest), function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
        if (!idemKey || idemFingerprint !== fingerprint) idemKey = newIdempotencyKey();
        idemFingerprint = fingerprint;
        try {
          sessionStorage.setItem(config.storageKey, JSON.stringify({
            idem: idemKey, fingerprint: idemFingerprint,
          }));
        } catch (error) {
          /* storage may be unavailable in private modes */
        }
        return fetch(config.apiPath, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idemKey,
          },
          body: JSON.stringify(Object.assign({}, body, { turnstileToken: token })),
          credentials: "omit",
        });
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return { ok: false, error: { code: "unavailable" } };
          })
          .then(function (payload) {
            return { status: response.status, payload: payload };
          });
      })
      .then(function (result) {
        var payload = result.payload;
        if (payload && payload.ok) {
          showReceipt(payload.reference);
          return;
        }
        var code = (payload && payload.error && payload.error.code) || "unavailable";
        if (code === "invalid_fields") {
          markFields(payload.error.fields);
          focusFirstInvalid();
        }
        setFormError(errorMessage(code));
        resetTurnstile();
      })
      .catch(function () {
        setFormError(t("errorGeneric"));
        resetTurnstile();
      })
      .then(function () {
        button.disabled = false;
        button.textContent = t("sendRequest");
      });
  }

  function showReceipt(reference) {
    form.hidden = true;
    var receipt = el("receipt");
    receipt.hidden = false;
    el("receipt-id").textContent = reference;
    try {
      sessionStorage.setItem(
        config.storageKey,
        JSON.stringify({ reference: reference, idem: idemKey }),
      );
    } catch (error) {
      /* storage may be unavailable in private modes */
    }
    var copy = el("copy-receipt");
    copy.textContent = t("copy");
    copy.removeAttribute("data-copied");
    copy.onclick = function () {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(reference).then(function () {
          copy.textContent = t("copied");
          copy.setAttribute("data-copied", "true");
        });
      }
    };
    var another = el("request-another");
    if (another) {
      another.onclick = function () {
        try {
          sessionStorage.removeItem(config.storageKey);
        } catch (error) {
          /* ignore */
        }
        idemKey = null;
        idemFingerprint = null;
        form.reset();
        clearErrors();
        setFormError("");
        syncPreferenceFields();
        resetTurnstile();
        receipt.hidden = true;
        form.hidden = false;
        var nameInput = el("name");
        if (nameInput) nameInput.focus();
      };
    }
  }

  function restore() {
    if (!pending) return;
    try {
      var stored = JSON.parse(pending);
      if (stored && stored.idem) {
        idemKey = stored.idem;
        idemFingerprint = stored.fingerprint || null;
      }
      if (stored && stored.reference) {
        showReceipt(stored.reference);
      }
    } catch (error) {
      /* ignore malformed storage */
    }
  }

  document.querySelectorAll('input[name="preference-kind"]').forEach(function (radio) {
    radio.addEventListener("change", syncPreferenceFields);
  });
  el("weekday").addEventListener("change", syncPreferenceFields);
  el("weeks").addEventListener("change", syncPreferenceFields);

  var languageSelect = el("booking-language");
  if (languageSelect) {
    languageSelect.addEventListener("change", function () {
      var next = new URL(window.location.href);
      next.searchParams.set("lang", languageSelect.value);
      window.location.assign(next.toString());
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var email = normalizeEmail(el("email").value);
    var body = {
      name: el("name").value.trim().normalize("NFC"),
      phone: normalizePhone(el("phone").value) || "",
      email: email || null,
      note: el("note").value.trim().normalize("NFC") || null,
      preference: buildPreference(),
      language: config.language,
      consentVersion: config.consentVersion,
      consentAccepted: el("consent").checked,
    };
    submit(body, el("submit"));
  });

  syncPreferenceFields();
  restore();

  if (config.turnstileSiteKey) {
    var script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.nonce = config.nonce;
    script.onload = function () {
      if (!window.turnstile) return;
      turnstileWidget = window.turnstile.render("#turnstile", {
        sitekey: config.turnstileSiteKey,
        action: "booking_submit",
        theme: "auto",
      });
      turnstileReady = true;
    };
    document.head.appendChild(script);
  }
})();
