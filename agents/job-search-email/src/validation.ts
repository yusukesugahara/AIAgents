import type { EmailThread } from '@ai-agents/connector-google';

export function extractAddress(value: string): string | null {
  const candidate = /<([^<>\s@]+@[^<>\s@]+)>/u.exec(value)?.[1] ?? value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate) ? candidate.toLowerCase() : null;
}

export function isMessageId(value: string): boolean {
  return /^<[^<>\r\n]+>$/u.test(value) && Buffer.byteLength(value, 'utf8') <= 512;
}

export function isSafeHeaderValue(value: string): boolean {
  return Boolean(value.trim()) && !/[\r\n]/u.test(value);
}

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isLatestReplyTarget(
  thread: EmailThread,
  targetMessageId: string,
  userEmail: string,
): boolean {
  const latestMessage = [...thread.messages]
    .sort(
      (left, right) =>
        left.sentAt.getTime() - right.sentAt.getTime() || left.id.localeCompare(right.id),
    )
    .at(-1);
  return (
    latestMessage?.id === targetMessageId &&
    extractAddress(latestMessage.from) !== userEmail.toLowerCase()
  );
}
