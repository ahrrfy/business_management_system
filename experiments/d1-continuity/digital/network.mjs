import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
export function blockExternalEffects() {
  const attempts = [];
  const refuse = (kind) => {
    attempts.push({ kind });
    throw Error("DIGITAL_ORACLE_EXTERNAL_IO_BLOCKED:" + kind);
  };
  globalThis.fetch = async () => refuse("fetch");
  for (const [name, module] of [
    ["http", http],
    ["https", https],
  ])
    for (const method of ["request", "get"])
      module[method] = () => refuse(name + "." + method);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options =
      typeof normalized[0] === "object"
        ? normalized[0]
        : { port: normalized[0], host: normalized[1] };
    // Local named pipes are used by child-process/stdio internals.
    if (
      options.path ||
      (typeof options.port === "string" &&
        options.port.startsWith("\\\\.\\pipe\\"))
    )
      return connect.apply(this, args);
    if (Number(options.port) !== 13326 || options.host !== "127.0.0.1")
      return refuse("socket");
    return connect.apply(this, args);
  };
  syncBuiltinESMExports();
  return attempts;
}
