export interface Neo4jStatement {
  readonly cypher: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Driver-neutral port. Implementations must execute write batches in one Neo4j transaction. */
export interface Neo4jExecutor {
  read<T>(statement: Neo4jStatement): Promise<readonly T[]>;
  write(statements: readonly Neo4jStatement[]): Promise<void>;
}
