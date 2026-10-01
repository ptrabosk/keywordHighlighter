import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "../highlighter/src/shared/keywordCsv.js");
// The file URL lets coverage tools attribute this vm-run script to its source.
const sourceUrl = pathToFileURL(sourcePath).href;
const source = fs.readFileSync(sourcePath, "utf8");

function loadKeywordCsv() {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: sourceUrl });
  return context.globalThis.AMH_KEYWORD_CSV;
}

test("keyword CSV export writes the keyword header and escapes spreadsheet text", () => {
  const csv = loadKeywordCsv();
  const output = csv.serializeKeywordCsv([
    { keyword: "STOP" },
    { keyword: "hello, world" },
    { keyword: 'say "hi"' }
  ]);

  assert.equal(output, 'keyword\r\nSTOP\r\n"hello, world"\r\n"say ""hi"""\r\n');
});

test("keyword CSV import handles BOM, CRLF, commas, and quotes", () => {
  const csv = loadKeywordCsv();
  const entries = csv.parseKeywordCsv('\uFEFFkeyword\r\nSTOP\r\n"hello, world"\r\n"say ""hi"""\r\n');

  assert.deepEqual(
    Array.from(entries, (entry) => ({ ...entry })),
    [{ keyword: "STOP" }, { keyword: "hello, world" }, { keyword: 'say "hi"' }]
  );
});

test("keyword CSV import still reads older two-column backups and ignores hover text", () => {
  const csv = loadKeywordCsv();
  const entries = csv.parseKeywordCsv('keyword,hover text\r\nSTOP,Standard guidance\r\n"hello, world","Say ""hello""\r\nthen stop"\r\n');

  assert.deepEqual(
    Array.from(entries, (entry) => ({ ...entry })),
    [{ keyword: "STOP" }, { keyword: "hello, world" }]
  );
});

test("keyword CSV import requires an exact row-one header and matching column count", () => {
  const csv = loadKeywordCsv();

  assert.throws(() => csv.parseKeywordCsv("Keyword\nSTOP"), /Row 1/);
  assert.throws(() => csv.parseKeywordCsv("keyword,hover text,extra\nSTOP,Guidance,nope"), /Row 1/);
  assert.throws(() => csv.parseKeywordCsv("keyword\nSTOP,extra"), /one column/);
  assert.throws(() => csv.parseKeywordCsv("keyword,hover text\nSTOP,Guidance,nope"), /two columns/);
  assert.throws(() => csv.parseKeywordCsv('keyword\n"STOP'), /Unterminated/);
});
