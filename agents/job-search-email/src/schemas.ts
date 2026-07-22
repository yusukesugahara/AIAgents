import { z } from 'zod';

export const jobEmailCategorySchema = z.enum([
  'meeting_confirmed',
  'scheduling_request',
  'application_update',
  'document_request',
  'assignment',
  'offer',
  'rejection',
  'general',
  'not_job_related',
]);

export const replyIntentSchema = z.enum([
  'accept',
  'decline',
  'acknowledge',
  'submit_information',
  'request_clarification',
  'none',
]);

export const meetingUrlTypeSchema = z.enum(['web_meeting', 'scheduling_page', 'other', 'none']);

const nullableTrimmedText = z.string().trim().min(1).max(500).nullable();
const nullableDateTime = z.iso.datetime({ offset: true }).nullable();
const nullableHttpUrl = z
  .url()
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
    message: 'Meeting URL must use HTTP or HTTPS',
  })
  .nullable();

export const jobEmailAnalysisSchema = z
  .object({
    isJobRelated: z.boolean(),
    category: jobEmailCategorySchema,
    companyName: nullableTrimmedText,
    contactName: nullableTrimmedText,
    needsReply: z.boolean(),
    replyIntent: replyIntentSchema,
    missingRequiredInformation: z.array(z.string().trim().min(1).max(200)).max(20),
    meeting: z
      .object({
        isConfirmed: z.boolean(),
        startAt: nullableDateTime,
        endAt: nullableDateTime,
        timezone: z.string().trim().min(1).max(100).nullable(),
        url: nullableHttpUrl,
        urlType: meetingUrlTypeSchema,
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  })
  .strict()
  .superRefine((analysis, context) => {
    if (analysis.isJobRelated !== (analysis.category !== 'not_job_related')) {
      context.addIssue({
        code: 'custom',
        message: 'Job-related status and category must agree',
        path: ['category'],
      });
    }
    if (analysis.needsReply !== (analysis.replyIntent !== 'none')) {
      context.addIssue({
        code: 'custom',
        message: 'Reply requirement and intent must agree',
        path: ['replyIntent'],
      });
    }
    if (analysis.meeting.isConfirmed && !analysis.meeting.startAt) {
      context.addIssue({
        code: 'custom',
        message: 'A confirmed meeting must have an explicit start time',
        path: ['meeting', 'startAt'],
      });
    }
    if (analysis.meeting.isConfirmed !== (analysis.category === 'meeting_confirmed')) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmed meeting status and category must agree',
        path: ['meeting', 'isConfirmed'],
      });
    }
    if ((analysis.meeting.urlType === 'none') !== (analysis.meeting.url === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Meeting URL and URL type must agree',
        path: ['meeting', 'urlType'],
      });
    }
    if (analysis.meeting.urlType === 'scheduling_page' && analysis.meeting.isConfirmed) {
      context.addIssue({
        code: 'custom',
        message: 'A scheduling page is not a confirmed meeting',
        path: ['meeting', 'isConfirmed'],
      });
    }
    if (analysis.meeting.startAt && analysis.meeting.endAt) {
      if (Date.parse(analysis.meeting.endAt) <= Date.parse(analysis.meeting.startAt)) {
        context.addIssue({
          code: 'custom',
          message: 'Meeting end time must be after its start time',
          path: ['meeting', 'endAt'],
        });
      }
    }
    if (!analysis.meeting.startAt && analysis.meeting.endAt) {
      context.addIssue({
        code: 'custom',
        message: 'Meeting end time requires an explicit start time',
        path: ['meeting', 'endAt'],
      });
    }
    if (!analysis.meeting.startAt && analysis.meeting.timezone !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Timezone requires an explicit meeting start time',
        path: ['meeting', 'timezone'],
      });
    }
    if (analysis.meeting.startAt && analysis.meeting.timezone === null) {
      context.addIssue({
        code: 'custom',
        message: 'An explicit meeting start time requires a timezone',
        path: ['meeting', 'timezone'],
      });
    }
    if (
      !analysis.isJobRelated &&
      (analysis.companyName !== null ||
        analysis.contactName !== null ||
        analysis.missingRequiredInformation.length > 0 ||
        analysis.meeting.isConfirmed ||
        analysis.meeting.startAt !== null ||
        analysis.meeting.endAt !== null ||
        analysis.meeting.timezone !== null ||
        analysis.meeting.url !== null ||
        analysis.meeting.urlType !== 'none')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Non-job email must not contain job or meeting details',
        path: ['isJobRelated'],
      });
    }
  });

/**
 * JSON Schema sent to the OpenAI Structured Outputs endpoint.
 *
 * Luna accepts the same required fields, enums, nullability, and closed objects as the
 * final contract. Length, URL, date-time, and cross-field constraints remain in
 * `jobEmailAnalysisSchema`, where they are enforced after the response is received.
 */
export const jobEmailAnalysisStructuredOutputSchema = z
  .object({
    isJobRelated: z.boolean(),
    category: jobEmailCategorySchema,
    companyName: z.string().nullable(),
    contactName: z.string().nullable(),
    needsReply: z.boolean(),
    replyIntent: replyIntentSchema,
    missingRequiredInformation: z.array(z.string()),
    meeting: z
      .object({
        isConfirmed: z.boolean(),
        startAt: z.string().nullable(),
        endAt: z.string().nullable(),
        timezone: z.string().nullable(),
        url: z.string().nullable(),
        urlType: meetingUrlTypeSchema,
      })
      .strict(),
    confidence: z.number(),
    evidence: z.array(z.string()),
  })
  .strict();

export const jobSearchEmailInputSchema = z
  .object({
    googleConnectionId: z.uuid(),
    gmailMessageId: z.string().trim().min(1).max(255),
    gmailThreadId: z.string().trim().min(1).max(255),
  })
  .strict();

export const generatedReplySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024)
      .refine(
        (value) => !value.includes(String.fromCharCode(0)),
        'Reply body must not contain NUL',
      ),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string().trim().min(1).max(200)).max(10),
  })
  .strict();

export const jobSearchEmailOutputSchema = z
  .object({
    analysis: jobEmailAnalysisSchema.nullable(),
    draftId: z.string().trim().min(1).max(255).nullable(),
    calendarEventId: z.string().trim().min(1).max(1_024).nullable(),
    result: z.enum(['completed', 'skipped', 'needs_review']),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.analysis === null && output.result !== 'needs_review') {
      context.addIssue({
        code: 'custom',
        message: 'Only a needs-review result may omit analysis',
        path: ['analysis'],
      });
    }
    if (output.result === 'skipped' && output.draftId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Skipped results cannot contain a Draft ID',
        path: ['draftId'],
      });
    }
    if (output.result === 'skipped' && output.calendarEventId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Skipped results cannot contain a Calendar event ID',
        path: ['calendarEventId'],
      });
    }
    if (output.result === 'skipped' && output.analysis?.isJobRelated !== false) {
      context.addIssue({
        code: 'custom',
        message: 'Skipped analysis must be unrelated',
        path: ['result'],
      });
    }
    if (output.result === 'completed' && output.analysis?.isJobRelated !== true) {
      context.addIssue({
        code: 'custom',
        message: 'Completed analysis must be job-related',
        path: ['result'],
      });
    }
  });

export type JobEmailAnalysis = z.infer<typeof jobEmailAnalysisSchema>;
export type GeneratedReply = z.infer<typeof generatedReplySchema>;
export type JobSearchEmailInput = z.infer<typeof jobSearchEmailInputSchema>;
export type JobSearchEmailOutput = z.infer<typeof jobSearchEmailOutputSchema>;
