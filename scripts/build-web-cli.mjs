import { buildWeb } from "./build-web.mjs";

buildWeb().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
