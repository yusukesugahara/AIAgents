import type { LlmProvider, StructuredLlmRequest, StructuredLlmResult } from '@ai-agents/llm';

export type FakeLlmResponse = StructuredLlmResult<unknown> | Error;

/** Deterministic LLM port for Agent unit tests; it never contacts an external provider. */
export class FakeLlmProvider implements LlmProvider {
  readonly requests: StructuredLlmRequest<unknown>[] = [];

  constructor(private readonly responses: FakeLlmResponse[]) {}

  async generateStructured<TOutput>(
    request: StructuredLlmRequest<TOutput>,
  ): Promise<StructuredLlmResult<TOutput>> {
    this.requests.push(request as StructuredLlmRequest<unknown>);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('Fake LLM has no queued response');
    }
    if (response instanceof Error) {
      throw response;
    }
    return response as StructuredLlmResult<TOutput>;
  }
}
