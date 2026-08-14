import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(__dirname, "..");

test("Store packager creates a production-only ZIP with injected release configuration", { skip: process.platform !== "win32" }, () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-highlighter-package-"));
  const extractDirectory = path.join(outputDirectory, "extracted");
  const environment = {
    ...process.env,
    KEYWORD_HIGHLIGHTER_ENDPOINT_URL: "https://script.google.com/macros/s/test-deployment/exec",
    KEYWORD_HIGHLIGHTER_API_KEY: "test-release-token-1234567890"
  };

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
    assert.doesNotMatch(manifestText, /localhost|127\.0\.0\.1|"tabs"/);
    assert.match(configText, /test-deployment/);
    assert.match(configText, /test-release-token-1234567890/);
    assert.doesNotMatch(configText, /REPLACE_WITH_|YOUR_DEPLOYMENT_ID|replace-with-|import\s*\(/);
    assert.equal(fs.existsSync(path.join(extractDirectory, "src/logging/config.local.js")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "test")), false);
    assert.equal(fs.existsSync(path.join(extractDirectory, "manifest.dev.json")), false);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
