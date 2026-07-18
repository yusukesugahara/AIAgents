export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly triggers: readonly string[];
}
