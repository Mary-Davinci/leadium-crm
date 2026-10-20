import assert from "node:assert/strict";
import { agentDns, monitoredDns, parseAgentDns, transferDns } from "./threecx-topology";
import { validateThreeCxDn } from "./threecx-controller";
import { classifyMonitoredDn } from "./threecx-normalizer";

const previous = process.env.THREECX_AGENT_DNS;
try {
  delete process.env.THREECX_AGENT_DNS;
  assert.deepEqual(agentDns(), ["901", "913"], "no configuration keeps the historical extensions");
  assert.deepEqual(monitoredDns(), ["901", "913", "910", "911", "912", "920", "921", "922"]);
  assert.throws(() => validateThreeCxDn("488"), "an unconfigured extension is still refused");

  assert.deepEqual(parseAgentDns(" 901, 913 ,488,488"), ["901", "913", "488"], "trimmed and deduplicated");
  assert.deepEqual(parseAgentDns("901,910,920,abc,1,+39333,488"), ["901", "488"], "queues, receptionists and malformed entries never become operators");
  assert.deepEqual(parseAgentDns(""), ["901", "913"]);
  assert.deepEqual(parseAgentDns("910,xyz"), ["901", "913"], "nothing valid falls back to the defaults");

  process.env.THREECX_AGENT_DNS = "901,913,488";
  assert.equal(validateThreeCxDn("488"), "488");
  assert.ok(transferDns().includes("488") && transferDns().includes("910"));
  assert.ok(monitoredDns().includes("488"));
  assert.equal(classifyMonitoredDn("488", "Extension"), "Agent");
  assert.equal(classifyMonitoredDn("910", "Extension"), "Unknown", "a queue cannot be classified as an operator");

  process.env.THREECX_AGENT_DNS = "901";
  assert.throws(() => validateThreeCxDn("913"), "removing an extension from the configuration revokes it");
  console.log("PASS 3CX topology: default 901/913, configurable operators, infrastructure never an operator");
} finally {
  if (previous === undefined) delete process.env.THREECX_AGENT_DNS; else process.env.THREECX_AGENT_DNS = previous;
}
