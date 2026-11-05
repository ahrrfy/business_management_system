import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Deliberately not a configurable recovery framework. */
export const INCIDENT = Object.freeze({
  key: "DIGITAL-10324087-001172",
  amount: "250000.00",
  bankReference: "10324087",
  providerReference: "001172",
  method: "CARD",
});
const id = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.string().regex(/^\d+\.\d{2}$/);
const evidence = z
  .object({
    kind: z.enum([
      "BANK",
      "PROVIDER_ISSUE",
      "ORIGINAL_PRICE",
      "ORIGINAL_FUNDING",
      "SETTLEMENT_REVIEW",
    ]),
    path: z.string().min(1),
    sha256: sha,
  })
  .strict();
export const incidentManifestSchema = z
  .object({
    version: z.literal(1),
    incident: z.literal(INCIDENT.key),
    bankReference: z.literal(INCIDENT.bankReference),
    providerReference: z.literal(INCIDENT.providerReference),
    amount: z.literal(INCIDENT.amount),
    paymentMethod: z.literal("CARD"),
    database: z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9_]+$/),
        serverUuid: z.string().uuid(),
      })
      .strict(),
    authorityUserId: id,
    branchId: id,
    offeringId: id,
    priceVersionId: id,
    providerId: id,
    originalProviderShare: amount,
    fundingMode: z.enum(["PREPAID", "POSTPAID"]),
    walletId: id.nullable(),
    originalOperatorId: id,
    customerId: id.nullable(),
    originalShiftId: id,
    postingShiftId: id,
    sourceType: z.enum(["POS", "RECEPTION"]),
    executedAt: z.string().datetime(),
    deviceId: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(20).max(500),
    priorProviderSettlement: z.literal("NOT_RECORDED"),
    attestedEarlierBankCharge: z.literal(true),
    attestedEarlierProviderIssue: z.literal(true),
    evidence: z.array(evidence).min(5).max(20),
  })
  .strict()
  .superRefine((m, ctx) => {
    if ((m.fundingMode === "PREPAID") !== (m.walletId !== null))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Funding mode requires its original wallet identity",
      });
    for (const kind of [
      "BANK",
      "PROVIDER_ISSUE",
      "ORIGINAL_PRICE",
      "ORIGINAL_FUNDING",
      "SETTLEMENT_REVIEW",
    ])
      if (!m.evidence.some((item) => item.kind === kind))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing ${kind} evidence`,
        });
  });
export type IncidentManifest = z.infer<typeof incidentManifestSchema>;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function incidentFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Local files only; neither network paths nor URL-bearing evidence is fetched. */
export async function loadIncidentManifest(
  manifestPath: string,
): Promise<IncidentManifest> {
  const absolute = await realpath(manifestPath);
  const parsed: unknown = JSON.parse(await readFile(absolute, "utf8"));
  const manifest = incidentManifestSchema.parse(parsed);
  const seen = new Set<string>();
  for (const item of manifest.evidence) {
    if (/^(?:[a-z]+:\/\/|\\\\|\/\/)/i.test(item.path))
      throw new Error("Evidence must use local file paths");
    const target = await realpath(
      path.resolve(path.dirname(absolute), item.path),
    );
    if (/^(?:\\\\|\/\/)/.test(target))
      throw new Error("Evidence must use local file paths");
    if (seen.has(target.toLowerCase()))
      throw new Error("Evidence paths must be distinct");
    seen.add(target.toLowerCase());
    if (!(await stat(target)).isFile())
      throw new Error("Evidence must be a regular file");
    const actual = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    if (actual !== item.sha256) throw new Error("Evidence SHA256 mismatch");
  }
  return manifest;
}

/** Reject before opening a connection. Production needs intentional opt-in;
 * both dry-run and apply additionally verify the manifest's live DB identity. */
export function assertIncidentTarget(
  raw: string | undefined,
  _apply: boolean,
  production: boolean,
): void {
  if (!raw) throw new Error("DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid database target");
  }
  if (url.protocol !== "mysql:")
    throw new Error("Expected MySQL database target");
  const name = decodeURIComponent(url.pathname.slice(1));
  const local =
    url.hostname === "127.0.0.1" &&
    url.port === "3311" &&
    /^erp_digital_incident_[a-z0-9_]+_test$/.test(name);
  if (!local && !production)
    throw new Error(
      "Unsafe target: only the isolated incident _test database on 127.0.0.1:3311 is enabled by default",
    );
  if (url.port === "3306" || url.port === "3310" || !url.port)
    throw new Error("Forbidden database port");
}
