// c8 (via v8-to-istanbul) emits `column: -1` for some branch start locations.
// Istanbul consumers such as fallow require non-negative positions, so clamp
// them to 0. This only moves a branch marker to the start of its line; hit
// counts are untouched.
import fs from "node:fs";

const coveragePath = process.argv[2] || "coverage/coverage-final.json";
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
let clamped = 0;

function clampPositions(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "line" || key === "column") && typeof child === "number" && child < 0) {
      value[key] = 0;
      clamped += 1;
    } else {
      clampPositions(child);
    }
  }
}

clampPositions(coverage);
fs.writeFileSync(coveragePath, JSON.stringify(coverage));
console.log(`normalize-coverage: clamped ${clamped} negative position(s) in ${coveragePath}`);
