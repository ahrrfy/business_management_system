import net from "node:net";

/**
 * Send raw ESC/POS bytes to a network printer over TCP (typically port 9100).
 * Works with Star TSP*LAN, Epson TM-i*, BIXOLON SRP-*LAN, or any printer
 * advertising the standard RAW print protocol.
 */
export async function printNetwork(host: string, port: number, bytes: Buffer, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve();
    };
    const sock = net.createConnection(port, host);
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => {
      sock.write(bytes, (err) => {
        if (err) return finish(err);
        // give the printer a moment to flush before we close
        setTimeout(() => finish(), 200);
      });
    });
    sock.on("error", (err) => finish(err));
    sock.on("timeout", () => finish(new Error(`Timeout connecting to printer ${host}:${port}`)));
  });
}

export async function pingNetworkPrinter(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host);
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}
