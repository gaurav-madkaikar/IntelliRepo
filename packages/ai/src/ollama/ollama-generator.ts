import type { StructuredGenerationRequest, StructuredGenerator } from "../generator.js";
import { OllamaClient } from "./ollama-client.js";

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
}

export class OllamaStructuredGenerator implements StructuredGenerator {
  public constructor(
    private readonly client: OllamaClient,
    private readonly model: string,
  ) {}

  public async generate<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    let validationError = "unknown validation error";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.client.post<OllamaChatResponse>("/api/chat", {
        format: request.jsonSchema,
        messages:
          attempt === 0
            ? request.messages
            : [
                ...request.messages,
                {
                  content: `The previous response failed schema validation: ${validationError}. Return only a corrected JSON object.`,
                  role: "user",
                },
              ],
        model: this.model,
        options: { temperature: 0 },
        stream: false,
      });
      const content = response.message?.content;
      if (content === undefined) {
        validationError = "response did not contain message content";
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(content);
      } catch {
        validationError = "response was not valid JSON";
        continue;
      }
      const parsed = request.schema.safeParse(decoded);
      if (parsed.success) return parsed.data;
      validationError = parsed.error.message;
    }
    throw new Error(`Ollama structured output failed validation after retry: ${validationError}`);
  }
}
