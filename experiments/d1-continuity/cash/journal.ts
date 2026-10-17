import {
  applyCashPlan,
  prepareCashSale,
  readCashCommand,
  CASH_SCHEMA_VERSION,
  canonicalCashJson,
} from "./actual";

export const LAB_ID = "actual-cash-20261017";
// fixtureSql advances the empty lab epoch once; every later writer is a cash plan.
export const CASH_BASELINE_EPOCH = 1;
const prefixPending = () =>
  failure("RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST", 409);
export const canonical = canonicalCashJson;
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
export const digest = async (v: any) =>
  hex(await crypto.subtle.digest("SHA-256", bytes(canonical(v))));
export function failure(code: string, status = 503) {
  return Object.assign(new Error(code), { code, status });
}
export const primary = (db: any) =>
  db.withSession ? db.withSession("first-primary") : db;
const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
export const identitySql = (role: "primary" | "restore") =>
  `CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL); INSERT INTO cashSandboxIdentity VALUES('${LAB_ID}','${role}');`;
export async function assertIdentity(db: any, role: string) {
  const row = await db
    .prepare(
      `SELECT role FROM ${role === "journal" ? "cashJournalIdentity" : "cashSandboxIdentity"} WHERE id=?`,
    )
    .bind(LAB_ID)
    .first();
  if (row?.role !== role) throw failure("SANDBOX_IDENTITY_MISMATCH");
}
const unsigned = (r: any) => ({
  version: r.version,
  labId: r.labId,
  schemaVersion: r.schemaVersion,
  requestId: r.requestId,
  envelopeHash: r.envelopeHash,
  planHash: r.planHash,
  epoch: r.epoch,
  plan: r.plan,
});
async function sign(secret: string, r: any) {
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      await key(secret),
      bytes(canonical(unsigned(r))),
    ),
  );
}
export async function verifyRecord(secret: string, r: any) {
  if (
    !r ||
    r.version !== 1 ||
    r.labId !== LAB_ID ||
    r.schemaVersion !== CASH_SCHEMA_VERSION ||
    typeof r.requestId !== "string" ||
    r.requestId !== r.plan?.requestId ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch !== r.plan?.expectedEpoch + 1 ||
    !/^\w[\w:-]{7,99}$/.test(r.requestId) ||
    !/^[a-f0-9]{64}$/.test(r.signature ?? "") ||
    r.planHash !== (await digest(r.plan)) ||
    r.envelopeHash !== (await digest(r.plan.request))
  )
    throw failure("INVALID_RECOVERY_RECORD", 400);
  const signature = Uint8Array.from(r.signature.match(/../g), (h: any) =>
    parseInt(h, 16),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      signature,
      bytes(canonical(unsigned(r))),
    ))
  )
    throw failure("RECOVERY_SIGNATURE_MISMATCH", 400);
}

async function reserveRequest(log: any, id: string, envelope: any) {
  const hash = await digest(envelope),
    json = canonical(envelope);
  await log
    .prepare(
      "INSERT INTO cashJournalRequests VALUES(?,?,?) ON CONFLICT(requestId) DO NOTHING",
    )
    .bind(id, hash, json)
    .run();
  const row = await log
    .prepare(
      "SELECT envelopeHash,envelopeJson FROM cashJournalRequests WHERE requestId=?",
    )
    .bind(id)
    .first();
  if (row?.envelopeHash !== hash || row.envelopeJson !== json)
    throw failure("IDEMPOTENCY_PAYLOAD_MISMATCH", 409);
  return hash;
}
async function prepareRecord(log: any, plan: any) {
  const hash = await digest(plan),
    json = canonical(plan);
  await log
    .prepare(
      "INSERT INTO cashJournalAttempts VALUES(?,?,?,?) ON CONFLICT(planHash) DO NOTHING",
    )
    .bind(hash, plan.requestId, plan.expectedEpoch + 1, json)
    .run();
  const row = await log
    .prepare("SELECT planJson FROM cashJournalAttempts WHERE planHash=?")
    .bind(hash)
    .first();
  if (row?.planJson !== json) throw failure("RECOVERY_PREPARE_MISMATCH");
  return hash;
}
async function confirm(
  log: any,
  secret: string,
  envelopeHash: string,
  plan: any,
) {
  // A winner may have committed in a competing request. Store its exact plan,
  // never the losing candidate. Successful responses require this durable ACK.
  const planHash = await prepareRecord(log, plan);
  const record = {
    version: 1,
    labId: LAB_ID,
    schemaVersion: CASH_SCHEMA_VERSION,
    requestId: plan.requestId,
    envelopeHash,
    planHash,
    epoch: plan.expectedEpoch + 1,
    plan,
  };
  const recordJson = canonical(record),
    signature = await sign(secret, record);
  // The next-epoch check and append are ONE SQLite statement. Concurrent
  // finalizers can copy the same winner, but cannot acknowledge a later gap.
  await log
    .prepare(
      "INSERT INTO cashJournalCommitted SELECT ?,?,?,?,? WHERE ?=COALESCE((SELECT MAX(epoch) FROM cashJournalCommitted),?)+1 ON CONFLICT(requestId) DO NOTHING",
    )
    .bind(
      plan.requestId,
      planHash,
      record.epoch,
      recordJson,
      signature,
      record.epoch,
      CASH_BASELINE_EPOCH,
    )
    .run();
  const row = await log
    .prepare(
      "SELECT recordJson,signature FROM cashJournalCommitted WHERE requestId=?",
    )
    .bind(plan.requestId)
    .first();
  if (!row) throw prefixPending();
  if (row.recordJson !== recordJson || row.signature !== signature)
    throw failure("RECOVERY_ACK_MISMATCH");
  return { ...record, signature };
}

