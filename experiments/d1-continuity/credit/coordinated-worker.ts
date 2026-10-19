import { DurableObject } from "cloudflare:workers";
import core, { creditReadAhead } from "./worker";
import { creditHttpInput } from "./http-input";
import { LAB_ID } from "./identity";
import { CreditPipelineQueue } from "./pipeline";
import { creditActor } from "./fixture";
export const CREDIT_WRITER_NAME = LAB_ID + ":primary:writer-v1";
const error = (code: string, status: number) =>
  Response.json(
    { code, retryWithOriginalRequest: status === 503 },
    { status, headers: { "cache-control": "no-store" } },
  );
async function validate(request: Request, env: any) {
  if (
    !env.LAB_TOKEN ||
    request.headers.get("authorization") !== "Bearer " + env.LAB_TOKEN
  )
    return error("UNAUTHORIZED", 401);
  const route = new URL(request.url).pathname;
  if (request.method === "GET" && route === "/ready") {
    try {
      creditActor(request, env);
      return "";
    } catch {
      return error("INVALID_LAB_TERMINAL", 400);
    }
  }
  if (
    request.method !== "POST" ||
    !["/sale", "/payment", "/return"].includes(route)
  )
    return error("UNSUPPORTED_TEST_ROUTE", 404);
  const raw = await request.text();
  if (raw.length > 20000) return error("INVALID_REQUEST_SIZE", 400);
  try {
    creditActor(request, env);
    const parsed = creditHttpInput.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      !(
        route === "/sale"
          ? ["SALE", "CASH_SALE"]
          : route === "/return"
            ? ["RETURN"]
            : ["COLLECT"]
      ).includes(parsed.data.commandType)
    )
      return error("INVALID_CREDIT_INPUT", 400);
  } catch {
    return error("INVALID_CREDIT_INPUT", 400);
  }
  return raw;
}
export class CreditWriter extends DurableObject<any> {
  protected readonly queue = new CreditPipelineQueue();
  protected readonly instance = crypto.randomUUID();
  protected environment(_request: Request) {
    return this.env;
  }
  protected execute(request: Request, env: any) {
    return core.fetch(request, env);
  }
  async fetch(request: Request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/ready")
      return core.fetch(request, this.environment(request));
    const raw = await validate(request, this.env);
    if (raw instanceof Response) return raw;
    try {
      const execution = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: raw,
      });
      const env = this.environment(execution);
      const run = await this.queue.run(
        (hooks) =>
          this.execute(execution, {
            ...env,
            CREDIT_READAHEAD: hooks.prefetched,
            CREDIT_HANDOFF: hooks,
          }),
        env.CREDIT_PIPELINE === "0"
          ? undefined
          : (_epoch, generation) =>
              creditReadAhead(execution.clone(), env, generation),
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
          lookahead: run.lookahead,
          maxActive: this.queue.stats().maxActive,
        }),
      );
      return new Response(run.value.body, {
        status: run.value.status,
        headers,
      });
    } catch (e: any) {
      return error(
        e.message.startsWith("LOOKAHEAD_")
          ? e.message
          : e.message === "CASH_WRITER_QUEUE_FULL"
            ? "CASH_WRITER_QUEUE_FULL"
            : "CASH_WRITER_EXECUTION_UNCERTAIN",
        503,
      );
    }
  }
}
export default {
  async fetch(request: Request, env: any) {
    const ready =
      request.method === "GET" && new URL(request.url).pathname === "/ready";
    if (
      !ready &&
      (request.method !== "POST" ||
        !["/sale", "/payment", "/return"].includes(
          new URL(request.url).pathname,
        ))
    )
      return core.fetch(request, env);
    const raw = await validate(request, env);
    if (raw instanceof Response) return raw;
    if (!env.CREDIT_WRITER) return error("CASH_WRITER_UNAVAILABLE", 503);
    try {
      return await env.CREDIT_WRITER.get(
        env.CREDIT_WRITER.idFromName(CREDIT_WRITER_NAME),
      ).fetch(
        new Request(request.url, {
          method: ready ? "GET" : "POST",
          headers: request.headers,
          ...(ready ? {} : { body: raw }),
        }),
      );
    } catch {
      return error("CASH_WRITER_UNAVAILABLE", 503);
    }
  },
};
