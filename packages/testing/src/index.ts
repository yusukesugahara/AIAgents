export function createTestId(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export type { FakeLlmResponse } from './fake-llm';
export { FakeLlmProvider } from './fake-llm';
