import type { DatabaseConnection } from './client';

export const integrationEnabled = process.env.INTEGRATION_TESTS === '1';
export const databaseUrl = process.env.DATABASE_URL;
export const integrationDatabaseUrl = databaseUrl ?? '';

export async function applyMigrationFile(
  connection: DatabaseConnection,
  migrationName: string,
): Promise<void> {
  const migration = await Bun.file(
    new URL(`../migrations/${migrationName}`, import.meta.url),
  ).text();
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await connection.client.unsafe(statement);
  }
}

export function runMigrations(): void {
  const result = Bun.spawnSync({
    cmd: ['bun', '--no-env-file', 'run', '--filter', '@ai-agents/database', 'db:migrate'],
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
