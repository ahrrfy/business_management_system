import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("reverse proxy security boundary", () => {
  it("يجعل Express والراوتر الحساس case-sensitive", async () => {
    const index = await readFile(path.resolve(process.cwd(), "server/index.ts"), "utf8");
    const backups = await readFile(path.resolve(process.cwd(), "server/backupRoutes.ts"), "utf8");
    expect(index).toContain('app.set("case sensitive routing", true)');
    expect(index.indexOf('app.set("case sensitive routing", true)')).toBeLessThan(
      index.indexOf("app.use(publicStorefrontHostBoundary)"),
    );
    expect(backups).toContain("Router({ caseSensitive: true, strict: true })");
  });

  it("يفرض سرّ hop في إنتاج loopback ويضيفه nginx لكل proxy_pass", async () => {
    const index = await readFile(path.resolve(process.cwd(), "server/index.ts"), "utf8");
    const nginx = await readFile(path.resolve(process.cwd(), "deploy/nginx-erp.conf"), "utf8");
    expect(index).toContain("INTERNAL_PROXY_SECRET");
    const proxied = nginx.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/g) ?? [];
    const proof = nginx.match(/proxy_set_header\s+X-Internal-Proxy-Secret\s+\$alroya_proxy_secret;/g) ?? [];
    expect(proof.length).toBe(proxied.length);
  });

  it("يرفض aliases ذات المقاطع الإضافية قبل مكيّف tRPC", async () => {
    const index = await readFile(path.resolve(process.cwd(), "server/index.ts"), "utf8");
    expect(index).toContain('!parseCanonicalTrpcProcedures(req.path || "")');
    expect(index.indexOf('!parseCanonicalTrpcProcedures(req.path || "")')).toBeLessThan(
      index.indexOf("createExpressMiddleware({"),
    );
  });

  it("يسمح لمكيّف tRPC باستقبال الاستعلامات الكبيرة في جسم POST", async () => {
    const index = await readFile(path.resolve(process.cwd(), "server/index.ts"), "utf8");
    const adapter = index.slice(
      index.indexOf("createExpressMiddleware({"),
      index.indexOf("// جسر الطباعة الصامتة"),
    );
    expect(adapter).toContain("allowMethodOverride: true");
    expect(adapter).toContain("maxBatchSize: 20");
  });

  it("يحصر معرّف عامل canary في healthz المباشر عبر loopback", async () => {
    const index = await readFile(path.resolve(process.cwd(), "server/index.ts"), "utf8");
    const proxyCommon = await readFile(
      path.resolve(process.cwd(), "deploy/nginx-proxy-common.conf"),
      "utf8",
    );
    const probe = index.slice(
      index.indexOf('req.path === "/healthz"'),
      index.indexOf("if (!matchesInternalProxySecret"),
    );
    expect(probe).toContain('req.get("x-alroya-worker-probe") === "1"');
    expect(probe).toContain('req.socket.remoteAddress ?? ""');
    expect(probe).toContain('res.setHeader("x-alroya-worker-instance"');
    expect(proxyCommon).toContain('proxy_set_header X-Alroya-Worker-Probe "";');
  });
});
