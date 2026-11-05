// node tools/leadium-3cx-autoanswer/background.test.cjs — the extension's decisions, with Chrome faked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function load() {
  const session = {}, local = {};
  const area = (data) => ({
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in data).map((key) => [key, data[key]])),
    set: async (values) => { Object.assign(data, values); },
    remove: async (key) => { delete data[key]; }
  });
  const moved = [], pressed = [], answers = [];
  let listener;
  const chrome = {
    storage: { session: area(session), local: area(local) },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      update: async (id) => { moved.push(["tab", id]); return { windowId: 3 }; },
      sendMessage: async (id, message) => { pressed.push([id, message.digits]); return answers.length ? answers.shift() : undefined; }
    },
    windows: { update: async (id, options) => { moved.push(["window", id, options.focused]); } }
  };
  new Function("chrome", fs.readFileSync(path.join(__dirname, "background.js"), "utf8"))(chrome);
  const send = (message, sender = { tab: { id: 7, windowId: 3 } }) => new Promise((resolve) => listener(message, sender, resolve));
  return { send, moved, local, session, pressed, answers };
}

(async () => {
  {
    const { send, moved } = load();
    const started = Date.now();
    const result = await send({ type: "claim", shownDigits: "393331112222" });
    assert.equal(result.decision, "ignore");
    assert.ok(Date.now() - started < 1000, "a customer's call does not wait for a Chiama that never happened");
    assert.deepEqual(moved, [["tab", 7], ["window", 3, true]], "3CX comes forward");
    console.log("PASS a customer's call brings 3CX forward at once and is not answered");
  }
  {
    const { send, moved } = load();
    await send({ type: "dial-started" });
    const claim = send({ type: "claim", shownDigits: "393331112222" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await send({ type: "callback-expected", destination: "+393331112222" });
    assert.equal((await claim).decision, "answer", "the callback that rings before the response is still recognised");
    assert.deepEqual(moved, [], "the automatic answer steals no focus");
    console.log("PASS Leadium's own callback is answered and stays in the background");
  }
  {
    const { send, moved } = load();
    await send({ type: "callback-expected", destination: "+393331112222" });
    assert.equal((await send({ type: "claim", shownDigits: "390699999999" })).decision, "ignore");
    assert.equal(moved.length, 2, "another caller during a Chiama is still a real call");
    console.log("PASS a different number during a Chiama rings as a real call");
  }
  {
    const { send, moved } = load();
    await send({ type: "threecx-tab" });
    await send({ type: "incoming-call", callId: "55" }, { tab: { id: 99, windowId: 1 } });
    assert.deepEqual(moved, [["tab", 7], ["window", 3, true]], "the 3CX tab comes forward, not Leadium's");
    await send({ type: "incoming-call", callId: "55" }, { tab: { id: 99, windowId: 1 } });
    assert.equal(moved.length, 2, "one call, one jump: the operator is not dragged back while it rings");
    await send({ type: "incoming-call", callId: "56" }, { tab: { id: 99, windowId: 1 } });
    assert.equal(moved.length, 4);
    console.log("PASS Leadium's signal brings 3CX forward once per call");
  }
  {
    const { send, moved, session } = load();
    await send({ type: "incoming-call", callId: "57" });
    assert.deepEqual(moved, [], "no 3CX tab known");
    assert.equal(session.lastCallId, "57");
    console.log("PASS no 3CX tab open: nothing moves");
  }
  {
    const { send, moved, local } = load();
    local.settings = { enabled: true, diagnostic: false, bringForward: false };
    await send({ type: "claim", shownDigits: "393331112222" });
    assert.deepEqual(moved, []);
    console.log("PASS the switch turns it off");
  }
  {
    const { send, moved } = load();
    await send({ type: "threecx-tab" });
    await send({ type: "leadium-focus", focused: true }, { tab: { id: 99 } });
    await send({ type: "incoming-call", callId: "60" }, { tab: { id: 99 } });
    await send({ type: "claim", shownDigits: "393331112222" });
    assert.deepEqual(moved, [], "Rispondi is in front of the operator: 3CX stays behind");
    await send({ type: "leadium-focus", focused: false }, { tab: { id: 99 } });
    await send({ type: "incoming-call", callId: "61" }, { tab: { id: 99 } });
    assert.equal(moved.length, 2, "working elsewhere, 3CX comes forward");
    console.log("PASS 3CX comes forward only while the operator is away from Leadium");
  }
  {
    const { send, moved, pressed, answers } = load();
    await send({ type: "threecx-tab" });
    answers.push(undefined, { pressed: true });
    assert.deepEqual(await send({ type: "answer-call", phone: "393331112222" }, { tab: { id: 99 } }), { ok: true });
    assert.deepEqual(pressed, [[7, "393331112222"], [7, "393331112222"]], "3CX drew its screen a moment later: retried");
    assert.deepEqual(moved, [], "answered from Leadium: nothing moves");
    console.log("PASS Rispondi in Leadium presses Answer in the 3CX tab");
  }
  {
    const { send, moved, answers } = load();
    await send({ type: "threecx-tab" });
    answers.push({ pressed: false, reason: "other-call" });
    await send({ type: "leadium-focus", focused: true }, { tab: { id: 99 } });
    assert.deepEqual(await send({ type: "answer-call", phone: "393331112222" }, { tab: { id: 99 } }), { ok: false, reason: "other-call" });
    assert.equal(moved.length, 2, "not answered: the operator is taken to 3CX even from Leadium");
    console.log("PASS another caller on the 3CX screen is not answered");
  }
  {
    const { send, pressed } = load();
    assert.deepEqual(await send({ type: "answer-call", phone: "393331112222" }, { tab: { id: 99 } }), { ok: false, reason: "no-tab" });
    assert.deepEqual(pressed, []);
    console.log("PASS no 3CX tab: Leadium is told so");
  }
  {
    const { send, moved } = load();
    await send({ type: "threecx-tab" });
    assert.deepEqual(await send({ type: "answer-call", phone: "" }, { tab: { id: 99 } }), { ok: false, reason: "no-button" });
    assert.equal(moved.length, 2);
    console.log("PASS no Answer button on screen: Leadium is told and 3CX comes forward");
  }
})().catch((error) => { console.error(error); process.exit(1); });
