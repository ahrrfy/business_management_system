import type { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";

export type RuntimeLabProcedure = "catalog" | "quote" | "create" | "replay" | "staff" | "health" | "other";
export type RuntimeLabRequest = { url?: string; headers?: IncomingHttpHeaders };
export function validateRuntimeLabObservationFlags(env: Record<string, string | undefined>): {
  readCacheEnabled: boolean;
  diagnosticsEnabled: boolean;
};
export function runtimeLabProcedureLabel(request: RuntimeLabRequest): RuntimeLabProcedure;
export type RuntimeLabLease = {
  poolId: number;
  connectionId: number;
  queuedMs: number;
  acquiredMs: number;
  releasedMs: number | null;
  endReason: string | null;
  statements: number;
  statementErrors: number;
  statementTotalMs: number;
};
export type RuntimeLabRequestRecord = {
  sequence: number;
  label: RuntimeLabProcedure;
  startMs: number;
  responseEndMs: number | null;
  endMs: number | null;
  ended: boolean;
  dispatching: boolean;
  work: number;
  leases: number;
  pendingStatements: number;
  acquiring: number;
  admitting: number;
  workScopes: number;
  sql: {
    acquisitions: number;
    acquisitionErrors: number;
    waitTotalMs: number;
    waitMaxMs: number;
    holdTotalMs: number;
    holdMaxMs: number;
    statements: number;
    statementErrors: number;
    statementTotalMs: number;
    statementMaxMs: number;
    leaseSamples: RuntimeLabLease[];
    leaseSamplesTruncated: boolean;
  };
  admission: {
    starts: number;
    grants: number;
    rejects: number;
    waitTotalMs: number;
    waitMaxMs: number;
    reason: string | null;
  };
};
export type RuntimeLabCacheRecord = {
  gets: number;
  loads: number;
  loaded: number;
  failed: number;
  loadTotalMs: number;
  entries: number;
  inFlight: number;
  rejected: number;
  getsWithoutLoaderStart: number;
};
export type RuntimeLabObservation = {
  runRequest<T>(request: RuntimeLabRequest, response: Pick<EventEmitter, "once" | "off">, invoke: () => T): T;
  installHttp(prototype?: Pick<EventEmitter, "emit">): () => void;
  subscribe(): () => void;
  instrumentPool<T extends { getConnection: (...args: never[]) => unknown }>(pool: T): () => void;
  drain(): {
    truncated: boolean;
    dropped: number;
    failures: number;
    maxRequests: number;
    active: RuntimeLabRequestRecord[];
    requests: RuntimeLabRequestRecord[];
    caches: Record<string, RuntimeLabCacheRecord>;
  };
};
export function createRuntimeLabObservation(options?: { now?: () => number; maxRequests?: number }): RuntimeLabObservation;
