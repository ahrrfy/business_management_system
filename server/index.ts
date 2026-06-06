import "dotenv/config";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createContext } from "./context";
import { appRouter } from "./routers";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API routes must be registered before the SPA catch-all (added by Vite/static).
  app.use(
    "/api/trpc",
    createExpressMiddleware({ router: appRouter, createContext })
  );

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} busy, using ${port} instead`);
  }

  // Listen BEFORE attaching Vite: the API binds immediately and a slow Vite
  // startup never blocks the server from accepting requests.
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  console.log(`Server running on http://localhost:${port}/`);

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
    console.log("Vite middleware attached (dev)");
  } else {
    serveStatic(app);
  }
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
