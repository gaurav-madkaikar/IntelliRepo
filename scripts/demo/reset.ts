import { rm } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const demoRoot = resolve(process.cwd(), ".intellirepo-demo", "portfolio-sample");
  await rm(demoRoot, { force: true, recursive: true });
  console.log(`Removed ${demoRoot}`);
}

void main();
