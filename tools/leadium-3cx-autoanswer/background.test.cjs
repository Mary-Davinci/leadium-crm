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
  const moved = [], pressed = [], answers = [], windows = [], notices = [], closed = [];
  const clicks = {};
  let listener;
  const chrome = {
    storage: { session: area(session), local: area(local) },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    notifications: {
      create: async (id, options) => { notices.push(options); },
      clear: async () => { closed.push("notification"); },
      onButtonClicked: { addListener: (fn) => { clicks.button = fn; } },
      onClicked: { addListener: (fn) => { clicks.body = fn; } }
    },
    tabs: {
      update: async (id) => { moved.push(["tab", id]); return { windowId: 3 }; },
      sendMessage: async (id, message) => { pressed.push([id, message.digits]); return answers.length ? answers.shift() : undefined; }
    },
    windows: {
      update: async (id, options) => { moved.push(["window", id, options.focused]); },
      create: async (options) => { windows.push(options); return { id: 40 + windows.length }; },
      remove: async (id) => { closed.push(id); }
    }
  };
  new Function("chrome", fs.readFileSync(path.join(__dirname, "background.js"), "utf8"))(chrome);
  const send = (message, sender = { tab: { id: 7, windowId: 3 } }) => new Promise((resolve) => listener(message, sender, resolve));
  return { send, moved, local, session, pressed, answers, windows, notices, closed, clicks };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

(async () => {
  {
    const { send, windows, notices } = load();
    const started = Date.now();
    const result = await send({ type: "claim", shownDigits: "393331112222" });
    assert.equal(result.decision, "ignore");
    assert.ok(Date.now() - started < 1000, "a customer's call does not wait for a Chiama that never happened");
    assert.equal(windows.length, 1, "the call window opens");
    assert.equal(windows[0].url, "incoming.html");
    assert.equal(windows[0].focused, true);
    assert.equal(notices.length, 1, "and the system notification, which works over any program");
    assert.equal(notices[0].requireInteraction, true);
    assert.deepEqual(notices[0].buttons.map((button) => button.title), ["Rispondi", "Apri 3CX"]);
    console.log("PASS a customer's call opens the window and the notification at once, and is not answered");
  }
  {
    const { send, windows, notices } = load();
    await send({ type: "dial-started" });
    const claim = send({ type: "claim", shownDigits: "393331112222" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await send({ type: "callback-expected", destination: "+393331112222" });
    assert.equal((await claim).decision, "answer", "the callback that rings before the response is still recognised");
    assert.deepEqual([windows.length, notices.length], [0, 0], "the automatic answer shows nothing");
    console.log("PASS Leadium's own callback is answered and stays in the background");
  }
  {
    const { send, windows } = load();
    await send({ type: "callback-expected", destination: "+393331112222" });
    assert.equal((await send({ type: "claim", shownDigits: "390699999999" })).decision, "ignore");
    assert.equal(windows.length, 1, "another caller during a Chiama is still a real call");
    console.log("PASS a different number during a Chiama rings as a real call");
  }
  {
    const { send, windows, notices, session } = load();
    const leadium = { tab: { id: 99, windowId: 1 } };
    await Promise.all([
      send({ type: "claim", shownDigits: "393331112222" }),
      send({ type: "incoming-call", callId: "55", name: "Mario Rossi", phone: "+393331112222" }, leadium)
    ]);
    assert.equal(windows.length, 1, "both sources report it: one window");
    assert.equal(session.ringing.name, "Mario Rossi", "Leadium brings the name");
    assert.equal(notices.at(-1).message, "Mario Rossi");
    await send({ type: "incoming-call", callId: "55", name: "Mario Rossi", phone: "+393331112222" }, leadium);
    assert.equal(windows.length, 1, "the page repeats itself: nothing new");
    console.log("PASS one call, one window, with the name when Leadium knows it");
  }
  {
    const { send, windows, closed, session } = load();
    await send({ type: "incoming-call", callId: "55", name: "Mario Rossi", phone: "+393331112222" });
    await send({ type: "ring-ended" });
    assert.equal(session.ringing, undefined);
    assert.deepEqual(closed, ["notification", 41], "window and notification go");
    await send({ type: "incoming-call", callId: "55", name: "Mario Rossi", phone: "+393331112222" });
    assert.equal(windows.length, 1, "a late repeat of an ended call does not ring again");
    await send({ type: "incoming-call", callId: "56", name: "Anna Bianchi", phone: "+393330000000" });
    assert.equal(windows.length, 2, "the next call does");
    console.log("PASS the ringing ends for everyone, and the next call rings");
  }
  {
    const { send, windows, notices } = load();
    await send({ type: "leadium-focus", focused: true }, { tab: { id: 99 } });
    await send({ type: "incoming-call", callId: "60" }, { tab: { id: 99 } });
    await send({ type: "claim", shownDigits: "393331112222" });
    assert.deepEqual([windows.length, notices.length], [0, 0], "Rispondi is in front of the operator");
    await send({ type: "leadium-focus", focused: false }, { tab: { id: 99 } });
    await send({ type: "incoming-call", callId: "61" }, { tab: { id: 99 } });
    assert.equal(windows.length, 1, "working elsewhere, the window opens");
    console.log("PASS the window opens only while the operator is away from Leadium");
  }
  {
    const { send, moved, pressed, answers, session, closed } = load();
    await send({ type: "threecx-tab" });
    await send({ type: "incoming-call", callId: "70", name: "Mario Rossi", phone: "+393331112222" }, { tab: { id: 99 } });
    answers.push({ pressed: true });
    await send({ type: "ring-answer" });
    assert.deepEqual(pressed, [[7, "393331112222"]], "Rispondi in the window presses Answer in the 3CX tab");
    assert.equal(session.ringing, undefined);
    assert.ok(closed.includes("notification"));
    assert.deepEqual(moved, [["tab", 7], ["window", 3, true]], "the operator lands on 3CX, where the call closes");
    console.log("PASS Rispondi in the window answers and takes the operator to 3CX");
  }
  {
    const { send, pressed, answers, clicks } = load();
    await send({ type: "threecx-tab" });
    await send({ type: "incoming-call", callId: "71", phone: "+393331112222" }, { tab: { id: 99 } });
    answers.push({ pressed: true });
    clicks.button("leadium-call", 0);
    await settle();
    assert.equal(pressed.length, 1, "the notification's Rispondi answers too");
    console.log("PASS Rispondi on the system notification answers");
  }
  {
    const { send, moved, clicks } = load();
    await send({ type: "threecx-tab" });
    await send({ type: "incoming-call", callId: "72" }, { tab: { id: 99 } });
    clicks.button("leadium-call", 1);
    await settle();
    assert.deepEqual(moved, [["tab", 7], ["window", 3, true]]);
    console.log("PASS Apri 3CX brings the tab forward");
  }
  {
    const { send, moved, session } = load();
    await send({ type: "incoming-call", callId: "57" });
    assert.deepEqual(moved, [], "no 3CX tab known");
    assert.equal(session.lastCallId, "57");
    console.log("PASS no 3CX tab open: nothing moves");
  }
  {
    const { send, windows, notices, local } = load();
    local.settings = { enabled: true, diagnostic: false, bringForward: false };
    await send({ type: "claim", shownDigits: "393331112222" });
    assert.deepEqual([windows.length, notices.length], [0, 1], "off: no window, the notification stays");
    console.log("PASS the switch turns the window off");
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
