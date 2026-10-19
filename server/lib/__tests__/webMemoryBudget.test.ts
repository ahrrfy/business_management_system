import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("starts web workers with a V8 limit below the unchanged RSS watchdog", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "erp-web-memory-"));
  const environment = Object.fromEntries(
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]!]),
  );
  try {
    // Loading the real ecosystem in an empty directory avoids dotenv/DB access.
    const config = spawnSync(process.execPath, ["-e", `
      const config = require(process.argv[1]);
      const web = config.apps.find(app => app.name === "erp-server");
      console.log(JSON.stringify({ args: web.node_args || [], rss: web.max_memory_restart }));
    `, path.resolve("ecosystem.config.cjs")], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 10_000,
    });
    expect(config.status, config.stderr).toBe(0);
    const web = JSON.parse(config.stdout.trim());
    expect(web.rss).toBe("1024M");
    const child = spawnSync(process.execPath, [...web.args, "-e",
      "console.log(require('node:v8').getHeapStatistics().heap_size_limit)"], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 10_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const heapLimit = Number(child.stdout.trim());
    expect(Number.isFinite(heapLimit) && heapLimit > 0).toBe(true);
    // Reserve at least 384 MiB for native code, Buffer/image work and RSS overhead.
    expect(heapLimit).toBeLessThanOrEqual((1024 - 384) * 1024 * 1024);
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
        !path.basename(directory).startsWith("erp-web-memory-")) {
      throw new Error("Unexpected owned temporary directory");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
