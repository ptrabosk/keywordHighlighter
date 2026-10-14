import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(__dirname, "..");

test("Store packager creates a production-only ZIP that logs to the Offsight collector", { skip: process.platform !== "win32" }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-highlighter-package-"));
  const extractDirectory = path.join(outputDirectory, "extracted");
  const environment = { ...process.env };
  delete environment.KEYWORD_HIGHLIGHTER_ENDPOINT_URL;

  try {
    const packageArguments = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(repositoryRoot, "scripts/package-extension.ps1"),
      "-Mode", "Store",
      "-OutputDirectory", outputDirectory
    ];
    const output = execFileSync("powershell", packageArguments, {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8"
    }).trim();
    const zipPath = output.split(/\r?\n/).at(-1);
    assert.equal(fs.existsSync(zipPath), true);
    const firstZip = fs.readFileSync(zipPath);
    execFileSync("powershell", packageArguments, { cwd: repositoryRoot, env: environment });
    assert.deepEqual(fs.readFileSync(zipPath), firstZip);

    fs.mkdirSync(extractDirectory);
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TEST_ZIP, $env:TEST_EXTRACT)"
    ], { env: { ...process.env, TEST_ZIP: zipPath, TEST_EXTRACT: extractDirectory } });

    const manifest = JSON.parse(fs.readFileSync(path.join(extractDirectory, "manifest.json"), "utf8"));
    const manifestText = JSON.stringify(manifest);
    const configText = fs.readFileSync(path.join(extractDirectory, "src/logging/config.js"), "utf8");

    assert.deepEqual(manifest.permissions, ["storage", "alarms"]);
    assert.equal(manifest.version, "1.2.0");
    assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
    assert.doesNotMatch(manifestText, /localhost|127\.0\.0\.1|"tabs"/);
    assert.match(configText, /endpointUrl: "https:\/\/opsportal\.online\/keyword-highlighter\/logs"/);
    assert.doesNotMatch(configText, /apiKey|script\.google\.com|REPLACE_WITH_|YOUR_DEPLOYMENT_ID|replace-with-|import\s*\(/);
    assert.deepEqual(manifest.host_permissions, ["https://ui.attentivemobile.com/concierge/*", "https://opsportal.online/keyword-highlighter/*"]);
    assert.equal(fs.existsSync(path.join(extractDirectory, "src/logging/config.local.js")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "test")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "manifest.dev.json")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "options.html")), true);
    assert.equal(fs.existsSync(path.join(extractDirectory, "options.js")), true);
    assert.equal(fs.existsSync(path.join(extractDirectory, "custom-keywords-init.js")), true);
    assert.equal(fs.existsSync(path.join(extractDirectory, "src/shared/keywordCsv.js")), true);
    assert.equal(fs.existsSync(path.join(extractDirectory, "settings-ui.js")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "src/access/policy.js")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "privacy-ui.js")), false);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

function runPackager(mode, outputDirectory, extraEnvironment) {
  const environment = { ...process.env, ...extraEnvironment };
  if (extraEnvironment.KEYWORD_HIGHLIGHTER_ENDPOINT_URL === undefined) delete environment.KEYWORD_HIGHLIGHTER_ENDPOINT_URL;
  return execFileSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(repositoryRoot, "scripts/package-extension.ps1"),
    "-Mode", mode,
    "-OutputDirectory", outputDirectory
  ], { cwd: repositoryRoot, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("an endpoint override must name the Offsight collector", { skip: process.platform !== "win32" }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-highlighter-package-"));
  const extractDirectory = path.join(outputDirectory, "extracted");

  try {
    for (const endpoint of ["https://script.google.com/macros/s/test-deployment/exec", "http://opsportal.online/keyword-highlighter/logs", "https://opsportal.online/other"]) {
      assert.throws(
        () => runPackager("Development", outputDirectory, { KEYWORD_HIGHLIGHTER_ENDPOINT_URL: endpoint }),
        /must be https:\/\/opsportal\.online\/keyword-highlighter\/logs/
      );
    }
    const zipPath = runPackager("Development", outputDirectory, {
      KEYWORD_HIGHLIGHTER_ENDPOINT_URL: "https://opsportal.online/keyword-highlighter/logs"
    }).split(/\r?\n/).at(-1);
    fs.mkdirSync(extractDirectory);
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TEST_ZIP, $env:TEST_EXTRACT)"
    ], { env: { ...process.env, TEST_ZIP: zipPath, TEST_EXTRACT: extractDirectory } });
    const configText = fs.readFileSync(path.join(extractDirectory, "src/logging/config.js"), "utf8");
    assert.match(configText, /endpointUrl: "https:\/\/opsportal\.online\/keyword-highlighter\/logs"/);
    assert.doesNotMatch(configText, /apiKey/);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("development packaging needs no environment variables", { skip: process.platform !== "win32" }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-highlighter-package-"));

  try {
    const packaged = runPackager("Development", outputDirectory, {}).split(/\r?\n/).at(-1);
    assert.equal(fs.existsSync(packaged), true);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
