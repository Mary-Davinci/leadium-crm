const $ = (id) => document.getElementById(id);

async function render() {
  const { settings = { enabled: true, diagnostic: true }, events = [] } = await chrome.storage.local.get(["settings", "events"]);
  $("enabled").checked = settings.enabled;
  $("diagnostic").checked = settings.diagnostic;
  $("events").replaceChildren(...(events.length ? events : [{ at: "", text: "Nessun evento" }]).map((event) => {
    const li = document.createElement("li");
    if (event.at) { const time = document.createElement("time"); time.textContent = new Date(event.at).toLocaleTimeString("it-IT"); li.append(time); }
    li.append(event.text);
    return li;
  }));
}

async function save() {
  await chrome.storage.local.set({ settings: { enabled: $("enabled").checked, diagnostic: $("diagnostic").checked } });
  render();
}

$("enabled").addEventListener("change", save);
$("diagnostic").addEventListener("change", save);
$("clear").addEventListener("click", async () => { await chrome.storage.local.set({ events: [] }); render(); });
chrome.storage.onChanged.addListener(render);
render();
