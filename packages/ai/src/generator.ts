import type { z } from "zod";

export interface GenerationMessage {
  readonly content: string;
  readonly role: "assistant" | "system" | "user";
}

export interface StructuredGenerationRequest<T> {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly messages: readonly GenerationMessage[];
  readonly schema: z.ZodType<T>;
}

export interface StructuredGenerator {
  generate<T>(request: StructuredGenerationRequest<T>): Promise<T>;
}
