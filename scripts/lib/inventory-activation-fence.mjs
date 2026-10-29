import {
  activateInventoryProjection,
  invalidateInventoryProjection,
} from "./inventory-projection-activation.mjs";
import { activeInventoryManifest } from "./inventory-activation-journal.mjs";
export {
  JOURNAL_NAME,
  CAPABILITY,
  readActivationJournal,
  writeActivationJournal,
  assertActivationRecoveryAllowed,
} from "./inventory-activation-journal.mjs";

export async function acquireInventoryGate(connection, identity) {
  const [[row]] = await connection.query(
    "SELECT CONNECTION_ID() AS id, DATABASE() AS db, @@server_uuid AS serverUuid",
  );
  if (row.db !== identity.database || row.serverUuid !== identity.serverUuid)
    throw new Error("INVENTORY_GATE_IDENTITY_MISMATCH");
  let lost = false,
    released = false,
    transactionId;
  connection.on?.("error", () => {
    lost = true;
  });
  connection.on?.("end", () => {
    lost = true;
  });
  await connection.beginTransaction();
  const [[gate]] = await connection.query(
    "SELECT id FROM monthCloseSequence WHERE id=1 FOR UPDATE",
  );
  if (Number(gate?.id) !== 1) {
    await connection.rollback();
    throw new Error("INVENTORY_GATE_MISSING");
  }
  async function assertLocked() {
    if (lost || released) throw new Error("INVENTORY_GATE_LOST");
    try {
      const [[now]] = await connection.query(
        "SELECT CONNECTION_ID() AS id, DATABASE() AS db, @@server_uuid AS serverUuid",
      );
      if (
        now.id !== row.id ||
        now.db !== row.db ||
        now.serverUuid !== row.serverUuid
      )
        throw new Error("INVENTORY_GATE_IDENTITY_MISMATCH");
      const [locks] = await connection.query(
        "SELECT l.ENGINE_TRANSACTION_ID AS transactionId FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE t.PROCESSLIST_ID=? AND l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='monthCloseSequence' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_TYPE='RECORD' AND l.LOCK_STATUS='GRANTED' AND l.LOCK_MODE='X,REC_NOT_GAP' AND l.LOCK_DATA='1'",
        [row.id, row.db],
      );
      if (
        locks.length !== 1 ||
        (transactionId && String(locks[0].transactionId) !== transactionId)
      )
        throw new Error("INVENTORY_GATE_LOCK_NOT_OWNED");
      transactionId = String(locks[0].transactionId);
    } catch (e) {
      lost = true;
      throw e;
    }
  }
  await assertLocked();
  return Object.freeze({
    connectionId: Number(row.id),
    assertLocked,
    async release() {
      await assertLocked();
      // Any error from COMMIT is ambiguous. This handle is never reconnected.
      released = true;
      try {
        await connection.commit();
      } catch (e) {
        lost = true;
        throw new Error("INVENTORY_GATE_COMMIT_UNCERTAIN", { cause: e });
      }
    },
  });
}

/** All foreground sessions must be attributed. No broad KILL, DB-name filtering
 * (a session can USE another DB), or 'sleeping means harmless' exceptions. */
export async function assertNoUnownedSessions(connection, allowedIds) {
  // MySQL 8.4 reports its internal GTID compactor as FOREGROUND. Exclude that
  // exact engine thread, not NULL users generally (unauthenticated clients matter).
  const [rows] = await connection.query(
    "SELECT PROCESSLIST_ID AS id FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_ID IS NOT NULL AND NOT (NAME='thread/sql/compress_gtid_table' AND PROCESSLIST_USER IS NULL AND PROCESSLIST_COMMAND='Daemon')",
  );
  const [transactions] = await connection.query(
    "SELECT trx_mysql_thread_id AS id FROM information_schema.innodb_trx",
  );
  const unowned = [...rows, ...transactions]
    .map((r) => Number(r.id))
    .filter((id) => !allowedIds.has(id));
  if (!rows.length || unowned.length)
    throw Object.assign(new Error("INVENTORY_UNOWNED_DATABASE_SESSION"), {
      unownedSessionIds: [...new Set(unowned)],
      allowedSessionIds: [...allowedIds],
    });
}

export async function runInventoryActivation({
  journal,
  persist,
  operations: op,
  connectionB,
  initialReadyVersion = 0,
  activate = activateInventoryProjection,
  invalidate = invalidateInventoryProjection,
}) {
  if (![0, 1].includes(initialReadyVersion))
    throw new Error("INVENTORY_READY_VERSION_UNSUPPORTED");
  let gate,
    stopped = false,
    committingGate = false,
    uncertain = false;
  const save = async (phase) => {
    journal = { ...journal, phase };
    await persist(journal);
  };
  const fence = {
    async assertQuiescentAndLocked() {
      await gate.assertLocked();
      await op.assertQuiescent();
      await gate.assertLocked();
    },
  };
  const options = {
    expectedDatabase: journal.database,
    expectedServerUuid: journal.serverUuid,
    commit: journal.commit,
    fence,
  };
  if (initialReadyVersion === 1) {
    activeInventoryManifest({
      ...journal,
      phase: "ROLLED_BACK",
      initialReadyVersion: 1,
      active: journal.priorActive,
    });
  }
  journal = { ...journal, initialReadyVersion, active: null };
  await op.preflight();
  await save("PREPARED");
  try {
    gate = await op.acquireGate();
    await save("LOCKED");
    // Once stopping begins, even a partially failed stop needs conservative recovery.
    stopped = true;
    await op.stopOld();
    await fence.assertQuiescentAndLocked();
    await save("QUIESCENT");
    if (initialReadyVersion === 0) await activate(connectionB, options);
    await save("READY");
    await op.installCandidate();
    await op.startCandidates();
    await save("CANDIDATES");
    await op.verifyCandidates(journal);
    await gate.assertLocked();
    await op.saveCompatibleRestartDefinitions(journal);
    await gate.assertLocked();
    await save("PRE_RELEASE");
    // Re-census and attest after saving the dump/intent, immediately before A commits.
    await op.verifyCandidates(journal);
    await gate.assertLocked();
    committingGate = true;
    await gate.release();
    // This is the ONLY transition that lets compiled candidate boots continue.
    journal.active = {
      readyVersion: 1,
      activationId: journal.id,
      commit: journal.commit,
      database: journal.database,
      serverUuid: journal.serverUuid,
      projectionCommit:
        initialReadyVersion === 1
          ? journal.priorActive.projectionCommit
          : journal.commit,
      artifacts: journal.artifacts,
    };
    await save("RELEASED");
    return journal;
  } catch (error) {
    uncertain = committingGate || /COMMIT_UNCERTAIN/.test(error?.message ?? "");
    try {
      if (stopped) await op.stopCandidates();
      if (!gate || uncertain) throw new Error("INVENTORY_UNCERTAIN_ACTIVATION");
      await fence.assertQuiescentAndLocked();
      if (initialReadyVersion === 0) await invalidate(connectionB, options);
      await op.restoreArtifact();
      await save("ROLLBACK_READY");
      committingGate = true;
      await gate.release();
      journal.active = initialReadyVersion === 1 ? journal.priorActive : null;
      await save("ROLLED_BACK");
      await op.restartOld();
    } catch (recoveryError) {
      // Persist is allowed to fail; never disguise the original failure or start old code.
      await save("FATAL").catch(() => {});
      throw new AggregateError(
        [error, recoveryError],
        "INVENTORY_ACTIVATION_FATAL",
      );
    }
    throw error;
  }
}
