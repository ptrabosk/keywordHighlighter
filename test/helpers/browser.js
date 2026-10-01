// Shared harness for running the extension's browser-only scripts under jsdom
// with an in-memory Chrome API.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../highlighter");

export function readExtensionFile(relativePath) {
  return fs.readFileSync(path.join(extensionDir, relativePath), "utf8");
}

export function createChromeStub({ sync = {}, quotaBytesPerItem = 8192 } = {}) {
  const listeners = { message: [], storage: [], installed: [], alarm: [], suspend: [] };
  const sent = [];
  const stores = { sync: { ...sync }, local: {} };
  const area = (name, extra = {}) => ({
    ...extra,
    async get(keys) {
      const store = stores[name];
      if (keys === null || keys === undefined) return { ...store };
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.map((key) => [key, store[key] ?? (typeof keys === "object" && !Array.isArray(keys) ? keys[key] : undefined)]));
    },
    async set(items) {
      const copy = JSON.parse(JSON.stringify(items));
      Object.assign(stores[name], copy);
      const changes = Object.fromEntries(Object.entries(copy).map(([key, newValue]) => [key, { newValue }]));
      for (const listener of listeners.storage) listener(changes, name);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete stores[name][key];
    }
  });
  const chrome = {
    runtime: {
      getURL: (resource) => `chrome-extension://test/${resource}`,
      getManifest: () => ({ version: "9.9.9" }),
      sendMessage: async (message) => {
        sent.push(message);
        return { ok: true };
      },
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
      onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
      onSuspend: { addListener: (listener) => listeners.suspend.push(listener) }
    },
    alarms: {
      create: async () => {},
      onAlarm: { addListener: (listener) => listeners.alarm.push(listener) }
    },
    storage: {
      sync: area("sync", { QUOTA_BYTES_PER_ITEM: quotaBytesPerItem }),
      local: area("local"),
      onChanged: { addListener: (listener) => listeners.storage.push(listener) }
    }
  };
  return { chrome, sent, stores, listeners };
}

// Sends a runtime message to every registered listener and resolves with the
// first response.
export function dispatchRuntimeMessage(stub, message) {
  return new Promise((resolve) => {
    let answered = false;
    const sendResponse = (response) => {
      if (!answered) {
        answered = true;
        resolve(response);
      }
    };
    const keepsChannelOpen = stub.listeners.message.map((listener) => listener(message, {}, sendResponse)).some(Boolean);
    if (!keepsChannelOpen) setTimeout(() => sendResponse(undefined), 0);
  });
}

export function createDom(html, { url = "https://ui.attentivemobile.com/concierge/conversation/123", chrome } = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.chrome = chrome;
  // Browser globals jsdom does not provide.
  window.structuredClone ??= globalThis.structuredClone;
  window.TextEncoder ??= globalThis.TextEncoder;
  window.Blob.prototype.text ??= function text() {
    return new Promise((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
  // jsdom has no layout; report one box so rendered-highlight checks pass.
  window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }];
  };
  window.console.warn = () => {};
  window.console.error = () => {};
  return dom;
}

// Runs classic extension scripts in the page, keeping their file URL so
// coverage is attributed to the source files.
export function loadScripts(dom, relativePaths) {
  const context = dom.getInternalVMContext();
  for (const relativePath of relativePaths) {
    const absolute = path.join(extensionDir, relativePath);
    vm.runInContext(fs.readFileSync(absolute, "utf8"), context, { filename: pathToFileURL(absolute).href });
  }
}

export async function waitFor(check, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
