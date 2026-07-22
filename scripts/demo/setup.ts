import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const workspaceRoot = process.cwd();
const demoRoot = resolve(workspaceRoot, ".intellirepo-demo", "portfolio-sample");

async function git(...arguments_: string[]): Promise<void> {
  await execFile("git", ["-C", demoRoot, ...arguments_]);
}

async function main(): Promise<void> {
  await rm(demoRoot, { force: true, recursive: true });
  await mkdir(join(demoRoot, "services"), { recursive: true });

  for (const example of [
    "express-users",
    "ktor-orders",
    "nest-payments",
    "spring-auth",
    "vertx-notifications",
  ]) {
    await cp(join(workspaceRoot, "examples", example), join(demoRoot, "services", example), {
      recursive: true,
    });
  }

  await mkdir(join(demoRoot, "docs", "api"), { recursive: true });
  await writeFile(
    join(demoRoot, "docs", "api", "authentication.md"),
    [
      "# Authentication API",
      "",
      "`POST /api/auth/login` accepts a login request and returns an access token.",
      "",
      "Source: `services/spring-auth/src/main/java/demo/AuthController.java`",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(demoRoot, "README.md"),
    "# IntelliRepo portfolio sample\n\nA generated multi-language repository for the local demo.\n",
  );

  await execFile("git", ["init", "--initial-branch=main", demoRoot]);
  await git("config", "user.name", "IntelliRepo Demo");
  await git("config", "user.email", "demo@intellirepo.local");
  await git("add", ".");
  await git("commit", "-m", "chore: create IntelliRepo demo baseline");

  console.log(JSON.stringify({ repositoryPath: demoRoot }, undefined, 2));
}

void main();
