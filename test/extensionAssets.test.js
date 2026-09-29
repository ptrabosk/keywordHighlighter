import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "../highlighter");

function readExtensionFile(relativePath) {
  return fs.readFileSync(path.join(extensionDir, relativePath), "utf8");
}

test("manifest content scripts parse as classic Chrome scripts", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const scriptPaths = manifest.content_scripts.flatMap((entry) => entry.js || []);

  assert.deepEqual(scriptPaths, [
    "settings.js",
    "src/shared/extensionUtils.js",
    "src/access/policy.js",
    "src/highlight/regexNormalization.js",
    "src/highlight/core.js",
    "src/highlight/shortcutTelemetry.js",
    "src/content/diagnostics.js",
    "content.js"
  ]);

  for (const scriptPath of scriptPaths) {
    assert.doesNotThrow(() => new vm.Script(readExtensionFile(scriptPath), { filename: scriptPath }), scriptPath);
  }
});

test("production manifest uses minimum Store permissions and no development hosts", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const serialized = JSON.stringify(manifest);

  assert.deepEqual(manifest.permissions, ["storage", "alarms", "identity.email"]);
  assert.equal(serialized.includes("localhost"), false);
  assert.equal(serialized.includes("127.0.0.1"), false);
  assert.equal(Object.hasOwn(manifest, "key"), false);
});

test("service worker dependency graph contains no unsupported dynamic imports", () => {
  const moduleSources = [
    "background.js",
    ...fs.readdirSync(path.join(extensionDir, "src/logging"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `src/logging/${name}`)
  ].map(readExtensionFile).join("\n");

  assert.doesNotMatch(moduleSources, /\bimport\s*\(/);
});

test("popup and options pages disclose telemetry and provide consent controls", () => {
  for (const page of ["popup.html", "options.html"]) {
    const source = readExtensionFile(page);
    assert.match(source, /Privacy and usage data/);
    assert.match(source, /allowTelemetry/);
    assert.match(source, /denyTelemetry/);
    assert.match(source, /github\.com\/ptrabosk\/keywordHighlighter\/blob\/main\/docs\/index\.html/);
    assert.match(source, /keywordForm/);
    assert.match(source, /keywordInput/);
    assert.match(source, /keywordText/);
  }
  const optionsSource = readExtensionFile("options.html");
  assert.doesNotMatch(optionsSource, /id="selector"|id="categories"|settings-ui\.js|Targeting|Display|Categories/);
  assert.doesNotMatch(readExtensionFile("popup.html"), /shortcut activity/i);
  assert.doesNotThrow(() => new vm.Script(readExtensionFile("privacy-ui.js"), { filename: "privacy-ui.js" }));
  assert.doesNotThrow(() => new vm.Script(readExtensionFile("custom-keywords-init.js"), { filename: "custom-keywords-init.js" }));
});

test("service worker gates telemetry on the explicit privacy choice", () => {
  const source = readExtensionFile("background.js");
  assert.match(source, /highlighter:getConsentStatus/);
  assert.match(source, /highlighter:setConsent/);
  assert.match(source, /if \(!consent\.telemetry/);
  assert.match(source, /clearLoggingData/);
});

test("manifest identifies the 1.0.6 release", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));

  assert.equal(manifest.version, "1.0.6");
});

test("manifest exposes the protected options page and narrow resource scope", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));

  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
  assert.deepEqual(manifest.web_accessible_resources[0].matches, [
    "https://ui.attentivemobile.com/concierge/*"
  ]);
  assert.equal(readExtensionFile("options.html").includes("src/access/policy.js"), true);
  assert.equal(readExtensionFile("popup.html").includes("src/access/policy.js"), true);
});

test("manifest JSON resources exist and are parseable", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const jsonResources = manifest.web_accessible_resources
    .flatMap((entry) => entry.resources || [])
    .filter((resource) => resource.endsWith(".json"));

  assert.deepEqual(jsonResources.sort(), [
    "data/rules/opt_out_rules.json",
    "data/rules/rule_hover_text.json"
  ]);
  assert.deepEqual(
    fs.readdirSync(path.join(extensionDir, "data/rules"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `data/rules/${name}`)
      .sort(),
    jsonResources
  );

  for (const resource of jsonResources) {
    const parsed = JSON.parse(readExtensionFile(resource));
    assert.equal(typeof parsed, "object", resource);
  }
});

test("conversation split phrase highlights render as continuous multi-part spans", () => {
  const cssSource = readExtensionFile("content.css");

  assert.match(cssSource, /\.amh-highlight--multipart/);
  assert.match(cssSource, /box-shadow:\s*none !important/);
  assert.match(cssSource, /\.amh-highlight--match-start/);
  assert.match(cssSource, /\.amh-highlight--match-end/);
});

test("message highlights preserve the box radius and are inset seven pixels on every edge", () => {
  const contentSource = readExtensionFile("content.js");
  const cssSource = readExtensionFile("content.css");

  assert.match(contentSource, /applyInsetHighlightStyle\(messageBlock, rule\)/);
  assert.doesNotMatch(cssSource, /\.amh-message-highlight\s*\{[^}]*border-radius/);
  assert.match(cssSource, /\.amh-message-highlight::before[\s\S]*inset:\s*7px/);
  assert.match(cssSource, /\.amh-message-highlight::before[\s\S]*border-radius:\s*inherit/);
  assert.match(cssSource, /background-color:\s*var\(--amh-highlight-background\)/);
  assert.match(cssSource, /box-shadow:\s*inset 0 0 0 1px var\(--amh-highlight-border\)/);
});

test("customer highlight count badge is URL-gated and uses logical rendered groups", () => {
  const contentSource = readExtensionFile("content.js");
  const cssSource = readExtensionFile("content.css");

  assert.match(contentSource, /hostname === 'ui\.attentivemobile\.com'/);
  assert.match(contentSource, /pathname\.startsWith\('\/concierge\/'\)/);
  assert.match(contentSource, /querySelectorAll\('h1'\)/);
  assert.match(contentSource, /map\(\(child\) => child\.textContent \|\| ''\)/);
  assert.match(contentSource, /classList\.contains\('amh-highlight-count'\)/);
  assert.match(contentSource, /countRenderedHighlightGroups\(document\)/);
  assert.match(contentSource, /querySelectorAll\('\.amh-message-highlight'\)/);
  assert.match(contentSource, /countVisibleHighlightsForBadge/);
  assert.match(contentSource, /amh-highlight-count/);
  assert.match(contentSource, /existingBadges\.forEach\(\(badge\) => badge\.remove\(\)\)/);
  assert.doesNotMatch(cssSource, /\.amh-customer-heading-row/);
  assert.match(cssSource, /\.amh-highlight-count[\s\S]*margin-left:\s*8px/);
  assert.match(cssSource, /\.amh-highlight-count[\s\S]*border-radius:\s*6px/);
});

test("mutation observer gates rerenders on message text changes", () => {
  const contentSource = readExtensionFile("content.js");

  assert.match(contentSource, /mutation\.type === 'characterData'/);
  assert.match(contentSource, /node\.nodeType === Node\.TEXT_NODE/);
  assert.match(contentSource, /node\.textContent\?\.trim\(\)/);
  assert.match(contentSource, /node\.closest\(extensionSelector\)/);
});
