import {
  applyCashPlan,
  prepareCashSale,
  readCashCommand,
  CASH_SCHEMA_VERSION,
  canonicalCashJson,
  cashCommandFromRow,
} from "./actual";

import { LAB_ID } from "./identity";
import { MAX_PAGE_BYTES, RECOVERY_PAGE_OVERHEAD } from "./recovery-limits";
export { LAB_ID } from "./identity";
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
let importedKey: { secret: string; value: Promise<CryptoKey> } | undefined;
const key = (secret: string) => {
  if (importedKey?.secret === secret) return importedKey.value;
  const value = crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  importedKey = { secret, value };
  return value;
};
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
  const results = await log.batch([
    log
      .prepare(
        "INSERT INTO cashJournalRequests VALUES(?,?,?) ON CONFLICT(requestId) DO NOTHING",
      )
      .bind(id, hash, json),
    log
      .prepare(
        "SELECT envelopeHash,envelopeJson FROM cashJournalRequests WHERE requestId=?",
      )
      .bind(id),
  ]);
  const row = results[1].results[0];
  if (row?.envelopeHash !== hash || row.envelopeJson !== json)
    throw failure("IDEMPOTENCY_PAYLOAD_MISMATCH", 409);
  return hash;
}
async function prepareRecord(
  log: any,
  plan: any,
  envelope?: any,
  guarded = false,
) {
  const hash = await digest(plan),
    json = canonical(plan);
  // Reject before PREPARED/primary writes if the future acknowledged record
  // could not be exported intact by the independent recovery page protocol.
  const future = {
    version: 1,
    labId: LAB_ID,
    schemaVersion: CASH_SCHEMA_VERSION,
    requestId: plan.requestId,
    envelopeHash: await digest(plan.request),
    planHash: hash,
    epoch: plan.expectedEpoch + 1,
    plan,
    signature: "0".repeat(64),
  };
  const command = {
    requestId: plan.requestId,
    requestHash: plan.requestHash,
    requestJson: canonical(plan.request),
    resultJson: canonical(plan.result),
    planJson: json,
    planHash: hash,
  };
  const outbox = {
    eventId: plan.outbox.eventId,
    requestId: plan.requestId,
    payload: json,
    planHash: hash,
  };
  if (
    [future, command, outbox].some(
      (row) =>
        new TextEncoder().encode(JSON.stringify(row)).byteLength +
          RECOVERY_PAGE_OVERHEAD >
        MAX_PAGE_BYTES,
    )
  )
    throw failure("RECOVERY_RECORD_TOO_LARGE", 422);
  const reservation = envelope
    ? { hash: await digest(envelope), json: canonical(envelope) }
    : null;
  // A lookahead invocation has already read the primary. These conditions
  // replace its separate journal preflight, without trusting cached identity
  // or prefix. Gate BOTH inserts even when matching rows already exist.
  const eligible =
    "EXISTS(SELECT 1 FROM cashJournalIdentity WHERE id=? AND role='journal') AND EXISTS(SELECT 1 FROM (" +
    prefixSql +
    ") p WHERE p.epoch=? AND p.guards=6 AND p.lastEpoch=p.epoch AND p.count=p.epoch-1 AND (p.count=0 OR p.firstEpoch=2))";
  const results = await log.batch([
    ...(guarded
      ? [
          log
            .prepare("SELECT role FROM cashJournalIdentity WHERE id=?")
            .bind(LAB_ID),
          log.prepare(prefixSql),
        ]
      : []),
    ...(reservation
      ? [
          log
            .prepare(
              guarded
                ? "INSERT INTO cashJournalRequests SELECT ?,?,? WHERE " +
                    eligible +
                    " ON CONFLICT(requestId) DO NOTHING"
                : "INSERT INTO cashJournalRequests VALUES(?,?,?) ON CONFLICT(requestId) DO NOTHING",
            )
            .bind(
              plan.requestId,
              reservation.hash,
              reservation.json,
              ...(guarded ? [LAB_ID, plan.expectedEpoch] : []),
            ),
          log
            .prepare(
              "SELECT envelopeHash,envelopeJson FROM cashJournalRequests WHERE requestId=?",
            )
            .bind(plan.requestId),
        ]
      : []),
    log
      .prepare(
        reservation
          ? "INSERT INTO cashJournalAttempts SELECT ?,?,?,? WHERE " +
              (guarded ? eligible + " AND " : "") +
              "EXISTS(SELECT 1 FROM cashJournalRequests WHERE requestId=? AND envelopeHash=? AND envelopeJson=?) ON CONFLICT(planHash) DO NOTHING"
          : "INSERT INTO cashJournalAttempts VALUES(?,?,?,?) ON CONFLICT(planHash) DO NOTHING",
      )
      .bind(
        hash,
        plan.requestId,
        plan.expectedEpoch + 1,
        json,
        ...(guarded ? [LAB_ID, plan.expectedEpoch] : []),
        ...(reservation
          ? [plan.requestId, reservation.hash, reservation.json]
          : []),
      ),
    log
      .prepare("SELECT planJson FROM cashJournalAttempts WHERE planHash=?")
      .bind(hash),
  ]);
  if (guarded) {
    try {
      if (results[0].results[0]?.role !== "journal")
        throw failure("SANDBOX_IDENTITY_MISMATCH");
      if (checkedPrefix(results[1].results[0]) !== plan.expectedEpoch)
        throw prefixPending();
    } catch (error: any) {
      // Invalid proofs cannot be converted into an unconditional reservation.
      error.skipReservation = true;
      throw error;
    }
  }
  const offset = guarded ? 2 : 0;
  if (reservation) {
    const row = results[offset + 1].results[0];
    if (
      row?.envelopeHash !== reservation.hash ||
      row.envelopeJson !== reservation.json
    )
      throw failure("IDEMPOTENCY_PAYLOAD_MISMATCH", 409);
  }
  const row = results[offset + (reservation ? 3 : 1)].results[0];
  if (row?.planJson !== json) throw failure("RECOVERY_PREPARE_MISMATCH");
  return Object.freeze({ hash, json, envelopeHash: reservation?.hash });
}
async function confirm(
  log: any,
  secret: string,
  envelopeHash: string,
  plan: any,
  preparedProof?: { hash: string; json: string },
) {
  // A winner may have committed in a competing request. Store its exact plan,
  // never the losing candidate. Successful responses require this durable ACK.
  const planHash = await digest(plan);
  if (
    preparedProof?.hash !== planHash ||
    preparedProof.json !== canonical(plan)
  )
    await prepareRecord(log, plan);
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
  const results = await log.batch([
    log
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
      ),
    log
      .prepare(
        "SELECT recordJson,signature FROM cashJournalCommitted WHERE requestId=?",
      )
      .bind(plan.requestId),
  ]);
  const row = results[1].results[0];
  if (!row) throw prefixPending();
  if (row.recordJson !== recordJson || row.signature !== signature)
    throw failure("RECOVERY_ACK_MISMATCH");
  return { ...record, signature };
}

