/** Run with node --import tsx scripts/remediate-digital-incident.mts --manifest <local.json>. */
import "dotenv/config";
import { assertIncidentTarget } from "../server/services/digitalCards/incidentRecoveryContract";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Dry-run: --manifest <file> [--production]\nApply: --manifest <same-file> --apply --fingerprint <dry-run-sha256> [--production]\nOnly CARD 250000.00 IQD; bank 10324087; issued card 001172. No new charge or issuance.",
    );
    return;
  }
  let manifest: string | undefined, fingerprint: string | undefined;
  let apply = false,
    production = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error("CLI: duplicate option");
    seen.add(flag);
    if (flag === "--apply") apply = true;
    else if (flag === "--production") production = true;
    else if (flag === "--manifest" || flag === "--fingerprint") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error("CLI: missing option value");
      if (flag === "--manifest") manifest = value;
      else fingerprint = value;
    } else throw new Error("CLI: unknown option");
  }
  if (!manifest || (apply && !fingerprint) || (!apply && fingerprint))
    throw new Error(
      "CLI: supply manifest; apply additionally requires the exact dry-run fingerprint",
    );
  assertIncidentTarget(process.env.DATABASE_URL, apply, production);
  const { planIncidentRecovery, applyIncidentRecovery } =
    await import("../server/services/digitalCards/incidentRecoveryService");
  try {
    const result = apply
      ? await applyIncidentRecovery(manifest, fingerprint!, { production })
      : await planIncidentRecovery(manifest, { production });
    console.log(
      JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", ...result }, null, 2),
    );
    if ("conflicts" in result && result.conflicts.length) process.exitCode = 2;
  } finally {
    const { closeDb } = await import("../server/db");
    await closeDb();
  }
}
main().catch((error: unknown) => {
  // Never print SQL, credential-bearing URLs, free customer data, or evidence contents.
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^(Incident recovery refused:|CLI:|Unsafe target:|Forbidden database port|Evidence |DATABASE_URL is required|Invalid database target|Expected MySQL database target)/.test(
      message,
    )
      ? message
      : "Incident recovery failed closed. Verify the manifest, evidence, database identity and canonical service prerequisites.",
  );
  process.exitCode = 1;
});
