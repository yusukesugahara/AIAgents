import type {
  JobEmailCalendarSettings,
  JobEmailReplySettings,
  JobEmailSettingsRepository,
} from '@ai-agents/job-search-email';
import { z } from 'zod';
import type { DatabaseConnection } from './client';

const settingsSchema = z
  .object({
    calendarConfidenceThreshold: z.number().min(0).max(1).default(0.9),
    createCalendarEvents: z.boolean().default(true),
    createDrafts: z.boolean().default(true),
    draftConfidenceThreshold: z.number().min(0).max(1).default(0.85),
    emailSignature: z.string().max(2_000).default(''),
    replyStyle: z.literal('polite_concise').default('polite_concise'),
    timezone: z.string().trim().min(1).max(100).default('Asia/Tokyo'),
    userName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export class PostgresJobEmailSettingsRepository implements JobEmailSettingsRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async getReplySettings(googleConnectionId: string): Promise<JobEmailReplySettings | null> {
    const settings = await this.#getSettings(googleConnectionId);
    if (!settings) return null;
    return {
      createDrafts: settings.enabled && settings.data.createDrafts,
      draftConfidenceThreshold: settings.data.draftConfidenceThreshold,
      emailSignature: settings.data.emailSignature,
      googleEmail: settings.googleEmail,
      userName: settings.data.userName ?? null,
    };
  }

  async getCalendarSettings(googleConnectionId: string): Promise<JobEmailCalendarSettings | null> {
    const settings = await this.#getSettings(googleConnectionId);
    if (!settings) return null;
    return {
      calendarConfidenceThreshold: settings.data.calendarConfidenceThreshold,
      createCalendarEvents: settings.enabled && settings.data.createCalendarEvents,
      timezone: settings.data.timezone,
    };
  }

  async #getSettings(googleConnectionId: string): Promise<{
    data: z.infer<typeof settingsSchema>;
    enabled: boolean;
    googleEmail: string;
  } | null> {
    const [row] = (await this.database.client`
      SELECT connections.google_email, agent_settings.enabled, agent_settings.settings_json
      FROM connections
      LEFT JOIN agent_settings
        ON agent_settings.user_id = connections.user_id
       AND agent_settings.agent_id = 'job-search-email'
      WHERE connections.id = ${googleConnectionId}::uuid
        AND connections.type = 'google'
      LIMIT 1
    `) as Array<{ enabled: boolean | null; google_email: string; settings_json: unknown | null }>;
    if (!row || row.enabled === null || row.settings_json === null) return null;
    const settings = settingsSchema.safeParse(row.settings_json);
    if (!settings.success) return null;
    return {
      data: settings.data,
      enabled: row.enabled,
      googleEmail: row.google_email.toLowerCase(),
    };
  }
}
