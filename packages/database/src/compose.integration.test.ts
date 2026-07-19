import { describe, expect, test } from 'bun:test';

const dockerIntegrationEnabled = process.env.DOCKER_INTEGRATION_TESTS === '1';
const oauthEmail = `compose-oauth-${crypto.randomUUID()}@example.com`;
const composeEnvironment = {
  ...process.env,
  API_HOST_PORT: '14000',
  APP_ENV: 'test',
  COMPOSE_PROJECT_NAME: 'ai_agents_pr02_integration',
  GOOGLE_CLIENT_ID: 'compose-client-id',
  GOOGLE_CLIENT_SECRET: 'compose-client-secret',
  GOOGLE_OAUTH_E2E_EMAIL: oauthEmail,
  GOOGLE_REDIRECT_URI: 'http://localhost:14000/auth/google/callback',
  POSTGRES_HOST_PORT: '15432',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(command: string[], allowFailure = false): CommandResult {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: new URL('../../..', import.meta.url).pathname,
    env: composeEnvironment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed\n${stderr || stdout}`);
  }

  return { stdout, stderr };
}

function compose(args: string[], allowFailure = false): CommandResult {
  return runCommand(
    ['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose.e2e.yaml', ...args],
    allowFailure,
  );
}

async function waitForStatus(path: string, expectedStatus: number): Promise<Response> {
  let lastStatus: number | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${composeEnvironment.API_HOST_PORT}${path}`);
      lastStatus = response.status;
      if (lastStatus === expectedStatus) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(500);
  }

  throw new Error(
    `Timed out waiting for ${path} to return ${expectedStatus}; last status: ${String(lastStatus)}, last error: ${String(lastError)}`,
  );
}

function postgres(query: string): string {
  return compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'ai_agents',
    '-At',
    '-c',
    query,
  ]).stdout;
}

describe.skipIf(!dockerIntegrationEnabled)('Docker Compose Agent execution', () => {
  test('starts safely, migrates idempotently, reports health, persists data, and stops gracefully', async () => {
    const email = `compose-${crypto.randomUUID()}@example.com`;
    const idempotencyKey = `compose-e2e-${crypto.randomUUID()}`;
    let apiContainerId = '';
    let workerContainerId = '';

    try {
      compose(['up', '--build', '--detach']);

      await waitForStatus('/health/live', 200);
      await waitForStatus('/health/ready', 200);

      compose(['exec', '-T', 'api', 'bun', 'run', 'db:migrate']);
      compose(['exec', '-T', 'api', 'bun', 'run', 'db:migrate']);

      const oauthStart = await fetch(
        `http://localhost:${composeEnvironment.API_HOST_PORT}/auth/google`,
        { redirect: 'manual' },
      );
      expect(oauthStart.status).toBe(303);
      const oauthCookie = oauthStart.headers.get('set-cookie')?.split(';')[0] ?? '';
      const authorizationUrl = oauthStart.headers.get('location') ?? '';
      expect(oauthCookie).toContain('ai_agents_oauth_nonce=');
      expect(authorizationUrl).toStartWith(
        `http://localhost:${composeEnvironment.API_HOST_PORT}/auth/google/callback?`,
      );

      const oauthCallback = await fetch(authorizationUrl, {
        headers: { Cookie: oauthCookie },
        redirect: 'manual',
      });
      expect(oauthCallback.status).toBe(303);
      expect(oauthCallback.headers.get('location')).toBe('/auth/google/complete');
      expect(oauthCallback.headers.get('location')).not.toContain('fake-authorization-code');

      const storedOAuthConnection = postgres(`
        SELECT users.email || '|' || connections.encrypted_refresh_token
        FROM connections
        JOIN users ON users.id = connections.user_id
        WHERE connections.google_email = '${oauthEmail}';
      `);
      expect(storedOAuthConnection).toStartWith(`${oauthEmail}|v1.`);
      expect(storedOAuthConnection).not.toContain('fake-refresh-token');
      expect(
        postgres(`
          SELECT COUNT(*)
          FROM oauth_authorization_states
          WHERE consumed_at IS NOT NULL;
        `),
      ).toBe('1');

      const enqueueResponse = await fetch(
        `http://localhost:${composeEnvironment.API_HOST_PORT}/agents/echo/runs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'compose-e2e' },
          body: JSON.stringify({ input: { value: 'compose' }, idempotencyKey }),
        },
      );
      expect(enqueueResponse.status).toBe(202);
      const { jobId } = (await enqueueResponse.json()) as { jobId: string };

      let jobStatus = '';
      let runId: string | null = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const jobResponse = await fetch(
          `http://localhost:${composeEnvironment.API_HOST_PORT}/jobs/${jobId}`,
        );
        const body = (await jobResponse.json()) as {
          job: { latestRunId: string | null; status: string };
        };
        jobStatus = body.job.status;
        if (jobStatus === 'completed') {
          runId = body.job.latestRunId;
          break;
        }
        await Bun.sleep(250);
      }
      expect(jobStatus).toBe('completed');
      expect(runId).not.toBeNull();
      const runResponse = await fetch(
        `http://localhost:${composeEnvironment.API_HOST_PORT}/runs/${runId}`,
      );
      expect(runResponse.status).toBe(200);
      expect(await runResponse.json()).toMatchObject({
        run: { id: runId, jobId, status: 'completed' },
      });

      expect(postgres('SHOW server_version;')).toStartWith('18.4');

      const userId = postgres(`INSERT INTO users (email) VALUES ('${email}') RETURNING id;`).split(
        '\n',
      )[0];
      expect(userId?.[14]).toBe('7');

      compose(['stop', 'postgres']);
      await waitForStatus('/health/ready', 503);
      compose(['start', 'postgres']);
      await waitForStatus('/health/ready', 200);

      apiContainerId = compose(['ps', '--quiet', 'api']).stdout;
      workerContainerId = compose(['ps', '--quiet', 'worker']).stdout;
      compose(['stop', 'api', 'worker']);

      expect(
        runCommand(['docker', 'inspect', '--format', '{{.State.ExitCode}}', apiContainerId]).stdout,
      ).toBe('0');
      expect(
        runCommand(['docker', 'inspect', '--format', '{{.State.ExitCode}}', workerContainerId])
          .stdout,
      ).toBe('0');

      compose(['down']);
      compose(['up', '--detach', 'postgres']);

      let persistedEmail = '';
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const result = compose(
          [
            'exec',
            '-T',
            'postgres',
            'psql',
            '-U',
            'postgres',
            '-d',
            'ai_agents',
            '-At',
            '-c',
            `SELECT email FROM users WHERE email = '${email}';`,
          ],
          true,
        );
        persistedEmail = result.stdout;
        if (persistedEmail === email) {
          break;
        }
        await Bun.sleep(500);
      }

      expect(persistedEmail).toBe(email);
    } finally {
      compose(['down', '--volumes', '--remove-orphans'], true);
    }
  }, 240_000);
});
