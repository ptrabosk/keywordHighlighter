import { getLoggingConfig } from "./config.js";
import { byteSize, utcNow } from "./sanitize.js";
import {
  CHUNK_PREFIX,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_EVENTS,
  SCHEMA_VERSION,
  STORAGE_KEYS
} from "./types.js";

let writeChain = Promise.resolve();

export function chunkKey(chunkNumber) {
  return `${CHUNK_PREFIX}${String(chunkNumber).padStart(6, "0")}`;
}

export function parseChunkNumber(key) {
  if (!key.startsWith(CHUNK_PREFIX)) return null;
  const value = Number(key.slice(CHUNK_PREFIX.length));
  return Number.isInteger(value) ? value : null;
}

export function defaultQueueMeta() {
  return {
    schemaVersion: SCHEMA_VERSION,
    nextChunkNumber: 1,
    estimatedBytes: 0
  };
}

export async function storageGet(keys) {
  const area = globalThis.chrome?.storage?.local;
  if (!area?.get) return {};
  return await area.get(keys);
}

export async function storageSet(items) {
  const area = globalThis.chrome?.storage?.local;
  if (!area?.set) return;
  await area.set(items);
}

export async function storageRemove(keys) {
  const area = globalThis.chrome?.storage?.local;
  if (!area?.remove) return;
  await area.remove(keys);
}

export function withQueueWrite(operation) {
  const run = writeChain.then(operation, operation);
  writeChain = run.catch(() => {});
  return run;
}

export async function getQueueMeta() {
  const result = await storageGet(STORAGE_KEYS.queueMeta);
  return {
    ...defaultQueueMeta(),
    ...(result[STORAGE_KEYS.queueMeta] || {})
  };
}

export async function setQueueMeta(meta) {
  await storageSet({ [STORAGE_KEYS.queueMeta]: meta });
}

export async function loadAllChunks() {
  const result = await storageGet(null);
  return Object.entries(result)
    .filter(([key]) => key.startsWith(CHUNK_PREFIX))
    .map(([key, chunk]) => ({
      key,
      chunkNumber: parseChunkNumber(key),
      chunk: normalizeChunk(chunk, parseChunkNumber(key))
    }))
    .filter((entry) => Number.isInteger(entry.chunkNumber))
    .sort((a, b) => a.chunkNumber - b.chunkNumber);
}

export function normalizeChunk(chunk, chunkNumber) {
  return {
    schemaVersion: SCHEMA_VERSION,
    chunkNumber,
    closed: Boolean(chunk?.closed),
    events: Array.isArray(chunk?.events) ? chunk.events : []
  };
}

export function estimateChunksBytes(chunks) {
  return chunks.reduce((total, entry) => total + byteSize(entry.chunk), 0);
}

export function oldestTimestamp(chunks) {
  const timestamps = chunks.flatMap((entry) => entry.chunk.events.map((event) => event.timestamp).filter(Boolean));
  return timestamps.length ? timestamps.sort()[0] : undefined;
}

export async function recalculateQueueMeta(chunks = null) {
  const loadedChunks = chunks || await loadAllChunks();
  const meta = await getQueueMeta();
  const maxChunkNumber = loadedChunks.reduce((max, entry) => Math.max(max, entry.chunkNumber), 0);
  const nextChunkNumber = Math.max(meta.nextChunkNumber || 1, maxChunkNumber || 1);
  const estimatedBytes = estimateChunksBytes(loadedChunks);
  const nextMeta = {
    ...meta,
    nextChunkNumber,
    estimatedBytes,
    oldestTimestamp: oldestTimestamp(loadedChunks)
  };
  if (!nextMeta.oldestTimestamp) delete nextMeta.oldestTimestamp;
  await setQueueMeta(nextMeta);
  return nextMeta;
}

export async function enqueueEvent(event) {
  if (!event) return false;

  return await withQueueWrite(async () => {
    const chunks = await loadAllChunks();
    let meta = await getQueueMeta();
    let target = chunks.find((entry) => entry.chunkNumber === meta.nextChunkNumber && !entry.chunk.closed);

    if (!target) {
      target = {
        key: chunkKey(meta.nextChunkNumber),
        chunkNumber: meta.nextChunkNumber,
        chunk: normalizeChunk(null, meta.nextChunkNumber)
      };
      chunks.push(target);
    }

    const eventBytes = byteSize(event);
    const currentBytes = byteSize(target.chunk);
    if (target.chunk.events.length >= MAX_CHUNK_EVENTS || currentBytes + eventBytes > MAX_CHUNK_BYTES) {
      target.chunk.closed = true;
      await storageSet({ [target.key]: target.chunk });
      meta = { ...meta, nextChunkNumber: meta.nextChunkNumber + 1 };
      target = {
        key: chunkKey(meta.nextChunkNumber),
        chunkNumber: meta.nextChunkNumber,
        chunk: normalizeChunk(null, meta.nextChunkNumber)
      };
      chunks.push(target);
    }

    target.chunk.events.push(event);
    const updatedChunks = chunks
      .filter((entry, index, array) => array.findIndex((item) => item.key === entry.key) === index)
      .sort((a, b) => a.chunkNumber - b.chunkNumber);

    meta = {
      ...meta,
      estimatedBytes: estimateChunksBytes(updatedChunks),
      oldestTimestamp: oldestTimestamp(updatedChunks)
    };
    await storageSet({ [target.key]: target.chunk, [STORAGE_KEYS.queueMeta]: meta });

    const config = await getLoggingConfig();
    if (meta.estimatedBytes >= config.softStorageLimitBytes) {
      globalThis.chrome?.runtime
        ?.sendMessage?.({ type: "logging:uploadRequested", reason: "storage_pressure" })
        ?.catch?.(() => {});
    }

    return true;
  });
}

