import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const controller = resolve(
    process.cwd(),
    ".intellirepo-demo/portfolio-sample/services/spring-auth/src/main/java/demo/AuthController.java",
  );
  const current = await readFile(controller, "utf8");
  const changed = current.replace('@PostMapping("/login")', '@PostMapping("/sessions")');
  if (changed === current) throw new Error("Demo change is already applied or the fixture changed");
  await writeFile(controller, changed);
  console.log(
    "Changed POST /api/auth/login to POST /api/auth/sessions; documentation is now stale.",
  );
}

void main();
