import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

function outputFiles(root, directory = "") {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`WEB_RELEASE_SYMLINK:${name}`);
      return entry.isDirectory()
        ? outputFiles(root, name)
        : name === "release.json"
          ? []
          : [name];
    })
    .sort();
}
export function webReleaseFingerprint(root) {
  const files = outputFiles(root).map((file) => ({
    file,
    sha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("hex"),
  }));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return { fingerprint, files };
}
export function writeWebRelease(root, kind) {
  if (!["erp", "storefront"].includes(kind))
    throw new Error("WEB_RELEASE_KIND_INVALID");
  const release = { schema: 1, kind, ...webReleaseFingerprint(root) };
  fs.writeFileSync(
    path.join(root, "release.json"),
    JSON.stringify(release, null, 2) + "\n",
  );
  return release;
}
export function readWebRelease(root, expectedKind) {
  const release = JSON.parse(
    fs.readFileSync(path.join(root, "release.json"), "utf8"),
  );
  if (release.schema !== 1 || release.kind !== expectedKind)
    throw new Error("WEB_RELEASE_KIND_INVALID");
  const actual = webReleaseFingerprint(root);
  if (
    release.fingerprint !== actual.fingerprint ||
    JSON.stringify(release.files) !== JSON.stringify(actual.files)
  ) {
    throw new Error("WEB_RELEASE_CONTENT_MISMATCH");
  }
  for (const file of [
    "index.html",
    "sw.js",
    "manifest.webmanifest",
    ".vite/manifest.json",
    "push-handler.js",
    "pwa-update-worker.js",
  ]) {
    if (!actual.files.some((entry) => entry.file === file))
      throw new Error(`WEB_RELEASE_INCOMPLETE:${file}`);
  }
  return release;
}

/** Runtime source graph, including lazy public pages, is the only Tailwind scan input. */
export async function storefrontRuntimeSources(root) {
  const { build } = await import("esbuild");
  const graph = await build({
    absWorkingDir: root,
    entryPoints: ["client/src/storefront-main.tsx"],
    bundle: true,
    write: false,
    metafile: true,
    packages: "external",
    platform: "browser",
    logLevel: "silent",
    plugins: [
      {
        name: "runtime-css-graph",
        setup(builder) {
          builder.onResolve(
            { filter: /\.(css|png|svg|woff2|webp|jpg)(\?.*)?$/ },
            (args) => ({ path: args.path, external: true }),
          );
          builder.onResolve({ filter: /^virtual:/ }, (args) => ({
            path: args.path,
            external: true,
          }));
        },
      },
    ],
  });
  const sources = Object.keys(graph.metafile.inputs)
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => path.resolve(root, file))
    .sort();
  const forbidden = sources.find((file) =>
    /\/client\/src\/(?:App\.tsx|components\/(?:AppLayout|CommandPalette)\.tsx|lib\/(?:productStudio|realtime\/financialQueries))/.test(
      file.replace(/\\/g, "/"),
    ),
  );
  if (forbidden)
    throw new Error(`STOREFRONT_RUNTIME_ERP_IMPORT_FORBIDDEN:${forbidden}`);
  return sources;
}

export async function buildWeb() {
  const { build } = await import("vite");
  const { verifyStorefrontPwaBuild } =
    await import("./verify-storefront-pwa-build.mjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const previous = process.env.WEB_BUILD_TARGET;
  try {
    for (const target of ["erp", "storefront"]) {
      process.env.WEB_BUILD_TARGET = target;
      await build({ logLevel: "warn" });
      const output = path.join(
        root,
        "dist",
        target === "erp" ? "public" : "storefront",
      );
      if (target === "storefront") verifyStorefrontPwaBuild(output);
      const release = writeWebRelease(output, target);
      readWebRelease(output, target);
      console.log(
        `web release ${target}: ${release.fingerprint} (${release.files.length} files)`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.WEB_BUILD_TARGET;
    else process.env.WEB_BUILD_TARGET = previous;
  }
}