async function journalPrefix(log: any) {
  const row = await log
    .prepare(
      "SELECT MAX(epoch) AS epoch,MIN(epoch) AS firstEpoch,COUNT(*) AS count FROM cashJournalCommitted",
    )
    .first();
  const epoch = row.epoch ?? CASH_BASELINE_EPOCH;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < CASH_BASELINE_EPOCH ||
    row.count !== epoch - CASH_BASELINE_EPOCH ||
    (row.count && row.firstEpoch !== CASH_BASELINE_EPOCH + 1)
  )
    throw failure("RECOVERY_PREFIX_INVALID");
  return epoch;
}
async function repairNextWinner(
  db: any,
  log: any,
  secret: string,
  prefix: number,
) {
  // Only the atomic primary command + outbox prove a winner. PREPARED journal
  // attempts are intentionally never used as commit evidence.
  const rows = await db
    .prepare(
      `SELECT c.* FROM cashCommands c JOIN cashOutbox o ON o.requestId=c.requestId AND o.payload=c.planJson AND o.planHash=c.planHash WHERE json_extract(c.planJson,'$.expectedEpoch')=? LIMIT 2`,
    )
    .bind(prefix)
    .all();
  if (rows.results.length !== 1) throw failure("RECOVERY_WINNER_UNAVAILABLE");
  const row = rows.results[0],
    plan = JSON.parse(row.planJson);
  if (
    plan.expectedEpoch !== prefix ||
    plan.requestId !== row.requestId ||
    canonical(plan) !== row.planJson ||
    canonical(plan.request) !== row.requestJson ||
    canonical(plan.result) !== row.resultJson ||
    plan.requestHash !== row.requestHash ||
    (await digest(plan)) !== row.planHash ||
    (await digest(plan.request)) !== row.requestHash
  )
    throw failure("RECOVERY_WINNER_MISMATCH");
  const envelopeHash = await reserveRequest(log, plan.requestId, plan.request);
  return confirm(log, secret, envelopeHash, plan);
}