const prefixSql =
  "SELECT epoch,committedCount AS count,(SELECT MIN(epoch) FROM cashJournalCommitted) AS firstEpoch,COALESCE((SELECT MAX(epoch) FROM cashJournalCommitted),1) AS lastEpoch,(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN('cashJournalCommitted_no_update','cashJournalCommitted_no_delete','cashJournalCommitted_contiguous','cashJournalCommitted_advance_head','cashJournalHead_guard','cashJournalHead_no_delete')) AS guards FROM cashJournalHead WHERE id=1";
function checkedPrefix(row: any): number {
  if (!row || row.guards !== 6 || row.lastEpoch !== row.epoch)
    throw failure("RECOVERY_PREFIX_INVALID");
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
async function journalPrefix(log: any) {
  return checkedPrefix(await log.prepare(prefixSql).first());
}
export async function recoveryReadiness(env: any) {
  const db = primary(env.DB),
    log = primary(env.RECOVERY_LOG);
  const [source, journal] = await Promise.all([
    db.batch([
      db
        .prepare("SELECT role FROM cashSandboxIdentity WHERE id=?")
        .bind(LAB_ID),
      db.prepare("SELECT epoch FROM cashEpoch WHERE id=1"),
    ]),
    log.batch([
      log
        .prepare("SELECT role FROM cashJournalIdentity WHERE id=?")
        .bind(LAB_ID),
      log.prepare(prefixSql),
    ]),
  ]);
  if (
    source[0].results[0]?.role !== "primary" ||
    journal[0].results[0]?.role !== "journal"
  )
    throw failure("SANDBOX_IDENTITY_MISMATCH");
  const epoch = source[1].results[0]?.epoch;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch !== checkedPrefix(journal[1].results[0])
  )
    throw prefixPending();
  return { epoch };
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
  strategy?: {
    primaryPreflight(db: any, input: any, actor: any): Promise<any>;
    prepare(db: any, input: any, actor: any, snapshot: any): Promise<any>;
  },
) {
  const db = primary(env.DB),
    log = primary(env.RECOVERY_LOG);
  const id = input?.clientRequestId;
  if (typeof id !== "string" || !/^\w[\w:-]{7,99}$/.test(id))
    throw failure("INVALID_REQUEST_ID", 400);
  const envelope = { input, actor };
  const ahead = strategy ? env.CREDIT_READAHEAD : undefined;
  if (
    ahead &&
    (ahead.envelope !== canonical(envelope) ||
      ahead.generation !== env.CREDIT_HANDOFF?.generation)
  )
    throw failure("LOOKAHEAD_ENVELOPE_OR_GENERATION_MISMATCH");
  const guarded = !!ahead && !ahead.state.state[1].results[0];
  // Default callers check both read-only preflights first. The credit
  // lookahead path checks journal proofs in its conditionally writable batch.
  const states = await Promise.allSettled([
    ahead
      ? Promise.resolve(ahead.state)
      : strategy
        ? strategy.primaryPreflight(db, input, actor)
        : db.batch([
            db
              .prepare("SELECT role FROM cashSandboxIdentity WHERE id=?")
              .bind(LAB_ID),
            db.prepare("SELECT * FROM cashCommands WHERE requestId=?").bind(id),
            db.prepare("SELECT epoch FROM cashEpoch WHERE id=1"),
          ]),
    fault === "log-unavailable"
      ? Promise.reject(failure("RECOVERY_LOG_UNAVAILABLE"))
      : guarded
        ? Promise.resolve(null)
        : log.batch([
            log
              .prepare("SELECT role FROM cashJournalIdentity WHERE id=?")
              .bind(LAB_ID),
            log.prepare(prefixSql),
          ]),
  ]);
  if (states[0].status === "rejected") throw states[0].reason;
  const primaryState = strategy ? states[0].value.state : states[0].value;
  if (primaryState[0].results[0]?.role !== "primary")
    throw failure("SANDBOX_IDENTITY_MISMATCH");
  if (states[1].status === "rejected") throw states[1].reason;
  const journalState = states[1].value;
  if (!guarded && journalState![0].results[0]?.role !== "journal")
    throw failure("SANDBOX_IDENTITY_MISMATCH");
  let envelopeHash: string;
  let winning = cashCommandFromRow(primaryState[1].results[0]),
    replayed = !!winning,
    record: any,
    preparedProof: { hash: string; json: string } | undefined,
    provenNewCommit = false;
  const target = winning
    ? winning.plan.expectedEpoch + 1
    : primaryState[2].results[0]?.epoch;
  const prefix = guarded ? target : checkedPrefix(journalState![1].results[0]);
  const merged = !!strategy && !winning && prefix === target;
  if (!merged) envelopeHash = await reserveRequest(log, id, envelope);
  if (!Number.isSafeInteger(target) || target < CASH_BASELINE_EPOCH)
    throw failure("RECOVERY_PRIMARY_EPOCH_INVALID");
  if (!winning && prefix > target) {
    // Independent preflight snapshots may straddle another complete commit.
    // Distinguish that race from a journal genuinely ahead of the primary.
    const fresh = await primary(env.DB)
      .prepare("SELECT epoch FROM cashEpoch WHERE id=1")
      .first();
    if (Number.isSafeInteger(fresh?.epoch) && fresh.epoch >= prefix)
      throw failure("STALE_SNAPSHOT_RETRY_SAME_REQUEST", 409);
    throw failure("RECOVERY_PRIMARY_EPOCH_INVALID");
  }
  if (prefix < target) {
    // Repair at most ONE missing winner, and never combine a repair with a new
    // financial sale in this invocation (D1 Free: 50 queries/invocation).
    record = await repairNextWinner(db, log, env.LAB_TOKEN, prefix);
    if (!winning || record.requestId !== id || record.epoch !== target)
      throw prefixPending();
  }
  for (let attempt = 0; !winning && attempt < 1; attempt++) {
    let prepared: any;
    if (merged) {
      try {
        prepared = await strategy!.prepare(
          db,
          input,
          actor,
          states[0].value.snapshot,
        );
        const proof = await prepareRecord(
          log,
          prepared.plan,
          envelope,
          guarded,
        );
        preparedProof = proof;
        envelopeHash = proof.envelopeHash!;
      } catch (error: any) {
        // Business/byte-limit failures retain the original immutable key contract.
        if (guarded) {
          if (error.skipReservation) throw error;
          const checked = await log.batch([
            log
              .prepare("SELECT role FROM cashJournalIdentity WHERE id=?")
              .bind(LAB_ID),
            log.prepare(prefixSql),
          ]);
          if (checked[0].results[0]?.role !== "journal")
            throw failure("SANDBOX_IDENTITY_MISMATCH");
          checkedPrefix(checked[1].results[0]);
        }
        await reserveRequest(log, id, envelope);
        throw error;
      }
    } else {
      prepared = await prepareCashSale(db, input, actor);
      preparedProof = await prepareRecord(log, prepared.plan);
    }
    if (fault === "after-prepare") throw failure("PREPARED_PRIMARY_ABSENT");
    try {
      await applyCashPlan(db, prepared.plan, {
        fault: fault === "last-statement",
        knownAbsent: true,
      });
      // A successful native atomic batch committed these exact immutable
      // command/plan bytes. An ambiguous/failed response follows the catch
      // path and re-reads the actual primary winner instead.
      winning = {
        requestId: id,
        requestHash: prepared.plan.requestHash,
        request: prepared.plan.request,
        result: prepared.plan.result,
        plan: prepared.plan,
        planHash: preparedProof.hash,
      };
      provenNewCommit = true;
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
    break;
  }
  if (!winning) throw failure("PRIMARY_COMMIT_UNCERTAIN");
  if (canonical(winning.request) !== canonical(envelope))
    throw failure("PRIMARY_REQUEST_MISMATCH", 409);
  if (provenNewCommit)
    env.CREDIT_HANDOFF?.committed(winning.plan.expectedEpoch + 1);
  if (fault === "after-primary")
    throw failure("PRIMARY_COMMITTED_RECOVERY_PENDING");
  record ??= await confirm(
    log,
    env.LAB_TOKEN,
    envelopeHash!,
    winning.plan,
    preparedProof,
  );
  if (fault === "drop-response")
    throw failure("RESPONSE_LOST_AFTER_BOTH_COMMITS");
  env.CREDIT_HANDOFF?.acknowledged(record.epoch);
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
export async function committedRecordsPage(
  logBinding: any,
  after: number,
  through: number | undefined,
  limit: number,
  bound: (rows: any[]) => any[],
) {
  const log = primary(logBinding);
  await assertIdentity(log, "journal");
  const current = await journalPrefix(log);
  through ??= current;
  if (
    !Number.isSafeInteger(after) ||
    after < CASH_BASELINE_EPOCH ||
    !Number.isSafeInteger(through) ||
    through < after ||
    through > current
  )
    throw failure("RECOVERY_PAGE_EPOCH_CONFLICT", 409);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw failure("INVALID_PAGE_LIMIT", 400);
  const fetched = await log
    .prepare(
      "SELECT epoch,recordJson,signature FROM cashJournalCommitted WHERE epoch>? AND epoch<=? ORDER BY epoch LIMIT ?",
    )
    .bind(after, through, Math.min(limit, 8))
    .all();
  const records = bound(
    fetched.results.map((r: any, i: number) => {
      const record = { ...JSON.parse(r.recordJson), signature: r.signature };
      if (r.epoch !== after + i + 1 || record.epoch !== r.epoch)
        throw failure("RECOVERY_SEQUENCE_GAP");
      return record;
    }),
  );
  const nextEpoch = records.at(-1)?.epoch ?? after;
  if (!records.length && after < through)
    throw failure("RECOVERY_SEQUENCE_GAP");
  return {
    labId: LAB_ID,
    schemaVersion: CASH_SCHEMA_VERSION,
    afterEpoch: after,
    throughEpoch: through,
    nextEpoch,
    complete: nextEpoch === through,
    records,
  };
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
      await applyCashPlan(db, record.plan, { historicalRestore: true });
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
