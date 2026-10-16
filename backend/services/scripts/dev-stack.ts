import "../../loadEnv";
import path from "path";

const ROOT = path.join(__dirname, "..");
const runtimeExtension = __filename.endsWith(".js") ? ".js" : ".ts";
let stopCallService: (() => Promise<void>) | undefined;

const services = [
  { name: "workflow-service", entry: path.join(ROOT, "workflow-service", `server${runtimeExtension}`) },
  { name: "lead-service", entry: path.join(ROOT, "lead-service", `server${runtimeExtension}`) },
  { name: "call-service", entry: path.join(ROOT, "call-service", `server${runtimeExtension}`) },
  { name: "analytics-service", entry: path.join(ROOT, "analytics-service", `server${runtimeExtension}`) },
  { name: "ingest-service", entry: path.join(ROOT, "ingest-service", `server${runtimeExtension}`) },
  { name: "whatsapp-service", entry: path.join(ROOT, "whatsapp-service", `server${runtimeExtension}`) },
  { name: "api-gateway", entry: path.join(ROOT, "api-gateway", `server${runtimeExtension}`) }
];

for (const service of services) {
  try {
    // Ogni modulo avvia il proprio server su porta dedicata.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const instance = require(service.entry);
    if (service.name === "call-service") stopCallService = instance.stopCallService;
    process.stdout.write(`[${service.name}] started\n`);
  } catch (error: any) {
    process.stderr.write(`[${service.name}] failed: ${error.message}\n`);
    process.exit(1);
  }
}

let stopping = false;
async function stopStack() {
  if (stopping) return;
  stopping = true;
  await stopCallService?.();
  process.exit(0);
}
process.once("SIGINT", () => { void stopStack(); });
process.once("SIGTERM", () => { void stopStack(); });
