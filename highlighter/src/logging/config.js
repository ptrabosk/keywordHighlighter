export const LOGGING_CONFIG = {
  enabled: true,
  endpointUrl: "REPLACE_WITH_APPS_SCRIPT_EXEC_URL",
  apiKey: "REPLACE_WITH_LOCAL_API_KEY",

  uploadIntervalMinutes: 15,
  maxBatchEvents: 200,
  maxBatchBytes: 500_000,

  softStorageLimitBytes: 5_000_000,
  pruneInfoAtBytes: 7_000_000,
  pruneWarningAtBytes: 8_000_000,
  emergencyLimitBytes: 9_000_000,

  normalRetentionDays: 7,
  warningRetentionDays: 14,
  errorRetentionDays: 30,

  abandonedSessionMinutes: 30,
  diagnosticsEnabled: false
};

let configPromise = null;

export async function getLoggingConfig(options = {}) {
  if (options.refresh) configPromise = null;
  if (!configPromise) {
    configPromise = loadLoggingConfig();
  }
  return await configPromise;
}

async function loadLoggingConfig() {
  try {
    if (globalThis.process?.env?.NODE_ENV === "test") return LOGGING_CONFIG;
    const local = await import("./config.local.js");
    if (local?.LOGGING_CONFIG && typeof local.LOGGING_CONFIG === "object") {
      Object.assign(LOGGING_CONFIG, local.LOGGING_CONFIG);
    }
  } catch {
    // Local overrides are optional and intentionally ignored by version control.
  }
  return LOGGING_CONFIG;
}
