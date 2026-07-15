import { connect } from "node:net";
import { performance } from "node:perf_hooks";

import type { ApplicationConfig } from "./config.js";

export type DependencyName = "neo4j" | "ollama" | "postgres" | "redis";
export type DependencyState = "down" | "up";
export type OverallHealthState = "degraded" | "healthy" | "unhealthy";

export interface DependencyHealth {
  readonly latencyMs: number;
  readonly message?: string;
  readonly name: DependencyName;
  readonly required: boolean;
  readonly state: DependencyState;
}

export interface InfrastructureHealth {
  readonly dependencies: readonly DependencyHealth[];
  readonly status: OverallHealthState;
  readonly timestamp: string;
}

export type DependencyChecker = () => Promise<void>;

export interface InfrastructureCheckers {
  readonly neo4j: DependencyChecker;
  readonly ollama: DependencyChecker;
  readonly postgres: DependencyChecker;
  readonly redis: DependencyChecker;
}

function asMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown dependency failure";
  }

  const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return error.message.trim() || errorCode || error.name || "Unknown dependency failure";
}

function parseConnectionTarget(connectionUrl: string): { host: string; port: number } {
  const url = new URL(connectionUrl);
  const defaultPorts: Partial<Record<string, number>> = {
    "bolt:": 7687,
    "postgres:": 5432,
    "postgresql:": 5432,
    "redis:": 6379,
  };
  const port = url.port === "" ? defaultPorts[url.protocol] : Number(url.port);

  if (port === undefined || Number.isNaN(port)) {
    throw new Error(`No port is available for ${url.protocol}`);
  }

  return { host: url.hostname, port };
}

function checkTcp(connectionUrl: string, timeoutMs = 2_000): Promise<void> {
  const { host, port } = parseConnectionTarget(connectionUrl);

  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function checkOllama(baseUrl: string, timeoutMs: number): Promise<void> {
  const response = await fetch(new URL("/api/tags", baseUrl), {
    signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }
}

function defaultCheckers(config: ApplicationConfig): InfrastructureCheckers {
  return {
    neo4j: () => checkTcp(config.neo4jUri),
    ollama: () => checkOllama(config.ollamaBaseUrl, config.ollamaTimeoutMs),
    postgres: () => checkTcp(config.databaseUrl),
    redis: () => checkTcp(config.redisUrl),
  };
}

async function runCheck(
  name: DependencyName,
  required: boolean,
  checker: DependencyChecker,
): Promise<DependencyHealth> {
  const startedAt = performance.now();

  try {
    await checker();
    return {
      latencyMs: Math.round(performance.now() - startedAt),
      name,
      required,
      state: "up",
    };
  } catch (error) {
    return {
      latencyMs: Math.round(performance.now() - startedAt),
      message: asMessage(error),
      name,
      required,
      state: "down",
    };
  }
}

export function summarizeHealth(
  dependencies: readonly DependencyHealth[],
  timestamp = new Date().toISOString(),
): InfrastructureHealth {
  const requiredDependencyIsDown = dependencies.some(
    (dependency) => dependency.required && dependency.state === "down",
  );
  const optionalDependencyIsDown = dependencies.some(
    (dependency) => !dependency.required && dependency.state === "down",
  );

  return {
    dependencies,
    status: requiredDependencyIsDown
      ? "unhealthy"
      : optionalDependencyIsDown
        ? "degraded"
        : "healthy",
    timestamp,
  };
}

export async function checkInfrastructureHealth(
  config: ApplicationConfig,
  checkers: InfrastructureCheckers = defaultCheckers(config),
): Promise<InfrastructureHealth> {
  const dependencies = await Promise.all([
    runCheck("postgres", true, checkers.postgres),
    runCheck("neo4j", true, checkers.neo4j),
    runCheck("redis", true, checkers.redis),
    runCheck("ollama", false, checkers.ollama),
  ]);

  return summarizeHealth(dependencies);
}
