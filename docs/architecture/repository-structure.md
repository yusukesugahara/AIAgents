# 複数AIエージェント向けリポジトリ構成

> この文書のディレクトリツリーとコード例は、新規エージェント追加時の推奨構成です。現行ファイル構成の一覧ではありません。`job-search-email`の現在の実装契約は[`../agents/job-search-email-agent/specification.md`](../agents/job-search-email-agent/specification.md)を参照してください。

## 1. 目的

このリポジトリは、用途の異なる複数のAIエージェントを同一基盤上で設計・実装・運用することを前提とします。

初期段階では、エージェントごとにAPI、Worker、データベースを分割せず、1つの実行基盤へエージェントモジュールを追加する**モジュラーモノリス**として実装します。

共通化するものは、HTTP API、ジョブ実行、Google連携、LLM接続、DB接続、ログ、暗号化です。エージェントごとに分離するものは、入力、出力、プロンプト、構造化出力、判定ルール、処理手順です。

## 2. 採用技術

| 用途 | 技術 |
|---|---|
| Runtime | Bun |
| Package manager | Bun |
| Monorepo | Bun Workspaces |
| HTTP API | Hono |
| Worker | Bunプロセス |
| Validation | Zod |
| Database | PostgreSQL 18.4 |
| ORM | Drizzle ORM |
| PostgreSQL driver | postgres.js |
| Test | `bun:test` |
| Local runtime | Docker Compose |

Honoは`apps/api`に限定して使用します。Workerやエージェントの業務処理にHonoを持ち込みません。

## 3. 推奨ディレクトリ構成

```text
AIAgents/
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts
│   │       ├── app.ts
│   │       ├── bootstrap.ts
│   │       ├── routes/
│   │       │   ├── auth.route.ts
│   │       │   ├── agents.route.ts
│   │       │   ├── runs.route.ts
│   │       │   ├── webhooks.route.ts
│   │       │   └── health.route.ts
│   │       └── middleware/
│   │           ├── auth.ts
│   │           ├── error-handler.ts
│   │           └── request-id.ts
│   │
│   ├── worker/
│   │   ├── package.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts
│   │       ├── bootstrap.ts
│   │       ├── job-loop.ts
│   │       └── job-handlers/
│   │           └── run-agent.handler.ts
│   │
│   └── web/                       # 管理画面が必要になった時点で追加
│
├── agents/
│   ├── job-search-email/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── manifest.ts
│   │       ├── agent.ts
│   │       ├── ports.ts
│   │       ├── policy.ts
│   │       ├── input.schema.ts
│   │       ├── output.schema.ts
│   │       ├── steps/
│   │       │   ├── fetch-email-thread.step.ts
│   │       │   ├── analyze-email.step.ts
│   │       │   ├── generate-reply.step.ts
│   │       │   ├── create-draft.step.ts
│   │       │   └── create-calendar-event.step.ts
│   │       ├── prompts/
│   │       │   ├── analyze-email.prompt.ts
│   │       │   └── generate-reply.prompt.ts
│   │       ├── evals/
│   │       │   ├── cases.json
│   │       │   └── evaluator.ts
│   │       └── tests/
│   │           ├── policy.test.ts
│   │           └── agent.test.ts
│   │
│   └── _template/
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── manifest.ts
│           ├── agent.ts
│           ├── ports.ts
│           ├── policy.ts
│           └── tests/
│
├── packages/
│   ├── agent-core/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── define-agent.ts
│   │       ├── agent-context.ts
│   │       ├── agent-registry.ts
│   │       ├── agent-runner.ts
│   │       ├── step-runner.ts
│   │       ├── idempotency.ts
│   │       └── errors.ts
│   │
│   ├── connector-google/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── oauth/
│   │       │   ├── oauth-client.ts
│   │       │   └── token-store.ts
│   │       ├── gmail/
│   │       │   ├── gmail-client.ts
│   │       │   ├── gmail-rest-client.ts
│   │       │   ├── mime-message.ts
│   │       │   └── gmail.types.ts
│   │       └── calendar/
│   │           ├── calendar-client.ts
│   │           └── calendar.types.ts
│   │
│   ├── llm/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── llm-provider.ts
│   │       ├── openai-provider.ts
│   │       ├── structured-output.ts
│   │       └── llm.types.ts
│   │
│   ├── database/
│   │   ├── drizzle.config.ts
│   │   ├── migrations/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── client.ts
│   │       ├── transaction.ts
│   │       ├── schema/
│   │       │   ├── index.ts
│   │       │   ├── users.ts
│   │       │   ├── connections.ts
│   │       │   ├── agent-jobs.ts
│   │       │   ├── agent-runs.ts
│   │       │   └── job-search-email.ts
│   │       └── repositories/
│   │           ├── connection.repository.ts
│   │           ├── agent-job.repository.ts
│   │           ├── agent-run.repository.ts
│   │           └── job-email.repository.ts
│   │
│   ├── config/
│   │   └── src/
│   │       ├── env.ts
│   │       └── env.schema.ts
│   │
│   ├── observability/
│   │   └── src/
│   │       ├── logger.ts
│   │       ├── metrics.ts
│   │       └── tracing.ts
│   │
│   └── testing/
│       └── src/
│           ├── fake-llm.ts
│           ├── fake-gmail.ts
│           └── test-context.ts
│
├── docs/
│   ├── architecture/
│   ├── agents/
│   └── decisions/
├── docker/
│   ├── api.Dockerfile
│   └── worker.Dockerfile
├── compose.yaml
├── package.json
├── tsconfig.base.json
├── bunfig.toml
├── bun.lock
└── README.md
```

