(() => {
  'use strict';

  const els = {
    card: document.querySelector('#privacyConsent'),
    status: document.querySelector('#privacyStatus'),
    allow: document.querySelector('#allowTelemetry'),
    deny: document.querySelector('#denyTelemetry')
  };

  function render(consent) {
    if (!els.card) return;
    els.card.hidden = false;
    if (!consent.decided) {
      els.status.textContent = 'Choose an option before using the extension controls.';
      els.allow.hidden = false;
      els.deny.hidden = false;
      return;
    }
    if (consent.telemetry) {
      els.status.textContent = 'Usage and diagnostics sharing is enabled. You can turn it off at any time.';
      els.allow.hidden = true;
      els.deny.hidden = false;
    } else {
      els.status.textContent = 'Usage and diagnostics sharing is disabled. Highlighting remains available.';
      els.allow.hidden = false;
      els.deny.hidden = true;
    }
  }

  async function init(onDecision = () => {}) {
    if (!els.card) return { decided: false, telemetry: false };
    const consent = await AMH_ACCESS_POLICY.requestConsentStatus();
    render(consent);
    els.allow.addEventListener('click', () => choose(true, onDecision));
    els.deny.addEventListener('click', () => choose(false, onDecision));
    return consent;
  }

  async function choose(telemetry, onDecision) {
    els.allow.disabled = true;
    els.deny.disabled = true;
    const ok = await AMH_ACCESS_POLICY.setTelemetryConsent(telemetry);
    if (!ok) {
      els.status.textContent = 'Could not save the privacy choice. Try again.';
      els.allow.disabled = false;
      els.deny.disabled = false;
      return;
    }
    const consent = await AMH_ACCESS_POLICY.requestConsentStatus();
    els.allow.disabled = false;
    els.deny.disabled = false;
    render(consent);
    await onDecision(consent);
  }

  globalThis.AMH_PRIVACY_UI = Object.freeze({ init });
})();
