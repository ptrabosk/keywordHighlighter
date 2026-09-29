import "./settings.js";
import "./src/access/policy.js";
import { getLoggingConfig } from "./src/logging/config.js";
import { logEvent, logFailure } from "./src/logging/logger.js";
import { pruneLogs } from "./src/logging/prune.js";
import { startSession, endSession } from "./src/logging/session.js";
import { clearLoggingData, enqueueEvent, getQueueStats, restoreUploadingEvents } from "./src/logging/storageQueue.js";
import { ERROR_CODES } from "./src/logging/types.js";
import { shouldUploadOnStartup, uploadPendingLogs } from "./src/logging/uploader.js";

const UPLOAD_ALARM_NAME = "keywordHighlighterLogUpload";
const ACCESS_CACHE_TTL_MS = 60 * 1000;
let accessCache = null;
let loggingInitialized = false;

async function getConsentStatus() {
  const key = globalThis.AMH_ACCESS_POLICY.PRIVACY_CONSENT_KEY;
  const result = await chrome.storage.local.get(key);
  const consent = result[key];
  const valid = consent?.version === globalThis.AMH_ACCESS_POLICY.PRIVACY_CONSENT_VERSION &&
    typeof consent.telemetry === "boolean";
  return {
    decided: valid,
    telemetry: valid && consent.telemetry === true,
    version: globalThis.AMH_ACCESS_POLICY.PRIVACY_CONSENT_VERSION
  };
}

async function setConsent(telemetry) {
  const key = globalThis.AMH_ACCESS_POLICY.PRIVACY_CONSENT_KEY;
  const value = {
    version: globalThis.AMH_ACCESS_POLICY.PRIVACY_CONSENT_VERSION,
    telemetry: telemetry === true,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [key]: value });
  if (!value.telemetry) {
    loggingInitialized = false;
    await clearLoggingData();
  }
  return value;
}

async function getAccessStatus() {
  if (accessCache && accessCache.expiresAt > Date.now()) return accessCache.value;

  let email = "";
  let reason = "access_denied";
  try {
    const profile = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    email = String(profile?.email || "").trim();
    reason = email ? "organization_check_failed" : "organization_profile_missing";
  } catch {
    reason = "identity_unavailable";
  }

  const allowed = Boolean(globalThis.AMH_ACCESS_POLICY?.isOrganizationEmail(email));
  const value = { allowed, reason: allowed ? "allowed" : reason };
  accessCache = { value, expiresAt: Date.now() + ACCESS_CACHE_TTL_MS };
  return value;
}

async function isOrganizationUser() {
  return (await getAccessStatus()).allowed;
}

function summarizeLoggingConfig(config) {
  const endpointUrl = config.endpointUrl || "";
  const apiKey = config.apiKey || "";
  let endpointHost = "";
  try {
    endpointHost = endpointUrl ? new URL(endpointUrl).hostname : "";
  } catch {
    endpointHost = "";
  }
  const configured = Boolean(
    config.enabled &&
    endpointUrl &&
    apiKey &&
    !endpointUrl.includes("REPLACE_WITH_") &&
    !endpointUrl.includes("YOUR_DEPLOYMENT_ID") &&
    !apiKey.includes("REPLACE_WITH_") &&
    !apiKey.includes("replace-with-")
  );
  return {
    enabled: config.enabled !== false,
    configured,
    endpointHost,
    uploadIntervalMinutes: config.uploadIntervalMinutes,
    maxBatchEvents: config.maxBatchEvents,
    maxBatchBytes: config.maxBatchBytes
  };
}

async function getDiagnostics() {
  const [config, queueStats, uploadStatus, statsResult] = await Promise.all([
    getLoggingConfig(),
    getQueueStats(),
    getUploadStatus(),
    chrome.storage.local.get("amhLastStats")
  ]);
  return {
    loggingConfig: summarizeLoggingConfig(config),
    queueStats,
    uploadStatus,
    lastStats: statsResult.amhLastStats || null
  };
}

async function ensureDefaultSettings() {
  if (!(await isOrganizationUser())) return;
  try {
    const existing = await chrome.storage.sync.get(globalThis.SETTINGS_KEY);
    if (!existing[globalThis.SETTINGS_KEY]) {
      await chrome.storage.sync.set({ [globalThis.SETTINGS_KEY]: globalThis.DEFAULT_SETTINGS });
    }
  } catch (error) {
    if (await isOrganizationUser()) {
      await logFailure(
        "settings_save_failed",
        ERROR_CODES.SETTINGS_SAVE_FAILED,
        "Default settings could not be initialized",
        { operation: "initializeDefaults" }
      );
    }
  }
}

