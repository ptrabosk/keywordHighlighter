(() => {
  'use strict';

  const ORGANIZATION_EMAIL_DOMAIN = 'attentivemobile.com';
  const PRIVACY_CONSENT_KEY = 'amhPrivacyConsent';
  const PRIVACY_CONSENT_VERSION = 1;

  function isOrganizationEmail(email) {
    return /^[^@\s]+@attentivemobile\.com$/i.test(String(email || '').trim());
  }

  async function requestAccessStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'highlighter:getAccessStatus' });
      return {
        allowed: response?.allowed === true,
        reason: response?.reason || (response?.allowed ? 'allowed' : 'access_denied')
      };
    } catch {
      return { allowed: false, reason: 'access_check_failed' };
    }
  }

  async function requestConsentStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'highlighter:getConsentStatus' });
      return {
        decided: response?.decided === true,
        telemetry: response?.telemetry === true,
        version: response?.version || PRIVACY_CONSENT_VERSION
      };
    } catch {
      return { decided: false, telemetry: false, version: PRIVACY_CONSENT_VERSION };
    }
  }

  async function setTelemetryConsent(telemetry) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'highlighter:setConsent',
        telemetry: telemetry === true
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  globalThis.AMH_ACCESS_POLICY = Object.freeze({
    ORGANIZATION_EMAIL_DOMAIN,
    PRIVACY_CONSENT_KEY,
    PRIVACY_CONSENT_VERSION,
    isOrganizationEmail,
    requestAccessStatus,
    requestConsentStatus,
    setTelemetryConsent
  });
})();
