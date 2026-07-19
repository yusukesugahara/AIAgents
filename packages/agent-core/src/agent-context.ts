export interface AgentContext {
  readonly runId: string;
  readonly agentId: string;
  readonly triggerType: string;
  readonly startedAt: Date;
}
