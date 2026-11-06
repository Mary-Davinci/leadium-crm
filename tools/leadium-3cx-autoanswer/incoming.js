// The small window of a ringing call. It shows what the background page stored and closes with it.
const MAX_RING_MS = 60000;
const $ = (id) => document.getElementById(id);

async function render() {
  const { ringing } = await chrome.storage.session.get("ringing");
  if (!ringing) { window.close(); return; }
  $("name").textContent = ringing.name || ringing.phone || "Numero sconosciuto";
  $("phone").textContent = ringing.name ? ringing.phone || "" : "";
}

$("answer").addEventListener("click", () => {
  $("answer").disabled = true;
  void chrome.runtime.sendMessage({ type: "ring-answer" });
});
$("open").addEventListener("click", () => { void chrome.runtime.sendMessage({ type: "ring-open-3cx" }); });

chrome.storage.onChanged.addListener(render);
// A call nobody closed: 3CX stops ringing long before this.
setTimeout(() => { void chrome.runtime.sendMessage({ type: "ring-ended" }); }, MAX_RING_MS);
void render();
