import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("dependency security coverage", () => {
  it("يفحص Security Audit أقفال الجذر وتطبيقي Expo", () => {
    const workflow = read(".github/workflows/security.yml");

    expect(workflow).toContain("pnpm-lock.yaml");
    expect(workflow).toContain("expo/customer-store-mobile/pnpm-lock.yaml");
    expect(workflow).toContain("expo/superapp-mobile/pnpm-lock.yaml");
    expect(workflow).toContain("--config=osv-scanner.toml");
  });

  it("يبقي فحص الثغرات مركزياً في OSV بلا اعتماد على npm audit المتقاعد", () => {
    const mobileWorkflow = read(".github/workflows/expo-mobile-check.yml");
    const securityWorkflow = read(".github/workflows/security.yml");

    expect(mobileWorkflow).not.toContain("pnpm audit");
    expect(securityWorkflow).toContain("osv-scanner scan");
  });

  it("يثبت الإصدارات العابرة الآمنة ويبرر الاستثناء الوحيد غير القابل للإصلاح", () => {
    const rootPackageJson = JSON.parse(read("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const rootOverrides = rootPackageJson.pnpm?.overrides ?? {};
    expect(rootOverrides["brace-expansion@<5.0.12"]).toBe("5.0.12");
    expect(rootOverrides["fast-uri@<3.1.9"]).toBe("3.1.9");
    expect(rootOverrides["ip-address@<10.7.4"]).toBe("10.7.4");
    expect(rootOverrides["dompurify@<3.4.17"]).toBe("3.4.17");
    expect(rootOverrides["serialize-javascript@<7.1.3"]).toBe("7.1.3");
    expect(rootOverrides["compression@<1.8.2"]).toBe("1.8.2");
    expect(rootOverrides["fast-copy@<4.1.0"]).toBe("4.1.0");
    expect(rootOverrides["postcss-selector-parser@<7.1.6"]).toBe("7.1.6");
    expect(rootOverrides["proxy-addr@<2.0.8"]).toBe("2.0.8");
    expect(rootOverrides["source-map-js@<1.2.2"]).toBe("1.2.2");
    expect(rootOverrides["qs@<6.16.1"]).toBe("6.16.1");
    expect(rootOverrides["glob@>=9.0.0 <14.0.2"]).toBe("14.0.2");
    expect(rootOverrides["minimatch@>=9.0.0 <11.0.1"]).toBe("11.0.1");

    const packageJson = JSON.parse(
      read("expo/customer-store-mobile/package.json"),
    ) as {
      pnpm?: {
        overrides?: Record<string, string>;
      };
    };
    const overrides = packageJson.pnpm?.overrides ?? {};

    expect(overrides["fast-uri"]).toBe("3.1.9");
    expect(overrides["undici"]).toBe("6.29.1");
    expect(overrides["@grpc/grpc-js"]).toBe("1.13.6");
    expect(overrides["re2js"]).toBe("2.8.7");
    expect(overrides["brace-expansion@1.1.18"]).toBe("1.1.21");
    expect(overrides["brace-expansion@2.1.4"]).toBe("2.1.7");
    expect(overrides["brace-expansion@5.0.9"]).toBe("5.0.12");
    expect(overrides["compression"]).toBe("1.8.2");
    expect(overrides["postcss-selector-parser"]).toBe("7.1.6");
    expect(overrides["source-map-js"]).toBe("1.2.2");
    expect(overrides["shell-quote"]).toBe("^1.12.0");
    expect(overrides["http-cache-semantics"]).toBe("4.3.0");
    expect(overrides["node-forge"]).toBe("1.4.1");
    expect(overrides["glob@>=9.0.0 <14.0.2"]).toBe("14.0.2");
    expect(overrides["minimatch@>=9.0.0 <11.0.1"]).toBe("11.0.1");

    const superappPackageJson = JSON.parse(
      read("expo/superapp-mobile/package.json"),
    ) as {
      pnpm?: {
        overrides?: Record<string, string>;
      };
    };
    const superappOverrides = superappPackageJson.pnpm?.overrides ?? {};
    expect(superappOverrides["fast-uri"]).toBe("3.1.9");
    expect(superappOverrides["undici"]).toBe("6.29.1");
    expect(superappOverrides["brace-expansion@1.1.18"]).toBe("1.1.21");
    expect(superappOverrides["brace-expansion@2.1.4"]).toBe("2.1.7");
    expect(superappOverrides["brace-expansion@5.0.9"]).toBe("5.0.12");
    expect(superappOverrides["compression"]).toBe("1.8.2");
    expect(superappOverrides["source-map-js"]).toBe("1.2.2");
    expect(superappOverrides["shell-quote"]).toBe("^1.12.0");
    expect(superappOverrides["node-forge"]).toBe("1.4.1");
    expect(superappOverrides["glob@>=9.0.0 <14.0.2"]).toBe("14.0.2");
    expect(superappOverrides["minimatch@>=9.0.0 <11.0.1"]).toBe("11.0.1");

    const osvConfig = read("osv-scanner.toml");
    expect(osvConfig).toContain('id = "GHSA-86w9-cpqp-85rv"');
    expect(osvConfig).toContain('id = "GHSA-vfj7-8cjw-p6xm"');
    expect(osvConfig).toContain('id = "GHSA-hp3w-g68c-fv3c"');
    expect(osvConfig).toContain('id = "GHSA-g3hv-75wg-m249"');
    expect(osvConfig).toContain('reason = "');
  });

  it("مصدر Express يستخدم qs المصححة دون انهيار عند مصفوفة comma بقيمة toString غير قابلة للاستدعاء", () => {
    const appRequire = createRequire(resolve(process.cwd(), "package.json"));
    const expressRequire = createRequire(appRequire.resolve("express"));
    const qs = expressRequire("qs");
    expect(() => qs.stringify(JSON.parse('{"a":[{"toString":"x"}]}'), { arrayFormat: "comma" })).not.toThrow();
    expect(() => qs.stringify(JSON.parse('{"a":[{"toString":"x"}]}'), { arrayFormat: "comma", encodeValuesOnly: true })).not.toThrow();
  });

  it("يقصر استثناء deepmerge على مسارات إعداد البناء المفحوصة في الأقفال الثلاثة", () => {
    for (const [lock, expectedParent] of [
      ["pnpm-lock.yaml", "@rollup/plugin-node-resolve@"],
      ["expo/customer-store-mobile/pnpm-lock.yaml", "@expo/config@"],
      ["expo/superapp-mobile/pnpm-lock.yaml", "@expo/config@"],
    ]) {
      let parent = "";
      const consumers: string[] = [];
      for (const line of read(lock).replaceAll("\r\n", "\n").split("\n")) {
        if (/^  \S/.test(line)) parent = line.trim().replace(/^['"]/, "");
        if (/^      deepmerge:/.test(line)) consumers.push(parent);
      }
      expect(consumers).toHaveLength(1);
      expect(consumers[0]?.startsWith(expectedParent)).toBe(true);
      const manifest = JSON.parse(read(lock.replace("pnpm-lock.yaml", "package.json")));
      expect(manifest.dependencies?.deepmerge).toBeUndefined();
    }
  });

  it("يرقي كل مستهلكي node-forge وglob>=9 وminimatch>=9 ويقصر استثناء minimatch على مستهلكي CJS القدامى", () => {
    const allowedLegacyMinimatchPrefixes = [
      "@eslint/config-array@",
      "@eslint/eslintrc@",
      "eslint@",
      "eslint-plugin-import@",
      "eslint-plugin-react@",
      "filelist@1.0.6",
      "glob@7.2.3",
      "readdir-glob@1.1.3",
      "test-exclude@6.0.0",
    ];
    for (const lock of [
      "pnpm-lock.yaml",
      "expo/customer-store-mobile/pnpm-lock.yaml",
      "expo/superapp-mobile/pnpm-lock.yaml",
    ]) {
      let parent = "";
      for (const line of read(lock).replaceAll("\r\n", "\n").split("\n")) {
        if (/^  \S/.test(line)) parent = line.trim().replace(/^['"]/, "");
        const nodeForge = /^      node-forge:\s*(.+)$/.exec(line)?.[1]?.trim();
        if (nodeForge) expect(nodeForge).toBe("1.4.1");
        const globVer = /^      glob:\s*(.+)$/.exec(line)?.[1]?.trim();
        if (globVer && !globVer.startsWith("7.")) {
          expect(globVer.startsWith("14.0.2")).toBe(true);
        }
        const mmVer = /^      minimatch:\s*(.+)$/.exec(line)?.[1]?.trim();
        if (mmVer && mmVer !== "11.0.1") {
          expect(["3.1.5", "5.1.9"]).toContain(mmVer);
          expect(
            allowedLegacyMinimatchPrefixes.some((p) => parent.startsWith(p)),
          ).toBe(true);
        }
      }
      const manifest = JSON.parse(read(lock.replace("pnpm-lock.yaml", "package.json")));
      expect(manifest.dependencies?.minimatch).toBeUndefined();
    }
  });
});
