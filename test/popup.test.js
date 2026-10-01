import test from "node:test";
import assert from "node:assert/strict";

import { createChromeStub, createDom, loadScripts, readExtensionFile, waitFor } from "./helpers/browser.js";

const SHARED_SCRIPTS = [
  "settings.js",
  "src/shared/extensionUtils.js",
  "src/shared/keywordCsv.js",
  "src/highlight/regexNormalization.js",
  "src/highlight/core.js",
  "popup.js"
];

async function openPage({ page = "popup", sync = {}, quotaBytesPerItem } = {}) {
  const stub = createChromeStub({ sync, quotaBytesPerItem });
  const body = readExtensionFile(`${page}.html`).match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = createDom(body, { chrome: stub.chrome, url: "chrome-extension://test/popup.html" });
  const { window } = dom;
  const downloads = [];
  window.URL.createObjectURL = (blob) => {
    downloads.push(blob);
    return "blob:test";
  };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {};
  loadScripts(dom, [...SHARED_SCRIPTS, page === "popup" ? "custom-keywords-init.js" : "options.js"]);
  const document = window.document;
  await waitFor(() => document.querySelector("#keywords").childElementCount > 0);
  const status = () => document.querySelector("#status").textContent;
  const keywords = () => Array.from(document.querySelectorAll(".keyword span"), (node) => node.textContent);
  async function submit(value) {
    document.querySelector("#keywordInput").value = value;
    const before = status();
    document.querySelector("#keywordForm").dispatchEvent(new window.Event("submit", { cancelable: true }));
    await waitFor(() => status() !== before || status());
    await new Promise((resolve) => setTimeout(resolve, 0));
    return status();
  }
  return { stub, window, document, status, keywords, submit, downloads };
}

const saved = (stub) => stub.stores.sync.amhSettings;

test("adds, validates, edits, and removes keywords", async () => {
  const page = await openPage();
  assert.equal(page.document.querySelector(".empty").textContent, "No custom keywords yet.");

  assert.equal(await page.submit("   "), "Enter a keyword first.");
  assert.equal(await page.submit("ab"), "Keywords need at least 3 characters.");
  assert.equal(await page.submit("launch"), "Keyword added.");
  assert.equal(await page.submit("LAUNCH"), "That keyword is already in the list.");
  assert.deepEqual(saved(page.stub).customKeywords, ["launch"]);
  assert.equal(Object.hasOwn(saved(page.stub), "customKeywordTextByPattern"), false);

  const [edit, remove] = page.document.querySelectorAll(".keyword button");
  edit.click();
  assert.equal(page.document.querySelector("#addKeyword").textContent, "SAVE KEYWORD");
  assert.equal(await page.submit("launch code"), "Keyword updated.");
  assert.deepEqual(page.keywords(), ["launch code"]);

  page.document.querySelector(".keyword button").click();
  page.document.querySelectorAll(".keyword button")[1].click();
  await waitFor(() => page.status() === "Keyword removed.");
  assert.deepEqual(saved(page.stub).customKeywords, []);
  assert.equal(page.document.querySelector("#addKeyword").textContent, "ADD KEYWORD");
  assert.ok(remove);
});

test("enforces the keyword cap and the sync storage limit", async () => {
  const full = Array.from({ length: 40 }, (_value, index) => `keyword${String(index).padStart(2, "0")}`);
  const capped = await openPage({ sync: { amhSettings: { customKeywords: full } } });
  assert.equal(await capped.submit("one more"), "You can save up to 40 keywords. Remove one first.");

  const tight = await openPage({ quotaBytesPerItem: 600 });
  assert.match(await tight.submit("x".repeat(128)), /Not enough sync storage/);
});

test("exports a keyword CSV and imports old and new backups", async () => {
  const page = await openPage({ page: "options", sync: { amhSettings: { customKeywords: ["launch"] } } });
  page.document.querySelector("#exportKeywords").click();
  assert.equal(page.status(), "Keyword backup exported.");
  assert.equal(await page.downloads[0].text(), "keyword\r\nlaunch\r\n");

  async function importCsv(text) {
    const input = page.document.querySelector("#importFile");
    Object.defineProperty(input, "files", { configurable: true, value: [new page.window.File([text], "backup.csv")] });
    const before = page.status();
    input.dispatchEvent(new page.window.Event("change"));
    await waitFor(() => page.status() !== before && page.status() !== "Saved. Refresh the page if highlights do not update immediately.");
    return page.status();
  }

  assert.equal(await importCsv("keyword,hover text\nSTOP,old guidance\nab,too short\nstop,duplicate\n"), "Imported 1 keyword. Skipped 1: keywords need 3+ characters and the list holds up to 40.");
  assert.deepEqual(saved(page.stub).customKeywords, ["STOP"]);
  assert.equal(await importCsv("keyword\nalpha\nbeta\n"), "Imported 2 keywords.");
  assert.equal(await importCsv("not,a,backup\n"), "Import failed. Choose a CSV file whose first row is the keyword header.");

  const input = page.document.querySelector("#importFile");
  Object.defineProperty(input, "files", { configurable: true, value: [] });
  input.dispatchEvent(new page.window.Event("change"));
  page.document.querySelector("#importKeywords").click();
});

test("rejects an import that exceeds the sync storage limit", async () => {
  const page = await openPage({ quotaBytesPerItem: 600 });
  const input = page.document.querySelector("#importFile");
  const rows = Array.from({ length: 20 }, (_value, index) => `keyword-${index}-${"x".repeat(40)}`).join("\n");
  Object.defineProperty(input, "files", { value: [new page.window.File([`keyword\n${rows}\n`], "big.csv")] });
  input.dispatchEvent(new page.window.Event("change"));
  await waitFor(() => /too large/.test(page.status()));
});

test("a failed save restores the previous list and tells the user", async () => {
  const page = await openPage({ sync: { amhSettings: { customKeywords: ["launch"] } } });
  page.stub.chrome.storage.sync.set = async () => { throw new Error("quota"); };

  assert.equal(await page.submit("vip code"), "Keywords could not be saved. Try again.");
  assert.deepEqual(page.keywords(), ["launch"]);
  assert.equal(page.document.querySelector("#keywordInput").value, "vip code", "typed keyword is kept for retry");

  page.document.querySelectorAll(".keyword button")[1].click();
  await waitFor(() => page.status() === "Keywords could not be saved. Try again." && page.keywords().length === 1);
  assert.ok(page.stub.sent.some((message) => message.event?.eventType === "settings_save_failed"));
});