export async function createWithRecovery(
  env: any,
  input: any,
  actor: any,
  fault = "",
) {
  const db = primary(env.DB),
    log = primary(env.RECOVERY_LOG);
  await assertIdentity(db, "primary");
  if (fault === "log-unavailable") throw failure("RECOVERY_LOG_UNAVAILABLE");
  await assertIdentity(log, "journal");
  const id = input?.clientRequestId;
  if (typeof id !== "string" || !/^\w[\w:-]{7,99}$/.test(id))
    throw failure("INVALID_REQUEST_ID", 400);
  const envelope = { input, actor };
  const envelopeHash = await reserveRequest(log, id, envelope);
  let winning = await readCashCommand(db, id),
    replayed = !!winning,
    record: any;
  const prefix = await journalPrefix(log);
  const target = winning
    ? winning.plan.expectedEpoch + 1
    : (await db.prepare("SELECT epoch FROM cashEpoch WHERE id=1").first())
        ?.epoch;
  if (
    !Number.isSafeInteger(target) ||
    target < CASH_BASELINE_EPOCH ||
    (prefix > target && !winning)
  )
    throw failure("RECOVERY_PRIMARY_EPOCH_INVALID");
  if (prefix < target) {
    // Repair at most ONE missing winner, and never combine a repair with a new
    // financial sale in this invocation (D1 Free: 50 queries/invocation).
    record = await repairNextWinner(db, log, env.LAB_TOKEN, prefix);
    if (!winning || record.requestId !== id || record.epoch !== target)
      throw prefixPending();
  }
  for (let attempt = 0; !winning && attempt < 1; attempt++) {
    const prepared = await prepareCashSale(db, input, actor);
    await prepareRecord(log, prepared.plan);
    if (fault === "after-prepare") throw failure("PREPARED_PRIMARY_ABSENT");
    try {
      await applyCashPlan(db, prepared.plan, {
        fault: fault === "last-statement",
      });
    } catch (error: any) {
      winning = await readCashCommand(db, id);
      if (winning) {
        replayed = true;
        break;
      }
      // Only a proven epoch change permits recalculation; SQL/business failures
      // with the original epoch are surfaced and remain unacknowledged.
      const row = await db
        .prepare("SELECT epoch FROM cashEpoch WHERE id=1")
        .first();
      if (
        row?.epoch === prepared.plan.expectedEpoch ||
        fault === "last-statement"
      )
        throw error;
      throw failure("STALE_SNAPSHOT_RETRY_SAME_REQUEST", 409);
    }
    winning = await readCashCommand(db, id);
    break;
  }
  if (!winning) throw failure("PRIMARY_COMMIT_UNCERTAIN");
  if (canonical(winning.request) !== canonical(envelope))
    throw failure("PRIMARY_REQUEST_MISMATCH", 409);
  if (fault === "after-primary")
    throw failure("PRIMARY_COMMITTED_RECOVERY_PENDING");
  record ??= await confirm(log, env.LAB_TOKEN, envelopeHash, winning.plan);
  if (fault === "drop-response")
    throw failure("RESPONSE_LOST_AFTER_BOTH_COMMITS");
  return {
    ...winning.result,
    idempotentReplay: replayed,
    recoveryAcknowledged: true,
    recoveryEpoch: record.epoch,
    clientRequestId: id,
  };
}

export async function committedRecords(logBinding: any) {
  const log = primary(logBinding);
  await assertIdentity(log, "journal");
  await journalPrefix(log);
  const rows = await log
    .prepare(
      "SELECT recordJson,signature FROM cashJournalCommitted ORDER BY epoch",
    )
    .all();
  return rows.results.map((r: any) => ({
    ...JSON.parse(r.recordJson),
    signature: r.signature,
  }));
}
export async function restoreRecords(env: any, records: any[]) {
  const db = primary(env.DB);
  await assertIdentity(db, "restore");
  if (!Array.isArray(records) || records.length !== 1)
    throw failure("RECOVERY_ONE_SALE_PER_REQUEST", 400);
  // One full sale per request bounds D1 free invocation queries. Files are
  // replayed as separate atomic sales and resume with the original request IDs.
  for (let i = 0; i < records.length; i++) {
    await verifyRecord(env.LAB_TOKEN, records[i]);
    if (i && records[i].epoch !== records[i - 1].epoch + 1)
      throw failure("RECOVERY_SEQUENCE_GAP", 400);
  }
  let applied = 0,
    replayed = 0;
  for (const record of records) {
    const existing = await readCashCommand(db, record.requestId);
    if (existing) {
      if (
        (await digest(existing.plan)) !== record.planHash ||
        canonical(existing.result) !== canonical(record.plan.result)
      )
        throw failure("RECOVERY_EXISTING_COMMAND_MISMATCH", 409);
      replayed++;
      continue;
    }
    try {
      await applyCashPlan(db, record.plan);
      applied++;
    } catch {
      throw failure("RECOVERY_PREIMAGE_OR_EPOCH_CONFLICT", 409);
    }
  }
  return {
    applied,
    replayed,
    records: records.length,
    journalBindingPresent: !!env.RECOVERY_LOG,
  };
}
