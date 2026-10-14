export const LOGGING_CONFIG = {
  enabled: true,
  // Offsight Operations collector (PostgreSQL). It takes no secret: it checks the extension origin and rate-limits instead.
  endpointUrl: "https://opsportal.online/keyword-highlighter/logs",

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

// Logging is on only with an https endpoint that is not a leftover placeholder.
export function isLoggingConfigured(config) {
  const endpointUrl = config.endpointUrl || "";
  return Boolean(
    config.enabled &&
    /^https:\/\//.test(endpointUrl) &&
    !endpointUrl.includes("REPLACE_WITH_") &&
    !endpointUrl.includes("YOUR_DEPLOYMENT_ID")
  );
}
