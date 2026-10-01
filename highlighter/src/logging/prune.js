import { getLoggingConfig } from "./config.js";
import { byteSize, utcNow } from "./sanitize.js";
import { NAVIGATION_EVENT_TYPES } from "./types.js";
import {
  loadAllChunks,
  recalculateQueueMeta,
  removeMatchingIds,
  withQueueWrite
} from "./storageQueue.js";

function ageCutoff(days, now) {
  return now.getTime() - days * 24 * 60 * 60 * 1_000;
}

function isOlderThan(event, cutoffMs) {
  const timestamp = Date.parse(event.timestamp);
  return Number.isFinite(timestamp) && timestamp < cutoffMs;
}

function sortOldest(events) {
  return [...events].sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
}

function collectRemovals(chunks, predicate, targetBytes) {
  const candidates = sortOldest(chunks.flatMap((entry) => entry.chunk.events.filter(predicate)));
  const removeIds = new Set();
  let estimatedBytes = chunks.reduce((total, entry) => total + byteSize(entry.chunk), 0);

  for (const event of candidates) {
    if (targetBytes && estimatedBytes <= targetBytes) break;
    removeIds.add(event.eventId);
    estimatedBytes -= byteSize(event);
  }

  return removeIds;
}

function estimateBytesAfterRemoval(chunks, removeIds) {
  return chunks.reduce((total, entry) => total + byteSize({
    ...entry.chunk,
    events: entry.chunk.events.filter((event) => !removeIds.has(event.eventId))
  }), 0);
}

const RETENTION_SETTING_BY_SEVERITY = Object.freeze([
  ["info", "normalRetentionDays"],
  ["warning", "warningRetentionDays"],
  ["error", "errorRetentionDays"]
]);

export async function pruneLogs(options = {}) {
  return await withQueueWrite(async () => {
    const config = await getLoggingConfig();
    const now = options.now || new Date();
    const targetBytes = options.targetBytes || config.softStorageLimitBytes;
    const chunks = await loadAllChunks();

    const removeIds = collectExpiredIds(chunks, config, now);
    addSizePressureRemovals(chunks, removeIds, { config, now, targetBytes });

    const removedCount = await removeMatchingIds(chunks, removeIds);
    const meta = await recalculateQueueMeta();
    return {
      removedCount,
      estimatedBytes: meta.estimatedBytes,
      prunedAt: utcNow()
    };
  });
}

// Events past their severity's retention period.
function collectExpiredIds(chunks, config, now) {
  const cutoffs = new Map(RETENTION_SETTING_BY_SEVERITY.map(([severity, setting]) => [severity, ageCutoff(config[setting], now)]));
  const removeIds = new Set();
  for (const entry of chunks) {
    for (const event of entry.chunk.events) {
      if (cutoffs.has(event.severity) && isOlderThan(event, cutoffs.get(event.severity))) removeIds.add(event.eventId);
    }
  }
  return removeIds;
}

// Escalating stages, oldest first within each: navigation info events, then
// warnings, then (at the emergency limit) everything but errors and older errors.
function addSizePressureRemovals(chunks, removeIds, { config, now, targetBytes }) {
  const remove = (predicate) => collectRemovals(chunks, predicate, targetBytes).forEach((id) => removeIds.add(id));
  // The first stage measures the size before expired events are removed (unchanged behavior).
  const totalBytes = chunks.reduce((total, entry) => total + byteSize(entry.chunk), 0);
  if (totalBytes >= config.pruneInfoAtBytes) {
    remove((event) => event.severity === "info" && NAVIGATION_EVENT_TYPES.includes(event.eventType));
  }
  if (estimateBytesAfterRemoval(chunks, removeIds) >= config.pruneWarningAtBytes) {
    remove((event) => event.severity === "warning");
  }
  if (estimateBytesAfterRemoval(chunks, removeIds) >= config.emergencyLimitBytes) {
    remove((event) => event.severity !== "error");
    const recentErrorCutoff = ageCutoff(Math.min(1, config.errorRetentionDays), now);
    remove((event) => event.severity === "error" && isOlderThan(event, recentErrorCutoff));
  }
}
