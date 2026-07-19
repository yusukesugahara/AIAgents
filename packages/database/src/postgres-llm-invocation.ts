import type { LlmInvocationRecord, LlmInvocationRepository } from '@ai-agents/llm';
import type { DatabaseConnection } from './client';

/** Persists LLM invocation metadata without prompts or generated content. */
export class PostgresLlmInvocationRepository implements LlmInvocationRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async recordInvocation(invocation: LlmInvocationRecord): Promise<void> {
    await this.database.client`
      INSERT INTO llm_invocations (
        run_id,
        provider,
        model,
        prompt_version,
        schema_name,
        schema_version,
        attempt,
        outcome,
        review_reason,
        input_tokens,
        output_tokens,
        total_tokens,
        estimated_cost_usd,
        duration_ms,
        created_at
      )
      VALUES (
        ${invocation.runId}::uuid,
        ${invocation.provider},
        ${invocation.model},
        ${invocation.promptVersion},
        ${invocation.schemaName},
        ${invocation.schemaVersion},
        ${invocation.attempt},
        ${invocation.outcome},
        ${invocation.reviewReason},
        ${invocation.inputTokens},
        ${invocation.outputTokens},
        ${invocation.totalTokens},
        ${invocation.estimatedCostUsd},
        ${invocation.durationMs},
        ${invocation.createdAt.toISOString()}
      )
    `;
  }
}
