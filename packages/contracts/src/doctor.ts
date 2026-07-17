import { checkInfrastructureHealth } from "./health.js";
import { loadApplicationConfig } from "./config.js";

async function main(): Promise<void> {
  const health = await checkInfrastructureHealth(loadApplicationConfig());

  for (const dependency of health.dependencies) {
    const requirement = dependency.required ? "required" : "optional";
    const detail = dependency.message === undefined ? "" : ` — ${dependency.message}`;
    process.stdout.write(
      `${dependency.name.padEnd(8)} ${dependency.state.padEnd(8)} ${requirement} ${dependency.latencyMs}ms${detail}\n`,
    );
  }

  process.stdout.write(`overall  ${health.status}\n`);
  process.exitCode = health.status === "unhealthy" ? 1 : 0;
}

void main();
