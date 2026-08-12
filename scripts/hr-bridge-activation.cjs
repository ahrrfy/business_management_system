"use strict";

const defaultReleaseTools = require("./hr-bridge-release.cjs");

class BridgeActivationError extends Error {
  constructor(code, cause, rollbackCause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = "BridgeActivationError";
    this.code = code;
    this.rollbackCause = rollbackCause;
  }
}

function assertOperations(operations) {
  for (const name of ["stop", "start", "verify", "save"]) {
    if (typeof operations?.[name] !== "function") {
      throw new Error("HR_BRIDGE_ACTIVATION_OPERATIONS_INVALID");
    }
  }
}

function restorePrior(projectRoot, transaction, operations, releaseTools) {
  const abortIfDurable = () => {
    try {
      releaseTools.abortActivation(projectRoot, transaction.txId);
    } catch (abortCause) {
      releaseTools.ensureStateDurable(projectRoot);
      const after = releaseTools.readState(projectRoot);
      const priorMatches =
        (transaction.prior == null && after.current == null) ||
        (after.current?.id === transaction.prior?.id &&
          after.current?.mode === transaction.prior?.mode);
      if (after.pending != null || !priorMatches) throw abortCause;
    }
  };
  let state = releaseTools.readState(projectRoot);
  if (!state.pending || state.pending.txId !== transaction.txId) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_MISMATCH");
  }

  if (state.pending.phase === "staged") {
    // PM2 cannot have been touched: switching is persisted before stop/delete.
    abortIfDurable();
    return;
  }
  if (state.pending.phase === "rollback-saved") {
    abortIfDurable();
    return;
  }
  if (state.pending.phase !== "rolling-back") {
    releaseTools.markActivationPhase(
      projectRoot,
      transaction.txId,
      "rolling-back",
    );
  }

  operations.stop();
  if (transaction.prior?.mode === "enabled") {
    operations.start(transaction.prior);
  }
  operations.verify(transaction.prior);
  operations.save();
  releaseTools.markActivationPhase(
    projectRoot,
    transaction.txId,
    "rollback-saved",
  );
  abortIfDurable();
}

function recoverInterruptedActivation(
  projectRoot,
  operations,
  releaseTools = defaultReleaseTools,
) {
  assertOperations(operations);
  const state = releaseTools.readState(projectRoot);
  if (!state.pending) return false;
  restorePrior(projectRoot, state.pending, operations, releaseTools);
  return true;
}

function activateBridgeRelease(
  projectRoot,
  candidate,
  operations,
  releaseTools = defaultReleaseTools,
) {
  assertOperations(operations);
  const before = releaseTools.readState(projectRoot);
  if (!before.current) {
    // A null prior means proven absence, never an unknown legacy worker. This
    // closes the race between the pre-pull/adoption guard and the first stop.
    operations.verify(null);
  }
  const transaction = releaseTools.beginActivation(projectRoot, candidate);
  try {
    releaseTools.markActivationPhase(
      projectRoot,
      transaction.txId,
      "switching",
    );
    operations.stop();
    if (candidate.mode === "enabled") operations.start(candidate);
    operations.verify(candidate);
    releaseTools.markActivationPhase(
      projectRoot,
      transaction.txId,
      "verified",
    );
    operations.save();
    releaseTools.markActivationPhase(
      projectRoot,
      transaction.txId,
      "saved",
    );
    try {
      releaseTools.commitActivation(projectRoot, transaction.txId);
    } catch (commitCause) {
      const state = releaseTools.readState(projectRoot);
      if (
        state.pending == null &&
        state.current?.id === candidate.id &&
        state.current?.mode === candidate.mode
      ) {
        try {
          releaseTools.ensureStateDurable(projectRoot);
        } catch (durabilityCause) {
          throw new BridgeActivationError(
            "HR_BRIDGE_ACTIVATION_COMMIT_DURABILITY_UNCERTAIN",
            commitCause,
            durabilityCause,
          );
        }
        return transaction;
      }
      throw commitCause;
    }
    return transaction;
  } catch (cause) {
    if (
      cause?.code ===
      "HR_BRIDGE_ACTIVATION_COMMIT_DURABILITY_UNCERTAIN"
    ) {
      throw cause;
    }
    try {
      restorePrior(projectRoot, transaction, operations, releaseTools);
    } catch (rollbackCause) {
      throw new BridgeActivationError(
        "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_FAILED",
        cause,
        rollbackCause,
      );
    }
    throw new BridgeActivationError(
      transaction.prior
        ? "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_OK"
        : "HR_BRIDGE_ACTIVATION_FAILED_NO_BASELINE",
      cause,
    );
  }
}

function adoptLegacyBridgeBaseline(
  projectRoot,
  candidate,
  operations,
  releaseTools = defaultReleaseTools,
) {
  assertOperations(operations);
  for (const name of [
    "verifyLegacy",
    "startLegacy",
    "beginAdoptionJournal",
    "finishAdoptionJournal",
  ]) {
    if (typeof operations?.[name] !== "function") {
      throw new Error("HR_BRIDGE_ADOPTION_OPERATIONS_INVALID");
    }
  }
  const state = releaseTools.readState(projectRoot);
  if (state.current || state.previous || state.pending) {
    throw new Error("HR_BRIDGE_BASELINE_STATE_NOT_EMPTY");
  }
  operations.verifyLegacy();
  operations.beginAdoptionJournal(candidate);
  try {
    operations.stop();
    if (candidate.mode === "enabled") operations.start(candidate);
    operations.verify(candidate);
    operations.save();
    try {
      releaseTools.establishBaseline(projectRoot, candidate);
    } catch (commitCause) {
      const committed = releaseTools.readState(projectRoot).current;
      if (
        committed?.id !== candidate.id ||
        committed?.mode !== candidate.mode
      ) {
        throw commitCause;
      }
      try {
        releaseTools.ensureStateDurable(projectRoot);
      } catch (durabilityCause) {
        throw new BridgeActivationError(
          "HR_BRIDGE_ADOPTION_COMMIT_DURABILITY_UNCERTAIN",
          commitCause,
          durabilityCause,
        );
      }
    }
    operations.finishAdoptionJournal();
    return candidate;
  } catch (cause) {
    const committed = releaseTools.readState(projectRoot).current;
    if (
      committed?.id === candidate.id &&
      committed?.mode === candidate.mode
    ) {
      releaseTools.ensureStateDurable(projectRoot);
      operations.finishAdoptionJournal();
      return candidate;
    }
    try {
      operations.stop();
      operations.startLegacy();
      operations.verifyLegacy();
      operations.save();
      operations.finishAdoptionJournal();
    } catch (rollbackCause) {
      throw new BridgeActivationError(
        "HR_BRIDGE_ADOPTION_FAILED_LEGACY_RESTORE_FAILED",
        cause,
        rollbackCause,
      );
    }
    throw new BridgeActivationError(
      operations.legacyHealth === "unhealthy"
        ? "HR_BRIDGE_ADOPTION_FAILED_UNHEALTHY_LEGACY_RESTORED"
        : "HR_BRIDGE_ADOPTION_FAILED_LEGACY_RESTORED",
      cause,
    );
  }
}

module.exports = Object.freeze({
  BridgeActivationError,
  adoptLegacyBridgeBaseline,
  activateBridgeRelease,
  recoverInterruptedActivation,
});
