import type {
  LlmProvider,
  StructuredLlmRequest,
  StructuredLlmResult,
  ToolLoopLlmRequest,
} from '@ai-agents/llm';

export type FakeLlmResponse = StructuredLlmResult<unknown> | Error;

/** Deterministic LLM port for Agent unit tests; it never contacts an external provider. */
export class FakeLlmProvider implements LlmProvider {
  readonly requests: StructuredLlmRequest<unknown>[] = [];
  readonly toolExecutions: Array<{ arguments: unknown; name: string; output: unknown }> = [];
  readonly toolLoopRequests: ToolLoopLlmRequest<unknown>[] = [];

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

  async runToolLoop<TOutput>(
    request: ToolLoopLlmRequest<TOutput>,
  ): Promise<StructuredLlmResult<TOutput>> {
    this.requests.push(request as StructuredLlmRequest<unknown>);
    this.toolLoopRequests.push(request as ToolLoopLlmRequest<unknown>);
    const response = this.responses.shift();
    if (!response) {
      if (typeof request.initialToolChoice !== 'object') {
        throw new Error('Fake LLM has no queued response');
      }
      const selectedToolName = request.initialToolChoice.name;
      const tool = request.tools.find((candidate) => candidate.name === selectedToolName);
      const emptyArguments = tool?.schema.safeParse({});
      const completed = request.schema.safeParse({ status: 'completed' });
      if (!tool || !emptyArguments?.success || !completed.success) {
        throw new Error('Fake LLM has no queued response');
      }
      const output = await tool.execute(emptyArguments.data, { callId: 'fake-tool-call' });
      this.toolExecutions.push({ arguments: emptyArguments.data, name: tool.name, output });
      return {
        data: completed.data,
        metadata: fakeMetadata(request, tool.name),
        status: 'completed',
      };
    }
    if (response instanceof Error) throw response;
    if (response.status === 'completed' && typeof request.initialToolChoice === 'object') {
      const selectedToolName = request.initialToolChoice.name;
      const tool = request.tools.find((candidate) => candidate.name === selectedToolName);
      const arguments_ = tool?.schema.safeParse(response.data);
      if (!tool || !arguments_?.success) {
        return response as StructuredLlmResult<TOutput>;
      }
      const output = await tool.execute(arguments_.data, { callId: 'fake-tool-call' });
      this.toolExecutions.push({ arguments: arguments_.data, name: tool.name, output });
      const completed = request.schema.safeParse({ status: 'completed' });
      if (completed.success) {
        return {
          data: completed.data,
          metadata: {
            ...response.metadata,
            toolCalls: [{ callId: 'fake-tool-call', name: tool.name }],
          },
          status: 'completed',
        };
      }
    }
    if (response.status === 'completed' && request.initialToolChoice === 'required') {
      const executed = [];
      for (const name of request.requiredToolNames ?? []) {
        const tool = request.tools.find((candidate) => candidate.name === name);
        const arguments_ = tool?.schema.safeParse({});
        if (!tool || !arguments_?.success) continue;
        const output = await tool.execute(arguments_.data, { callId: `fake-${name}` });
        this.toolExecutions.push({ arguments: arguments_.data, name, output });
        executed.push({ callId: `fake-${name}`, name });
      }
      return {
        data: response.data as TOutput,
        metadata: { ...response.metadata, toolCalls: executed },
        status: 'completed',
      };
    }
    return response as StructuredLlmResult<TOutput>;
  }
}

function fakeMetadata(request: ToolLoopLlmRequest<unknown>, toolName: string) {
  return {
    attempts: 1,
    durationMs: 0,
    estimatedCostUsd: null,
    model: request.model,
    promptVersion: request.promptVersion,
    schemaName: request.schemaName,
    schemaVersion: request.schemaVersion,
    toolCalls: [{ callId: 'fake-tool-call', name: toolName }],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}
