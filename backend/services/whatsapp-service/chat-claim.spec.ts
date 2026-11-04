import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
delete process.env.MONGODB_URI;
process.env.WHATSAPP_DB_FILE = path.join(os.tmpdir(), `leadium-chat-claim-${process.pid}.json`);

async function main() {
  const store = require("../common/chatStore");
  try {
    const created = await store.createOrUpdateConversation({ phone: "393331112222", assignedTo: "marta" });
    const afterInbound = await store.createOrUpdateConversation({ phone: "393331112222", lastMessagePreview: "ciao", source: "whatsapp" });
    assert.equal(afterInbound.id, created.id);
    assert.equal(afterInbound.assignedTo, "marta", "a customer message must not take the chat from its operator");
    const released = await store.createOrUpdateConversation({ phone: "393331112222", assignedTo: "" });
    assert.equal(released.assignedTo, "", "an explicit empty value still clears it");
    console.log("PASS inbound message keeps the chat's operator");

    const first = await store.claimConversation(created.id, "luca");
    assert.deepEqual([first.found, first.claimed, first.conversation.assignedTo], [true, true, "luca"]);
    const second = await store.claimConversation(created.id, "marta");
    assert.deepEqual([second.found, second.claimed, second.conversation.assignedTo], [true, false, "luca"]);
    const missing = await store.claimConversation("nope", "marta");
    assert.deepEqual([missing.found, missing.claimed], [false, false]);
    const automated = await store.createOrUpdateConversation({ phone: "393334445555", assignedTo: "automazione" });
    assert.equal((await store.claimConversation(automated.id, "marta")).claimed, true, "automation is not an operator");
    console.log("PASS first claim wins, automation does not hold a chat");
  } finally {
    fs.rmSync(process.env.WHATSAPP_DB_FILE as string, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
