import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../highlighter/src/shared/keywordCsv.js"), "utf8");

function loadKeywordCsv() {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: "keywordCsv.js" });
  return context.globalThis.AMH_KEYWORD_CSV;
}

test("keyword CSV export writes required headers and escapes spreadsheet text", () => {
  const csv = loadKeywordCsv();
  const output = csv.serializeKeywordCsv([
    { keyword: "STOP", hoverText: "Standard guidance" },
    { keyword: "hello, world", hoverText: "Say \"hello\"\nthen stop" }
  ]);

  assert.equal(
    output,
    'keyword,hover text\r\nSTOP,Standard guidance\r\n"hello, world","Say ""hello""\nthen stop"\r\n'
  );
});

test("keyword CSV import handles BOM, CRLF, commas, quotes, and multiline values", () => {
  const csv = loadKeywordCsv();
  const entries = csv.parseKeywordCsv(
    '\uFEFFkeyword,hover text\r\nSTOP,Standard guidance\r\n"hello, world","Say ""hello""\r\nthen stop"\r\n'
  );

  assert.deepEqual(
    Array.from(entries, (entry) => ({ ...entry })),
    [
      { keyword: "STOP", hoverText: "Standard guidance" },
      { keyword: "hello, world", hoverText: 'Say "hello"\r\nthen stop' }
    ]
  );
});

test("keyword CSV import requires exact row-one headers and at most two columns", () => {
  const csv = loadKeywordCsv();

  assert.throws(() => csv.parseKeywordCsv("Keyword,Hover Text\nSTOP,Guidance"), /Row 1/);
  assert.throws(() => csv.parseKeywordCsv("keyword,hover text,extra\nSTOP,Guidance,nope"), /Row 1/);
  assert.throws(() => csv.parseKeywordCsv("keyword,hover text\nSTOP,Guidance,nope"), /two columns/);
  assert.throws(() => csv.parseKeywordCsv('keyword,hover text\n"STOP,Guidance'), /Unterminated/);
});
