import type { EmailMessage, EmailThread } from '@ai-agents/connector-google';
import type { JobEmailAnalysis } from './schemas';

export type AnalysisGroundingIssue =
  | 'company_not_found'
  | 'contact_not_found'
  | 'evidence_not_found'
  | 'meeting_time_not_found'
  | 'meeting_url_not_found';

/**
 * Rejects extracted facts that cannot be tied back to the validated Gmail payload.
 * Confidence is deliberately not used here: it is model-authored metadata, not evidence.
 */
export function validateAnalysisGrounding(
  analysis: JobEmailAnalysis,
  thread: EmailThread,
): { readonly issues: readonly AnalysisGroundingIssue[]; readonly valid: boolean } {
  const sourceFragments = thread.messages.flatMap(messageSourceFragments).map(normalizeForMatch);
  const contains = (value: string) => {
    const normalized = normalizeForMatch(value);
    return (
      normalized.length > 0 && sourceFragments.some((fragment) => fragment.includes(normalized))
    );
  };
  const issues = new Set<AnalysisGroundingIssue>();

  if (analysis.companyName && !contains(analysis.companyName)) issues.add('company_not_found');
  if (analysis.contactName && !contains(analysis.contactName)) issues.add('contact_not_found');
  if (analysis.meeting.url && !contains(analysis.meeting.url)) issues.add('meeting_url_not_found');
  if (
    analysis.meeting.isConfirmed &&
    analysis.meeting.startAt &&
    analysis.meeting.endAt &&
    !containsMeetingDateTime(analysis.meeting.startAt, analysis.meeting.endAt, sourceFragments)
  ) {
    issues.add('meeting_time_not_found');
  }
  if (analysis.evidence.some((evidence) => !contains(evidence))) issues.add('evidence_not_found');

  return { issues: [...issues], valid: issues.size === 0 };
}

function containsMeetingDateTime(
  startAt: string,
  endAt: string,
  normalizedSources: readonly string[],
): boolean {
  const start = localDateTimeParts(startAt);
  const end = localDateTimeParts(endAt);
  if (!start || !end) return false;
  const source = normalizedSources.join('\n');
  const hasDate = [
    `${start.year}-${start.monthPadded}-${start.dayPadded}`,
    `${start.year}/${start.month}/${start.day}`,
    `${start.year}年${start.month}月${start.day}日`,
    `${start.month}/${start.day}`,
    `${start.month}月${start.day}日`,
  ].some((candidate) => source.includes(candidate));
  const hasRelativeDate = /(?:本日|今日|明日|あす|翌日|明後日)/u.test(source);
  return (
    (hasDate || hasRelativeDate) &&
    containsTime(source, start.hour, start.minute) &&
    containsTime(source, end.hour, end.minute)
  );
}

function containsTime(source: string, hour: number, minute: number): boolean {
  const hourPadded = String(hour).padStart(2, '0');
  const minutePadded = String(minute).padStart(2, '0');
  return [
    `${hourPadded}:${minutePadded}`,
    `${hour}:${minutePadded}`,
    `${hour}時${minute === 0 ? '' : `${minute}分`}`,
  ].some((candidate) => source.includes(candidate));
}

function localDateTimeParts(value: string):
  | {
      readonly day: number;
      readonly dayPadded: string;
      readonly hour: number;
      readonly minute: number;
      readonly month: number;
      readonly monthPadded: string;
      readonly year: number;
    }
  | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})/u.exec(value.toLowerCase());
  if (!match) return undefined;
  return {
    day: Number(match[3]),
    dayPadded: match[3] as string,
    hour: Number(match[4]),
    minute: Number(match[5]),
    month: Number(match[2]),
    monthPadded: match[2] as string,
    year: Number(match[1]),
  };
}

function messageSourceFragments(message: EmailMessage): readonly string[] {
  return [
    message.bodyText,
    message.subject,
    message.from,
    message.replyTo ?? '',
    ...message.to,
    ...message.cc,
  ];
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, ' ').trim();
}
