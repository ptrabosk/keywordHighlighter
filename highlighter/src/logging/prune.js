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

export async function pruneLogs(options = {}) {
  return await withQueueWrite(async () => {
    const config = await getLoggingConfig();
    const now = options.now || new Date();
    const targetBytes = options.targetBytes || config.softStorageLimitBytes;
    const chunks = await loadAllChunks();
    let removeIds = new Set();

    const infoCutoff = ageCutoff(config.normalRetentionDays, now);
    const warningCutoff = ageCutoff(config.warningRetentionDays, now);
    const errorCutoff = ageCutoff(config.errorRetentionDays, now);

    for (const entry of chunks) {
      for (const event of entry.chunk.events) {
        if (event.severity === "info" && isOlderThan(event, infoCutoff)) removeIds.add(event.eventId);
        if (event.severity === "warning" && isOlderThan(event, warningCutoff)) removeIds.add(event.eventId);
        if (event.severity === "error" && isOlderThan(event, errorCutoff)) removeIds.add(event.eventId);
      }
    }

    let estimatedBytes = chunks.reduce((total, entry) => total + byteSize(entry.chunk), 0);
    if (estimatedBytes >= config.pruneInfoAtBytes) {
      collectRemovals(chunks, (event) => event.severity === "info" && NAVIGATION_EVENT_TYPES.includes(event.eventType), targetBytes)
        .forEach((id) => removeIds.add(id));
    }

    estimatedBytes = chunks.reduce((total, entry) => total + byteSize({
      ...entry.chunk,
      events: entry.chunk.events.filter((event) => !removeIds.has(event.eventId))
    }), 0);

    if (estimatedBytes >= config.pruneWarningAtBytes) {
      collectRemovals(chunks, (event) => event.severity === "warning", targetBytes)
        .forEach((id) => removeIds.add(id));
    }

    estimatedBytes = chunks.reduce((total, entry) => total + byteSize({
      ...entry.chunk,
      events: entry.chunk.events.filter((event) => !removeIds.has(event.eventId))
    }), 0);

    if (estimatedBytes >= config.emergencyLimitBytes) {
      collectRemovals(chunks, (event) => event.severity !== "error", targetBytes)
        .forEach((id) => removeIds.add(id));
      const recentErrorCutoff = ageCutoff(Math.min(1, config.errorRetentionDays), now);
      collectRemovals(chunks, (event) => event.severity === "error" && isOlderThan(event, recentErrorCutoff), targetBytes)
        .forEach((id) => removeIds.add(id));
    }

    const removedCount = await removeMatchingIds(chunks, removeIds);
    const meta = await recalculateQueueMeta();
    return {
      removedCount,
      estimatedBytes: meta.estimatedBytes,
      prunedAt: utcNow()
    };
  });
}
