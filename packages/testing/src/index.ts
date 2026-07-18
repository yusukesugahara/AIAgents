export function createTestId(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
