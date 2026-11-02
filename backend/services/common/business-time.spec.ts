import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the actual service bootstrap under hosting/device timezones, not just Intl formatting.
for (const hostZone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, "..", "..", "loadEnv.js"))});
    console.log(JSON.stringify({
      winter: new Date(2026, 10, 2, 10, 30).toISOString(),
      summer: new Date(2026, 6, 2, 10, 30).toISOString(),
      endOfDay: new Date(2026, 6, 2, 18).toISOString(),
      midnight: new Date("2026-11-01T23:30:00Z").getDate()
    }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: hostZone }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    winter: "2026-11-02T09:30:00.000Z", summer: "2026-07-02T08:30:00.000Z",
    endOfDay: "2026-07-02T16:00:00.000Z", midnight: 2
  });
}
console.log("PASS business timezone: actual bootstrap uses Rome in winter, summer, end-of-day tasks and midnight regardless of hosting TZ");