export async function getQueueStats() {
  const chunks = await loadAllChunks();
  const events = chunks.flatMap((entry) => entry.chunk.events);
  const pendingEvents = events.filter((event) => event.uploadState === "pending");
  return {
    chunkCount: chunks.length,
    eventCount: events.length,
    pendingCount: pendingEvents.length,
    uploadingCount: events.length - pendingEvents.length,
    estimatedBytes: estimateChunksBytes(chunks),
    oldestTimestamp: oldestTimestamp(chunks)
  };
}

export async function selectUploadBatch(batchId, options = {}) {
  const config = await getLoggingConfig();
  const maxEvents = options.maxEvents || config.maxBatchEvents;
  const maxBytes = options.maxBytes || config.maxBatchBytes;

  return await withQueueWrite(async () => {
    const chunks = await loadAllChunks();
    const selected = [];
    const updates = {};

    for (const entry of chunks) {
      let changed = false;
      entry.chunk.events = entry.chunk.events.map((event) => {
        if (selected.length >= maxEvents || event.uploadState !== "pending") return event;

        const nextEvent = {
          ...event,
          uploadState: "uploading",
          uploadAttempts: (Number(event.uploadAttempts) || 0) + 1,
          batchId
        };

        const nextBytes = byteSize({ events: [...selected, nextEvent] });
        if (nextBytes > maxBytes && selected.length > 0) return event;

        selected.push(nextEvent);
        changed = true;
        return nextEvent;
      });

      if (changed) updates[entry.key] = entry.chunk;
      if (selected.length >= maxEvents) break;
    }

    if (Object.keys(updates).length) {
      await storageSet(updates);
      await recalculateQueueMeta(chunks);
    }

    return selected;
  });
}

export async function removeEventsById(eventIds = []) {
  const ids = new Set(eventIds);
  if (!ids.size) return 0;

  return await withQueueWrite(async () => {
    const chunks = await loadAllChunks();
    const updates = {};
    const removals = [];
    let removed = 0;

    for (const entry of chunks) {
      const remaining = entry.chunk.events.filter((event) => {
        const remove = ids.has(event.eventId);
        if (remove) removed += 1;
        return !remove;
      });

      if (remaining.length !== entry.chunk.events.length) {
        entry.chunk.events = remaining;
        if (remaining.length) updates[entry.key] = entry.chunk;
        else removals.push(entry.key);
      }
    }

    if (Object.keys(updates).length) await storageSet(updates);
    if (removals.length) await storageRemove(removals);
    await recalculateQueueMeta();
    return removed;
  });
}

export async function restoreBatch(batchId) {
  return await withQueueWrite(async () => {
    const chunks = await loadAllChunks();
    const updates = {};
    let restored = 0;

    for (const entry of chunks) {
      let changed = false;
      entry.chunk.events = entry.chunk.events.map((event) => {
        if (event.batchId !== batchId) return event;
        const next = { ...event, uploadState: "pending" };
        delete next.batchId;
        restored += 1;
        changed = true;
        return next;
      });
      if (changed) updates[entry.key] = entry.chunk;
    }

    if (Object.keys(updates).length) await storageSet(updates);
    return restored;
  });
}

export async function restoreUploadingEvents() {
  return await withQueueWrite(async () => {
    const chunks = await loadAllChunks();
    const updates = {};
    let restored = 0;

    for (const entry of chunks) {
      let changed = false;
      entry.chunk.events = entry.chunk.events.map((event) => {
        if (event.uploadState !== "uploading") return event;
        const next = { ...event, uploadState: "pending" };
        delete next.batchId;
        restored += 1;
        changed = true;
        return next;
      });
      if (changed) updates[entry.key] = entry.chunk;
    }

    if (Object.keys(updates).length) await storageSet(updates);
    return restored;
  });
}

export async function updateUploadStatus(patch) {
  const result = await storageGet(STORAGE_KEYS.uploadStatus);
  const current = result[STORAGE_KEYS.uploadStatus] || { consecutiveFailures: 0 };
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  await storageSet({ [STORAGE_KEYS.uploadStatus]: next });
  return next;
}

export async function getUploadStatus() {
  const result = await storageGet(STORAGE_KEYS.uploadStatus);
  return {
    consecutiveFailures: 0,
    ...(result[STORAGE_KEYS.uploadStatus] || {})
  };
}

export async function markUploadSuccess() {
  const now = utcNow();
  const meta = await getQueueMeta();
  await setQueueMeta({
    ...meta,
    lastUploadAt: now,
    lastSuccessfulUploadAt: now
  });
  return await updateUploadStatus({
    consecutiveFailures: 0,
    nextRetryAt: undefined,
    lastErrorCode: undefined,
    blockedUntilConfigurationChange: undefined,
    permanentErrorCode: undefined,
    configFingerprint: undefined,
    lastSuccessfulUploadAt: now
  });
}
