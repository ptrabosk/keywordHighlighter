import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../highlighter/src/access/policy.js"), "utf8");

function loadPolicy(chrome = undefined) {
  const context = { globalThis: {} };
  if (chrome) context.chrome = chrome;
  vm.runInNewContext(source, context, { filename: "policy.js" });
  return context.globalThis.AMH_ACCESS_POLICY;
}

test("organization access accepts only exact Attentive Mobile profile domains", () => {
  const policy = loadPolicy();

  assert.equal(policy.isOrganizationEmail("employee@attentivemobile.com"), true);
  assert.equal(policy.isOrganizationEmail("EMPLOYEE@ATTENTIVEMOBILE.COM"), true);
  assert.equal(policy.isOrganizationEmail("employee@sub.attentivemobile.com"), false);
  assert.equal(policy.isOrganizationEmail("employee@attentivemobile.com.evil.test"), false);
  assert.equal(policy.isOrganizationEmail("employee@example.com"), false);
  assert.equal(policy.isOrganizationEmail(""), false);
});

test("privacy consent status and updates use the service worker contract", async () => {
  const messages = [];
  const policy = loadPolicy({
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === "highlighter:getConsentStatus") {
          return { decided: true, telemetry: false, version: 1 };
        }
        return { ok: true };
      }
    }
  });

  const consent = await policy.requestConsentStatus();
  assert.equal(consent.decided, true);
  assert.equal(consent.telemetry, false);
  assert.equal(consent.version, 1);
  assert.equal(await policy.setTelemetryConsent(true), true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, "highlighter:getConsentStatus");
  assert.equal(messages[1].type, "highlighter:setConsent");
  assert.equal(messages[1].telemetry, true);
});
