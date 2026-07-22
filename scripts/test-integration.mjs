/* global console, process */

import { spawnSync } from "node:child_process";

const environment = { ...process.env, RUN_INTEGRATION_TESTS: "true" };

if (environment.DOCKER_HOST === undefined) {
  const podman = spawnSync(
    "podman",
    [
      "machine",
      "inspect",
      "podman-machine-default",
      "--format",
      "{{.ConnectionInfo.PodmanSocket.Path}}",
    ],
    { encoding: "utf8" },
  );
  const socket = podman.status === 0 ? podman.stdout.trim() : "";
  if (socket.length > 0) {
    environment.DOCKER_HOST = `unix://${socket}`;
    environment.TESTCONTAINERS_RYUK_DISABLED ??= "true";
    console.log(`Using Podman Testcontainers socket: ${socket}`);
  }
}

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"],
  {
    env: environment,
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
