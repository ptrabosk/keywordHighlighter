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

export async function getLoggingConfig(_options = {}) {
  return LOGGING_CONFIG;
}
