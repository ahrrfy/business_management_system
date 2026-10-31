import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps web source maps available offline without retaining them in every worker", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "erp-web-sourcemap-"));
  try {
    const fixture = path.join(directory, "fixture.ts");
    const output = path.join(directory, "probe.mjs");
    writeFileSync(fixture, 'export function failForTest() {\n  throw new Error("synthetic source map probe");\n}\nfailForTest();\n');
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
    const command = scripts.build.split("&&").map((part: string) => part.trim())
      .find((part: string) => part.startsWith("esbuild server/index.ts "));
    expect(command).toBeDefined();
    const args = command.split(/\s+/).slice(1).map((arg: string) =>
      arg === "server/index.ts" ? fixture : arg.startsWith("--outfile=") ? `--outfile=${output}` : arg,
    );
    const require = createRequire(import.meta.url);
    // pnpm can replace this entry with an ELF executable on POSIX; Windows
    // keeps esbuild's JavaScript launcher.
    const cli = require.resolve("esbuild/bin/esbuild");
    const built = spawnSync(process.platform === "win32" ? process.execPath : cli,
      process.platform === "win32" ? [cli, ...args] : args, {
      cwd: directory, encoding: "utf8", timeout: 10_000,
    });
    expect(built.status, built.stderr).toBe(0);
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import { findSourceMap, setSourceMapsSupport, SourceMap } from 'node:module';
      // Match PM2's native source-map support, without starting PM2 or the ERP.
      setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
      const filename = process.argv[1];
      let stack;
      try { await import(pathToFileURL(filename).href); } catch (error) { stack = error.stack; }
      const generated = stack?.match(/probe\\.mjs:(\\d+):(\\d+)/);
      const map = new SourceMap(JSON.parse(fs.readFileSync(filename + '.map', 'utf8')));
      console.log(JSON.stringify({
        cached: findSourceMap(filename) !== undefined,
        origin: generated ? map.findOrigin(Number(generated[1]), Number(generated[2])) : null,
      }));
    `, output], { cwd: directory, encoding: "utf8", timeout: 10_000 });
    expect(probe.status, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim());
    expect(result.cached).toBe(false);
    expect(result.origin.fileName).toMatch(/fixture\.ts$/);
    expect(result.origin.lineNumber).toBe(2);
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
        !path.basename(directory).startsWith("erp-web-sourcemap-")) {
      throw new Error("Unexpected owned temporary directory");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

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
