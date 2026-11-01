import { runtimeWorkDrain } from "../lib/workDrain";
import { webRuntimeRole } from "../lib/clusterRole";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "../../shared/errors";
import {
  storefrontResourceAdmission,
  ResourceAdmissionError,
  runWithResourceTailScope,
  type ResourceAdmission,
  type ResourceLane,
  type ResourceTicket,
} from "../lib/resourceAdmission";
import { parseCanonicalTrpcProcedures } from "./publicSensitiveBatch";
import { sendTrpcError } from "./trpcError";
import { assertRuntimeProcedure } from "./runtimeBoundary";
export { storefrontResourceAdmission } from "../lib/resourceAdmission";

const ORDER_PATHS = new Set([
  "storefront.quoteOrder",
  "storefront.quoteOrderPrivate",
  "storefront.createOrder",
  "storefront.createQuoteRequest",
  "storefront.acceptQuoteRequestPrivate",
  "storefront.acceptQuoteRequestByToken",
  "storefront.cancelOrderPrivate",
  "storefront.cancelOrderByToken",
]);
const HEAVY_PATHS = new Set([
  "storefront.catalog",
  "storefront.product",
  "storefront.searchSuggestions",
  "storefront.related",
  "storefront.cartRecommendations",
  "storefront.shelfLookup",
  "storefront.thematicCollections",
  "storefront.createWishlistShare",
  "storefront.getWishlistShare",
  "storefront.getCartShare",
]);
// Two detached notification transactions can overlap the common audit INSERT.
const REVIEW_PATHS = new Set([
  "storefront.submitProductReview",
  "storefront.submitPublicProductReview",
]);
const FOUR_WAY_PATHS = new Set([
  "storefront.thematicCollections",
  "storefront.createWishlistShare",
  "storefront.getWishlistShare",
  "storefront.getCartShare",
]);
export function publicBatchCost(
  procedures: readonly string[],
): { lane: ResourceLane; cost: number; mixedOrder?: true } | null {
  if (!procedures.some((p) => p.startsWith("storefront."))) return null;
  const allOrder = procedures.every((p) => ORDER_PATHS.has(p));
  const mixedOrder = !allOrder && procedures.some((p) => ORDER_PATHS.has(p));
  // Context precedes procedures: reserve its peak of two auth reads once, or
  // the sum of concurrent procedure peaks, whichever is larger. No physical SQL
  // connections are reserved. Staff calling public routes still stays public.
  return {
    lane: allOrder ? "public-order" : "public-read",
    cost: Math.max(
      2,
      procedures.reduce(
        (n, p) =>
          n +
          (FOUR_WAY_PATHS.has(p)
            ? 4
            : REVIEW_PATHS.has(p)
              ? 3
              : HEAVY_PATHS.has(p)
                ? 2
                : 1),
        0,
      ),
    ),
    ...(mixedOrder ? { mixedOrder: true as const } : {}),
  };
}

