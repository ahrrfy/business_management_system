import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash } from "node:crypto";
// @ts-expect-error Shared builtin-only deployment journal has no declaration file.
import { activeInventoryManifest } from "../../scripts/lib/inventory-activation-journal.mjs";

// Compiled into both immutable worker bundles; never supplied by environment.
export const INVENTORY_BOOT_CAPABILITY = "inventory-projection-v1-fenced-boot";
type Identity = { database: string; serverUuid: string };
type Artifact = {
  name: string;
  bundle: string;
  script: string;
  hash: string;
  instances: number;
};
type Journal = {
  version: number;
  id: string;
  phase: string;
  database: string;
  serverUuid: string;
  nonce: string;
  commit: string;
  artifacts: Artifact[];
  priorArtifacts?: Artifact[];
};

function readJournal(file: string): Journal {
  const s = fs.lstatSync(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.size > 65536 ||
    (process.platform !== "win32" && (s.mode & 0o777) !== 0o600)
  )
    throw new Error("INVENTORY_BOOT_JOURNAL_UNTRUSTED");
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
  if (
    j.version !== 1 ||
    !j.id ||
    !/^[a-f0-9]{64}$/.test(j.nonce) ||
    !/^[a-f0-9]{40}$/.test(j.commit) ||
    !Array.isArray(j.artifacts)
  )
    throw new Error("INVENTORY_BOOT_JOURNAL_INVALID");
  return j;
}
function confirmDurableRelease(file: string) {
  // Readers cannot observe the rename and outrun the controller's directory
  // fsync. A reader also makes the already-fsynced file rename durable itself.
  if (process.platform !== "win32") {
    const fd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Called before HTTP/listen, self-heal, restore sweep, jobs or bridge ingress.
 * Only a private per-process read-only attestation socket exists while held. */
export async function awaitInventoryActivationRelease(options: {
  name: "erp-server" | "erp-hr-bridge";
  bundle: string;
  readIdentity: () => Promise<Identity>;
  onHold?: () => void;
  onRelease?: () => void;
  journalFile?: string;
  // Dependency injection for platform-independent transport tests. Production
  // entrypoints never supply this: Linux PID identity and 0600 socket are fixed.
  transport?: {
    startTime: string;
    socketPath: string;
    protectSocket: () => void;
  };
}): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const file =
    options.journalFile ??
    path.join(os.homedir(), ".pm2", "erp-inventory-activation.json");
  const original = readJournal(file); // Missing journal cannot imply permission.
  const bundle = fs.realpathSync(options.bundle);
  const hash = createHash("sha256")
    .update(fs.readFileSync(bundle))
    .digest("hex");
  const active = activeInventoryManifest(original) as {
    artifacts: Artifact[];
  } | null;
  if (original.phase === "ROLLED_BACK" && !active)
    throw new Error("INVENTORY_BOOT_ACTIVE_MANIFEST_REQUIRED");
  const artifacts = active?.artifacts ?? original.artifacts;
  // A released artifact may be copied by the existing rollback preflight.
  // Held candidates still require the exact immutable path as well as its hash.
  if (
    !artifacts?.some(
      (a) =>
        a.name === options.name &&
        (a.bundle === bundle ||
          ["RELEASED", "ROLLED_BACK"].includes(original.phase)) &&
        a.hash === hash,
    )
  )
    throw new Error("INVENTORY_BOOT_ARTIFACT_MISMATCH");
  const verifyIdentity = async () => {
    const actual = await options.readIdentity();
    if (
      actual.database !== original.database ||
      actual.serverUuid !== original.serverUuid
    )
      throw new Error("INVENTORY_BOOT_DATABASE_MISMATCH");
    return actual;
  };
  await verifyIdentity();
  if (["RELEASED", "ROLLED_BACK"].includes(original.phase)) {
    confirmDurableRelease(file);
    return;
  }
  if (!["READY", "CANDIDATES", "PRE_RELEASE"].includes(original.phase))
    throw new Error("INVENTORY_BOOT_PHASE_REFUSED");
  if (process.platform !== "linux" && !options.transport)
    throw new Error("INVENTORY_BOOT_PLATFORM_UNSUPPORTED");
  const startTime =
    options.transport?.startTime ??
    fs
      .readFileSync(`/proc/${process.pid}/stat`, "utf8")
      .split(/\) /)
      .at(-1)!
      .split(" ")[19];
  const socketPath =
    options.transport?.socketPath ??
    path.join(path.dirname(file), `ia-${process.pid}.sock`);
  if (Buffer.byteLength(socketPath) > 100 || fs.existsSync(socketPath))
    throw new Error("INVENTORY_BOOT_SOCKET_UNSAFE");
  const server = net.createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.pause();
      void (async () => {
        const request = JSON.parse(input);
        const now = readJournal(file);
        if (
          now.id !== original.id ||
          now.nonce !== original.nonce ||
          request.nonce !== now.nonce ||
          !/^[a-f0-9]{64}$/.test(request.challenge)
        )
          throw new Error("INVENTORY_BOOT_CHALLENGE_REFUSED");
        const actual = await verifyIdentity();
        socket.end(
          JSON.stringify({
            ...actual,
            pid: process.pid,
            startTime,
            name: options.name,
            bundle,
            hash,
            capability: INVENTORY_BOOT_CAPABILITY,
            activationId: original.id,
            challenge: request.challenge,
            held: true,
          }) + "\n",
        );
      })().catch(() => socket.destroy());
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      if (options.transport) options.transport.protectSocket();
      else fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  options.onHold?.();
  try {
    for (;;) {
      const now = readJournal(file);
      if (now.id !== original.id || now.nonce !== original.nonce)
        throw new Error("INVENTORY_BOOT_JOURNAL_CHANGED");
      if (now.phase === "RELEASED") {
        activeInventoryManifest(now);
        confirmDurableRelease(file);
        await verifyIdentity();
        break;
      }
      if (!["READY", "CANDIDATES", "PRE_RELEASE"].includes(now.phase))
        throw new Error("INVENTORY_BOOT_RELEASE_REFUSED");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  }
  options.onRelease?.();
}
