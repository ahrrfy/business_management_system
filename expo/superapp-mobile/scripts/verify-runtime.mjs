const [major] = process.versions.node.split(".").map(Number);

if (major === 20 || major === 22) {
  console.log(`[runtime] Node ${process.versions.node} is supported for Expo local development.`);
  process.exit(0);
}

console.error(
  `[runtime] Node ${process.versions.node} is not supported for the local Expo dev server. Use Node 20 or 22 LTS.`,
);
process.exit(1);
