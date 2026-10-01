const [major] = process.versions.node.split(".").map(Number);

if (major === 20 || major === 22 || major === 24) {
  console.log(`[runtime] Node ${process.versions.node} is supported for Expo local development.`);
  process.exit(0);
}

console.error(
  `[runtime] Node ${process.versions.node} is not supported for the local Expo dev server. Use Node 20, 22, or 24.`,
);
process.exit(1);
