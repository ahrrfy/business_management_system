import fs from "fs";
const files = [
  "server/routers/tasksRouter.ts",
  "server/services/tasks/create.ts",
  "server/services/tasks/helpers.ts",
  "server/services/tasks/lifecycle.ts",
  "server/services/tasks/list.ts"
];
for (const f of files) {
  let content = fs.readFileSync(f, "utf8");
  // Replace appErrorMessage({ what: "خطأ", why: "..." }) with appErrorMessage({ what: "خطأ", why: "...", doThis: "يرجى التحقق والمحاولة مجدداً." })
  content = content.replace(/appErrorMessage\(\{\s*what:\s*"خطأ",\s*why:\s*("[^"]+"|`[^`]+`|'[^']+')\s*\}\)/g, "appErrorMessage({ what: \"خطأ\", why: $1, doThis: \"يرجى التحقق والمحاولة مجدداً.\" })");
  fs.writeFileSync(f, content, "utf8");
}
console.log("Fixed again again");
