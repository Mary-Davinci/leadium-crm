import "../../loadEnv";
import http from "http";
import { getWorkflowView, isValidTransition } from "../common/workflow";

const HOST = "0.0.0.0";
const PORT = Number(process.env.WORKFLOW_SERVICE_PORT || 4302);

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);
  const method = req.method || "GET";

  if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, service: "workflow-service" });
  if (method === "GET" && path === "/workflow") return sendJson(res, 200, getWorkflowView());
  if (method === "GET" && path === "/internal/validate-transition") {
    const fromStatus = url.searchParams.get("from") || "";
    const toStatus = url.searchParams.get("to") || "";
    return sendJson(res, 200, { valid: isValidTransition(fromStatus, toStatus) });
  }
  return sendJson(res, 404, { error: "Endpoint non trovato." });
});

server.listen(PORT, HOST, () => {
  console.log(`workflow-service su http://localhost:${PORT}`);
});