## 4. `apps` の責務

`apps`には、実行可能なプログラムの起動処理だけを置きます。

### `apps/api`

Honoを使用し、次を担当します。

- Google OAuth開始・callback
- エージェント設定API
- 手動実行API
- 実行履歴API
- Gmail Push通知用Webhook
- Health check

APIルート内ではAI解析やGmail処理を実行せず、必要なジョブを登録して応答します。

### `apps/worker`

通常のBunプロセスとして動作し、次を担当します。

- PostgreSQLジョブキューの監視
- エージェントの起動
- ステップ実行
- リトライ
- タイムアウト
- ポーリングスケジュール
- 未完了処理の回復

WorkerではHonoを使用しません。

### `apps/web`

初期MVPでは作成しません。Google連携、設定、履歴、要確認一覧が必要になった時点でReactベースの管理画面を追加します。

## 5. `agents` の責務

`agents`には、各エージェント固有の業務フローを置きます。

```text
agents/<agent-id>/src/
├── manifest.ts      # ID、名称、バージョン、トリガー、必要権限
├── agent.ts         # ステップの実行順序
├── ports.ts         # 外部機能へのインターフェース
├── policy.ts        # 副作用のない実行可否ルール
├── input.schema.ts  # エージェント入力
├── output.schema.ts # エージェント出力
├── steps/           # ワークフローの各処理
├── prompts/         # プロンプトとバージョン
├── evals/           # LLM評価ケース
└── tests/           # Unit、Integration
```

エージェントは、Google SDK、OpenAI SDK、Drizzle ORMを直接importしてはいけません。`ports.ts`で必要な機能を宣言し、アプリケーション起動時に具体実装を注入します。

### マニフェスト例

```ts
export const manifest = {
  id: 'job-search-email',
  name: '就職活動メールエージェント',
  version: '0.1.0',
  triggers: ['manual', 'schedule', 'gmail-push'],
  requiredConnections: ['google', 'openai'],
  capabilities: [
    'gmail.read',
    'gmail.draft.create',
    'calendar.event.create',
  ],
  defaultEnabled: false,
} as const;
```

### Ports例

```ts
export interface JobSearchEmailPorts {
  gmail: {
    getThread(threadId: string): Promise<EmailThread>;
    createReplyDraft(input: CreateDraftInput): Promise<string>;
  };
  calendar: {
    createEvent(input: CreateCalendarEventInput): Promise<string>;
  };
  llm: {
    analyzeEmail(input: AnalyzeEmailInput): Promise<EmailAnalysis>;
    generateReply(input: GenerateReplyInput): Promise<string>;
  };
  runs: {
    saveStep(input: SaveRunStepInput): Promise<void>;
  };
}
```

### Policy例

```ts
export function shouldCreateDraft(analysis: EmailAnalysis): boolean {
  return (
    analysis.isJobRelated &&
    analysis.needsReply &&
    analysis.confidence >= 0.85
  );
}

export function shouldCreateCalendarEvent(analysis: EmailAnalysis): boolean {
  return (
    analysis.isJobRelated &&
    analysis.meeting.isConfirmed &&
    analysis.meeting.startAt !== null &&
    analysis.meeting.endAt !== null &&
    analysis.meeting.url !== null &&
    analysis.confidence >= 0.9
  );
}
```

Policyは通常のTypeScript関数として実装し、API呼び出しやDB操作を含めません。

## 6. `packages` の責務

複数エージェントから再利用する技術機能は`packages`へ置きます。

### `agent-core`

- エージェント登録
- 実行IDの発行
- Agent Context
- ステップ実行
- 冪等性
- 状態遷移
- リトライ
- エラー分類

### `connector-google`

- Google OAuth
- Gmail API
- MIME解析・生成
- Google Calendar API
- Google API固有型の変換