class RequestWorkScope {
  closed = false;
  private running = 0;
  constructor(
    private ticket: ResourceTicket,
    readonly gate: ResourceAdmission,
  ) {}
  beginWork(tail = false) {
    if (this.closed && (!tail || this.running === 0))
      throw new ResourceAdmissionError("aborted");
    this.running++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.running--;
      this.releaseIfDrained();
    };
  }
  close() {
    this.closed = true;
    this.releaseIfDrained();
  }
  private releaseIfDrained() {
    if (this.closed && this.running === 0) this.ticket.release();
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const end = this.beginWork();
    try {
      return await runtimeWorkDrain.run(() => runWithResourceTailScope(
        { beginWork: () => this.beginWork(true) },
        work,
      ));
    } finally {
      end();
    }
  }
}
const scopes = new WeakMap<Request, RequestWorkScope>();
function requestAbort(req: Request, res: Response) {
  const abort = new AbortController();
  const stop = () => {
    if (!res.writableEnded) abort.abort();
  };
  req?.once?.("aborted", stop);
  res?.once?.("close", stop);
  if (req?.aborted || res?.destroyed) abort.abort();
  return {
    signal: abort.signal,
    dispose() {
      req?.off?.("aborted", stop);
      res?.off?.("close", stop);
    },
  };
}
function attachScope(
  req: Request,
  res: Response,
  ticket: ResourceTicket,
  gate: ResourceAdmission,
  register = true,
) {
  const scope = new RequestWorkScope(ticket, gate);
  if (register) scopes.set(req, scope);
  const close = () => {
    scope.close();
    res.off("finish", close);
    res.off("close", close);
    req.off("aborted", close);
  };
  res.once("finish", close);
  res.once("close", close);
  req.once("aborted", close);
  if (req.aborted || res.destroyed || res.writableEnded) close();
  return scope;
}
export function sendResourceError(req: Request, res: Response, error: unknown) {
  if (res.destroyed || res.headersSent || req.aborted) return;
  if (!(error instanceof ResourceAdmissionError)) throw error;
  res.setHeader("Retry-After", "1");
  if (req.baseUrl.startsWith("/api/trpc"))
    sendTrpcError(res, {
      httpStatus: error.httpStatus,
      code:
        error.httpStatus === 429
          ? "TOO_MANY_REQUESTS"
          : "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  else res.status(error.httpStatus).json({ error: error.message });
}

/** Before tenancy/auth SQL, but after the existing security/rate/batch guards. */
export function createStorefrontAdmission(
  gate = storefrontResourceAdmission(),
): RequestHandler {
  return (req, res, next) => {
    const procedures = parseCanonicalTrpcProcedures(req.path || "");
    if (!procedures) return next(); // Canonical-path security guard owns malformed requests.
    const batch = publicBatchCost(procedures);
    if (!batch) return next();
    if (procedures.length > 20) {
      sendResourceError(req, res, new ResourceAdmissionError("batch", 429));
      return;
    }
    // Browser clients already isolate every ORDER_PATHS operation via httpLink.
    // Reject crafted mixed mutation batches rather than bypassing the order cap.
    if (batch.mixedOrder && gate.rejectMixedOrderBatch()) {
      sendResourceError(req, res, new ResourceAdmissionError("batch", 429));
      return;
    }
    const abort = requestAbort(req, res);
    void gate.acquire(batch.lane, batch.cost, abort.signal).then(
      (ticket) => {
        abort.dispose();
        const scope = attachScope(req, res, ticket, gate);
        if (!scope.closed) next();
      },
      (error) => {
        abort.dispose();
        sendResourceError(req, res, error);
      },
    );
  };
}

/** Public metadata/storage admission also precedes tenant lookup. */
export function createPublicImageAdmission(
  gate = storefrontResourceAdmission(),
): RequestHandler {
  return (req, res, next) => {
    if (
      !/^\/(?:product\/[^/]+|banner\/[^/]+\/[^/]+|company\/[^/]+\/product\/[^/]+)\/?$/i.test(
        req.path,
      )
    )
      return next();
    const abort = requestAbort(req, res);
    // Tenancy, staff verification (two reads), then image loading are
    // sequential. Reserve their peak once before any of them can start.
    const cost = webRuntimeRole() === "admin" ? 2 : 1;
    void gate.acquire("public-read", cost, abort.signal).then(
      (ticket) => {
        abort.dispose();
        const scope = attachScope(req, res, ticket, gate);
        if (!scope.closed) next();
      },
      (error) => {
        abort.dispose();
        sendResourceError(req, res, error);
      },
    );
  };
}

/** Staff verification reuses an image's pre-tenancy reservation, never nests it. */
export async function withPublicHttpBoundaryWork<T>(
  req: Request,
  res: Response,
  work: () => Promise<T>,
): Promise<T> {
  const existing = scopes.get(req);
  if (existing) return existing.run(work);
  const gate = storefrontResourceAdmission();
  const abort = requestAbort(req, res);
  let ticket: ResourceTicket;
  try {
    ticket = await gate.acquire("public-read", 2, abort.signal);
  } finally {
    abort.dispose();
  }
  // Non-image boundaries retain their original auth-only reservation. Their
  // eventual public handlers perform their own admission after auth settles.
  const scope = attachScope(req, res, ticket, gate, false);
  try {
    return await scope.run(work);
  } finally {
    scope.close();
  }
}

/** Wrap the actual promise, never Express next()/response close as a proxy. */
export async function withStorefrontContextWork<T>(
  req: Request,
  work: () => Promise<T>,
): Promise<T> {
  const scope = scopes.get(req);
  return scope ? scope.run(work) : runtimeWorkDrain.run(work);
}
export async function withStorefrontProcedureWork<T>(
  req: Request,
  res: Response,
  path: string,
  authenticatedStaff: boolean,
  work: () => Promise<T>,
  admission?: ResourceAdmission,
): Promise<T> {
  const scope = scopes.get(req);
  const invoke = async () => {
    assertRuntimeProcedure(path, authenticatedStaff);
    const result = await work();
    // tRPC's next() represents handler errors as a result, rather than throwing.
    // A cache limit must still become 503/Retry-After, not an opaque HTTP 500.
    const failure = result as {
      ok?: boolean;
      error?: { cause?: unknown };
    } | null;
    if (
      failure?.ok === false &&
      failure.error?.cause instanceof ResourceAdmissionError
    )
      throw failure.error.cause;
    return result;
  };
  try {
    if (scope) return await scope.run(invoke);
    // Direct server callers do not have an HTTP preflight scope. Public remains
    // public even when a staff user happens to call it.
    const batch = publicBatchCost([path]);
    if (!batch && !authenticatedStaff) return await runtimeWorkDrain.run(invoke);
    const gate = admission ?? storefrontResourceAdmission();
    const abort = requestAbort(req, res);
    let ticket: ResourceTicket;
    try {
      ticket = await gate.acquire(
        batch?.lane ?? "staff",
        batch?.cost ?? 1,
        abort.signal,
      );
    } finally {
      abort.dispose();
    }
    if (abort.signal.aborted || req?.aborted || res?.destroyed) {
      ticket.release();
      throw new ResourceAdmissionError("aborted");
    }
    // Each staff procedure owns its own ticket, never share one across a batch.
    const local =
      typeof req?.once === "function" && typeof res?.once === "function"
        ? attachScope(req, res, ticket, gate, false)
        : new RequestWorkScope(ticket, gate);
    try {
      return await local.run(invoke);
    } finally {
      local.close();
    }
  } catch (error) {
    if (!(error instanceof ResourceAdmissionError)) throw error;
    if (res && !res.headersSent) res.setHeader?.("Retry-After", "1");
    throw new TRPCError({
      code:
        error.httpStatus === 429 ? "TOO_MANY_REQUESTS" : "SERVICE_UNAVAILABLE",
      message: appErrorMessage({
        what: "الخادم مشغول حالياً",
        why: "وصل العمل الجاري إلى حده المؤقت",
        doThis: "انتظر لحظة ثم أعد المحاولة",
      }),
      cause: error,
    });
  }
}

/** For actual non-tRPC handlers. Private image handlers are deliberately untouched. */
export function publicResourceHandler<T>(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<T>,
  cost = 1,
  gate?: ResourceAdmission,
  shouldAdmit: (req: Request) => boolean = () => true,
): RequestHandler {
  return (req, res, next) => {
    if (!shouldAdmit(req)) {
      void runtimeWorkDrain.run(() => handler(req, res, next)).catch(next);
      return;
    }
    const existing = scopes.get(req);
    if (existing) {
      void existing
        .run(() => handler(req, res, next))
        .catch((error) => {
          if (error instanceof ResourceAdmissionError)
            sendResourceError(req, res, error);
          else next(error);
        });
      return;
    }
    const admission = gate ?? storefrontResourceAdmission();
    const abort = requestAbort(req, res);
    void admission
      .acquire("public-read", cost, abort.signal)
      .then(async (ticket) => {
        abort.dispose();
        const scope = attachScope(req, res, ticket, admission);
        if (scope.closed) return;
        try {
          await scope.run(() => handler(req, res, next));
        } finally {
          scope.close();
        }
      })
      .catch((error) => {
        abort.dispose();
        if (error instanceof ResourceAdmissionError)
          sendResourceError(req, res, error);
        else next(error);
      });
  };
}
