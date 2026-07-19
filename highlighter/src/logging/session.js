import { getLoggingConfig } from "./config.js";
import { createUuid, utcNow } from "./sanitize.js";
import { STORAGE_KEYS } from "./types.js";
import { logEvent } from "./logger.js";
import { storageGet, storageRemove, storageSet } from "./storageQueue.js";

async function isAbandonedSession(activeSession, now = Date.now()) {
  if (!activeSession?.lastActivityAt) return false;
  if (activeSession.endedAt) return false;
  const config = await getLoggingConfig();
  return now - Date.parse(activeSession.lastActivityAt) > config.abandonedSessionMinutes * 60_000;
}

export async function getActiveSession() {
  try {
    const result = await storageGet(STORAGE_KEYS.activeSession);
    return result[STORAGE_KEYS.activeSession] || null;
  } catch {
    return null;
  }
}

export async function startSession(context = {}) {
  try {
    const previous = await getActiveSession();
    if (await isAbandonedSession(previous)) {
      await logEvent({
        sessionId: previous.sessionId,
        eventType: "session_abandoned",
        severity: "warning",
        result: "unknown",
        surface: previous.surface,
        pageHost: previous.pageHost,
        ruleSource: previous.ruleSource
      });
    }

    const now = utcNow();
    const activeSession = {
      sessionId: createUuid(),
      startedAt: now,
      lastActivityAt: now,
      surface: context.surface || null,
      pageHost: context.pageHost || null,
      ruleSource: context.ruleSource || null
    };
    await storageSet({ [STORAGE_KEYS.activeSession]: activeSession });
    await logEvent({
      sessionId: activeSession.sessionId,
      eventType: "session_started",
      severity: "info",
      result: "success",
      surface: activeSession.surface,
      pageHost: activeSession.pageHost,
      ruleSource: activeSession.ruleSource
    });
    return activeSession;
  } catch {
    return null;
  }
}

export async function updateSessionActivity(patch = {}) {
  try {
    const current = await getActiveSession();
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      lastActivityAt: utcNow()
    };
    await storageSet({ [STORAGE_KEYS.activeSession]: next });
    return next;
  } catch {
    return null;
  }
}

export async function endSession(result = "success") {
  try {
    const current = await getActiveSession();
    if (!current) return;

    await logEvent({
      sessionId: current.sessionId,
      eventType: "session_ended",
      severity: "info",
      result,
      surface: current.surface,
      pageHost: current.pageHost,
      ruleSource: current.ruleSource
    });
    await storageRemove(STORAGE_KEYS.activeSession);
  } catch {
    // Best effort only; popup shutdown writes are not guaranteed.
  }
}

export const sessionTestHooks = {
  isAbandonedSession
};
