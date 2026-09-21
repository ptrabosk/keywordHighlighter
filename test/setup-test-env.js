import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const loggingDirectory = path.join(testDirectory, "../highlighter/src/logging");
const runtimeConfigPath = path.join(loggingDirectory, "config.js");
const exampleConfigPath = path.join(loggingDirectory, "config.example.js");

if (!fs.existsSync(runtimeConfigPath)) {
  fs.copyFileSync(exampleConfigPath, runtimeConfigPath);
}

process.env.NODE_ENV = "test";
