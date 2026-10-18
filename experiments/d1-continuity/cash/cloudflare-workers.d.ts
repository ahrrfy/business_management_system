// Only the native base-class surface used by this isolated lab.
// Its runtime behavior is exercised in workerd, including a real object abort.
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected env: Env;
    protected ctx: { abort(message?: string): never };
    constructor(ctx: unknown, env: Env);
  }
}
