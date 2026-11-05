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
  const moved = [];
  let listener;
  const chrome = {
    storage: { session: area(session), local: area(local) },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: { update: async (id) => { moved.push(["tab", id]); } },
    windows: { update: async (id, options) => { moved.push(["window", id, options.focused]); } }
  };
  new Function("chrome", fs.readFileSync(path.join(__dirname, "background.js"), "utf8"))(chrome);
  const send = (message, sender = { tab: { id: 7, windowId: 3 } }) => new Promise((resolve) => listener(message, sender, resolve));
  return { send, moved, local, session };
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
    const { send, moved, local } = load();
    local.settings = { enabled: true, diagnostic: false, bringForward: false };
    await send({ type: "claim", shownDigits: "393331112222" });
    assert.deepEqual(moved, []);
    console.log("PASS the switch turns it off");
  }
})().catch((error) => { console.error(error); process.exit(1); });
