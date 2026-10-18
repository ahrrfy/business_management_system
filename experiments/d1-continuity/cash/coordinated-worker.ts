import { DurableObject } from "cloudflare:workers";
import core from "./worker";
import { cashHttpInput } from "./http-input";
import { LAB_ID } from "./journal";
import { CashWriterQueue } from "./writer-queue";

// One name for the entire primary D1: its cashEpoch is global, not per branch.
export const CASH_WRITER_NAME = LAB_ID + ":primary:writer-v1";
const errorResponse = (code: string, status: number) =>
  Response.json(
    { code, retryWithOriginalRequest: status === 503 },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );

async function validateSale(
  request: Request,
  env: any,
): Promise<string | Response> {
  if (
    !env.LAB_TOKEN ||
    request.headers.get("authorization") !== "Bearer " + env.LAB_TOKEN
  )
    return errorResponse("UNAUTHORIZED", 401);
  if (request.method !== "POST" || new URL(request.url).pathname !== "/sale")
    return errorResponse("UNSUPPORTED_TEST_ROUTE", 404);
  const raw = await request.text();
  if (raw.length > 20000) return errorResponse("REQUEST_TOO_LARGE", 400);
  try {
    if (!cashHttpInput.safeParse(JSON.parse(raw)).success)
      return errorResponse("INVALID_CASH_INPUT", 400);
  } catch {
    return errorResponse("INVALID_CASH_INPUT", 400);
  }
  return raw;
}

function saleRequest(request: Request, raw: string) {
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: raw,
  });
}

export class CashWriter extends DurableObject<any> {
  protected readonly queue = new CashWriterQueue();
  protected readonly instance = crypto.randomUUID();
  protected execute(request: Request) {
    return core.fetch(request, this.env);
  }

  async fetch(request: Request): Promise<Response> {
    const raw = await validateSale(request, this.env);
    if (raw instanceof Response) return raw;
    try {
      const run = await this.queue.run(() =>
        this.execute(saleRequest(request, raw)),
      );
      const headers = new Headers(run.value.headers);
      headers.set(
        "x-cash-writer",
        JSON.stringify({
          instance: this.instance,
          admissionSequence: run.admissionSequence,
          queuedAhead: run.queuedAhead,
          waitMs: run.waitMs,
          executionMs: run.executionMs,
          maxActive: this.queue.stats().maxActive,
        }),
      );
      return new Response(run.value.body, {
        status: run.value.status,
        headers,
      });
    } catch (error: any) {
      return errorResponse(
        error.message === "CASH_WRITER_QUEUE_FULL"
          ? "CASH_WRITER_QUEUE_FULL"
          : "CASH_WRITER_EXECUTION_UNCERTAIN",
        503,
      );
    }
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/sale") {
      const response = await core.fetch(request, env);
      if (
        request.method === "GET" &&
        url.pathname === "/status" &&
        response.status === 200
      )
        return Response.json(
          {
            ...(await response.json()),
            writerBindingPresent: !!env.CASH_WRITER,
          },
          { status: response.status, headers: response.headers },
        );
      return response;
    }
    const raw = await validateSale(request, env);
    if (raw instanceof Response) return raw;
    // Coordinator failure never falls through to an independent direct writer.
    if (!env.CASH_WRITER) return errorResponse("CASH_WRITER_UNAVAILABLE", 503);
    try {
      const id = env.CASH_WRITER.idFromName(CASH_WRITER_NAME);
      return await env.CASH_WRITER.get(id).fetch(saleRequest(request, raw));
    } catch {
      return errorResponse("CASH_WRITER_UNAVAILABLE", 503);
    }
  },
};