`googleapis`を採用する場合も、このパッケージ内だけで使用します。Bun互換性の問題が発生した場合は、REST APIと`fetch`を使う実装へ置き換えます。

### `llm`

- LLM Provider interface
- OpenAI実装
- Structured Outputs
- Function Calling / Tool Useループ
- Schema検証
- モデル名、使用量、実行時間の記録

### `database`

- Drizzle Schema
- Migration
- Transaction
- Repository実装
- PostgreSQLジョブキュー

エージェントからDrizzleを直接参照させません。

## 7. 依存方向

許可する依存方向は次のとおりです。

```text
apps
 ├── agents
 └── packages

agents
 ├── agent-coreの公開型
 └── 自身のportsで定義した型

packages
 └── 他の低レベルpackages
```

禁止する依存は次のとおりです。

- `packages`から特定の`agents`をimportする
- エージェント同士が内部実装を直接importする
- `agents`から`apps`をimportする
- `agents`からGoogle SDK、OpenAI SDK、Drizzleを直接importする
- API Routeからエージェント固有のStepを直接呼ぶ

具体実装の組み立ては`apps/*/src/bootstrap.ts`で行います。

## 8. Agent Runner

```ts
export interface AgentDefinition<TInput, TOutput> {
  manifest: {
    id: string;
    name: string;
    version: string;
  };
  run(context: AgentContext, input: TInput): Promise<TOutput>;
}
```

```ts
const registry = createAgentRegistry();

registry.register(
  createJobSearchEmailAgent({
    gmail: googleConnector.gmail,
    calendar: googleConnector.calendar,
    llm: openAiProvider,
    runs: agentRunRepository,
  }),
);
```

新しいエージェントは同じRegistryへ追加します。

## 9. データ管理

### 共通テーブル

- `users`
- `connections`
- `oauth_authorization_states`
- `agent_definitions`
- `agent_settings`
- `agent_jobs`
- `agent_runs`
- `agent_run_steps`
- `llm_invocations`
- `agent_errors`
- `review_requests`

### エージェント固有テーブル

- `job_email_analyses`
- `job_email_drafts`
- `job_calendar_events`

共通テーブルは実行基盤が管理し、固有テーブルはエージェントの業務状態を管理します。

## 10. PostgreSQLジョブキュー

初期MVPではRedisを追加せず、PostgreSQLをジョブキューとして使用します。

```text
agent_jobs
├── id
├── agent_id
├── input_json
├── status
├── idempotency_key
├── attempts
├── available_at
├── locked_at
├── locked_by
├── last_error
├── created_at
└── completed_at
```

Workerは`FOR UPDATE SKIP LOCKED`を使用してジョブを排他的に確保します。

```sql
SELECT *
FROM agent_jobs
WHERE status IN ('queued', 'retry_waiting')
  AND available_at <= NOW()
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

ジョブキューの呼び出し側は、将来Cloud TasksやBullMQへ交換できるようinterfaceを使用します。

## 11. Docker Compose構成

現在は次の4サービスを使用します。詳細なcommand、環境変数、依存関係、Health Check、公開ポートはリポジトリ直下の`compose.yaml`を正とします。

```text
api       Hono + Bun
worker    Bun
migrate   Drizzle Migration
postgres  PostgreSQL 18.4
```

PostgreSQLは`postgres:18.4`を使用し、永続Volumeは`/var/lib/postgresql`へマウントします。ホスト側の既定公開ポートは`15432`、コンテナ間接続は`postgres:5432`です。Bunコマンドはすべて`--no-env-file`を明示します。

## 12. Bun Workspaces

ルートの`package.json`は次を基本とします。

```json
{
  "name": "ai-agents",
  "private": true,
  "workspaces": [
    "apps/*",
    "agents/*",
    "packages/*"
  ],
  "scripts": {
    "dev:api": "bun --filter @ai-agents/api dev",
    "dev:worker": "bun --filter @ai-agents/worker dev",
    "test": "bun test",
    "typecheck": "bun run --workspaces typecheck"
  }
}
```

## 13. 設計原則

1. エージェントごとに入力、出力、権限、ルールを明示する。
2. AI出力は非信頼データとして扱う。
3. 外部書き込み前にSchemaとPolicyを通す。
4. 外部書き込みは冪等にする。
5. 自動送信、削除、購入などの高リスク操作は初期状態で無効にする。
6. プロンプトとSchemaにバージョンを付ける。
7. 実行入力、AI出力、根拠、外部操作、結果を記録する。
8. エラー時にステップ単位で再実行できるようにする。
9. エージェント内で外部SDKやORMへ直接依存しない。
10. 共通化は2つ以上のエージェントで必要になってから行う。