async function ensureUploadAlarm() {
  if (!globalThis.chrome?.alarms) return;
  const config = await getLoggingConfig();
  await chrome.alarms.create(UPLOAD_ALARM_NAME, {
    periodInMinutes: config.uploadIntervalMinutes,
    delayInMinutes: config.uploadIntervalMinutes
  });
}

async function runUpload(reason) {
  const consent = await getConsentStatus();
  if (!consent.telemetry) return;
  if (!(await isOrganizationUser())) return;
  try {
    await restoreUploadingEvents();
    const config = await getLoggingConfig();
    const stats = await getQueueStats();
    if (stats.estimatedBytes >= config.pruneInfoAtBytes) {
      const result = await pruneLogs();
      void result;
    }
    await uploadPendingLogs(reason);
  } catch {
    // Logging must never affect extension behavior.
  }
}

async function initializeLoggingServiceWorker() {
  const consent = await getConsentStatus();
  if (!consent.telemetry || loggingInitialized || !(await isOrganizationUser())) return false;
  await getLoggingConfig();
  await ensureUploadAlarm();
  await restoreUploadingEvents();
  await startSession({ surface: "background" });
  loggingInitialized = true;
  if (await shouldUploadOnStartup()) {
    await runUpload("startup");
  }
  return true;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultSettings();
});

globalThis.chrome?.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === UPLOAD_ALARM_NAME) {
    runUpload("alarm");
  }
});

globalThis.chrome?.runtime?.onSuspend?.addListener(() => {
  void endSession("success");
});

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type === "highlighter:getConsentStatus") {
    void getConsentStatus().then((status) => sendResponse?.(status)).catch(() => {
      sendResponse?.({ decided: false, telemetry: false, version: globalThis.AMH_ACCESS_POLICY.PRIVACY_CONSENT_VERSION });
    });
    return true;
  }

  if (message?.type === "highlighter:setConsent") {
    void setConsent(message.telemetry === true).then(() => {
      if (message.telemetry === true) void initializeLoggingServiceWorker();
      sendResponse?.({ ok: true });
    }).catch(() => sendResponse?.({ ok: false }));
    return true;
  }

  if (message?.type === "highlighter:getAccessStatus") {
    void (async () => {
      const status = await getAccessStatus();
      if (status.allowed) {
        void ensureDefaultSettings();
        void initializeLoggingServiceWorker();
      }
      sendResponse?.(status);
    })();
    return true;
  }

  if (message?.type === "logging:event") {
    void (async () => {
      try {
        if (!(await initializeLoggingServiceWorker())) {
          sendResponse?.({ ok: false, reason: "access_denied" });
          return;
        }
        const event = { ...(message.event || {}) };
        await enqueueEvent(event);
        const stats = await getQueueStats();
        const config = await getLoggingConfig();
        if (stats.pendingCount >= 100 || stats.estimatedBytes >= config.maxBatchBytes || message.event?.severity === "error") {
          await runUpload(message.event?.severity === "error" ? "serious_error" : "threshold");
        }
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "logging:uploadRequested") {
    runUpload(message.reason || "requested");
    sendResponse?.({ ok: true });
    return false;
  }

  if (message?.type === "highlighter:getDiagnostics") {
    void (async () => {
      try {
        if (!(await initializeLoggingServiceWorker())) {
          sendResponse?.({ ok: false, reason: "access_denied" });
          return;
        }
        sendResponse?.({ ok: true, diagnostics: await getDiagnostics() });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "highlighter:runDiagnosticsUpload") {
    void (async () => {
      try {
        if (!(await initializeLoggingServiceWorker())) {
          sendResponse?.({ ok: false, reason: "access_denied" });
          return;
        }
        await runUpload("diagnostics");
        sendResponse?.({ ok: true, diagnostics: await getDiagnostics() });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "highlighter:logEvent") {
    void (async () => {
      try {
        if (!(await initializeLoggingServiceWorker())) {
          sendResponse?.({ ok: false, reason: "access_denied" });
          return;
        }
        const event = { ...(message.event || {}) };
        await logEvent(event);
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "highlighter:logFailure") {
    void (async () => {
      try {
        if (!(await initializeLoggingServiceWorker())) {
          sendResponse?.({ ok: false, reason: "access_denied" });
          return;
        }
        await logFailure(
          message.eventType,
          message.errorCode,
          message.errorMessage,
          message.metadata || {}
        );
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  return false;
});

void ensureDefaultSettings();
void initializeLoggingServiceWorker();
