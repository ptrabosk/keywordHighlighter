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
    "src/highlight/core.js",
    "src/highlight/shortcutTelemetry.js",
    "content.js"
  ]);

  for (const scriptPath of scriptPaths) {
    assert.doesNotThrow(() => new vm.Script(readExtensionFile(scriptPath), { filename: scriptPath }), scriptPath);
  }
});

test("production manifest uses minimum Store permissions and no development hosts", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const serialized = JSON.stringify(manifest);

  assert.deepEqual(manifest.permissions, ["storage", "alarms", "identity"]);
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

test("popup and options pages prominently disclose shortcut telemetry", () => {
  for (const page of ["popup.html", "options.html"]) {
    const source = readExtensionFile(page);
    assert.match(source, /Shortcut activity/);
    assert.match(source, /Shift\+D, Shift\+N, Shift\+B, or Shift\+C/);
    assert.match(source, /message text/i);
  }
});

test("manifest JSON resources exist and are parseable", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const jsonResources = manifest.web_accessible_resources
    .flatMap((entry) => entry.resources || [])
    .filter((resource) => resource.endsWith(".json"));

  assert.ok(jsonResources.includes("data/rules/opt_out_deterministic_rules.json"));
  assert.ok(jsonResources.includes("data/rules/rule_hover_text.json"));

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
