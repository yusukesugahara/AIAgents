# 技術スタック仕様

## 1. 目的

AIAgentsで複数のAIエージェントを継続的に追加するため、初期MVPの標準技術スタックと利用範囲を定義します。

技術の選択肢を固定すること自体が目的ではありません。エージェント固有ロジックと外部SDKを分離し、必要になった場合に部分的に差し替えられる構造を維持します。

## 2. 標準技術スタック

| 分類 | 採用技術 | 用途 |
|---|---|---|
| Runtime | Bun | API、Worker、CLI、Test |
| Package manager | Bun | 依存管理、Workspace |
| API framework | Hono | HTTP API、OAuth callback、Webhook |
| Validation | Zod | API入力、環境変数、LLM構造化出力、Function Calling引数 |
| Database | PostgreSQL 18.4 | 永続化、ジョブキュー、冪等性 |
| Primary key | UUIDv7 | 時系列性が必要な内部ID |
| ORM | Drizzle ORM | Schema、Query、型推論 |
| DB driver | postgres.js | PostgreSQL接続 |
| Migration | Drizzle Kit | Migration生成と管理 |
| LLM | OpenAI Responses API | 分類、抽出、文章生成、自前Tool Useループ |
| Google連携 | `googleapis`またはREST | OAuth、Gmail、Calendar |
| Logging | 構造化JSONログ | 実行追跡、障害調査 |
| Testing | `bun:test` | Unit、Integration、Evaluation |
| Local runtime | Docker Compose | API、Worker、PostgreSQL |

## 3. Bunの利用範囲

Bunは次の用途に使用します。

- TypeScript runtime
- パッケージ管理
- Bun Workspaces
- Test runner
- 開発スクリプト
- APIとWorkerのDocker image

Node.js固有APIへの依存は、外部サービス用Adapterに閉じ込めます。特にGoogleの公式SDKを使う場合は、Bun上での動作確認をIntegration Testへ含めます。

Bun互換性の問題が発生した場合も、エージェント本体を変更せずAdapterだけをREST + `fetch`実装へ交換できるようにします。

## 4. Honoの利用範囲

Honoは`apps/api`だけで使用します。

### Honoが担当する処理

- HTTP routing
- Middleware
- API入力の検証
- OAuth redirectとcallback
- Webhook受信
- 管理API
- Health check

### Honoが担当しない処理

- Gmailのポーリング
- AI解析
- 返信文生成
- Gmail下書き作成
- Calendar予定作成
- リトライループ
- ジョブ実行

APIは長時間処理を行わず、ジョブを登録して`202 Accepted`を返す構成を基本とします。

## 5. Worker

WorkerはHonoを使用しない通常のBunプロセスです。

Workerの責務は次のとおりです。

- PostgreSQLジョブキューからジョブを確保する
- Agent Registryから対象エージェントを取得する
- Agent Runnerを起動する
- ステップ状態を保存する
- 一時エラーをリトライする
- ロック切れのジョブを回復する
- 定期ポーリングジョブを登録する

Workerの起動処理では、DB、外部Connector、LLM Provider、Repositoryを組み立ててエージェントへ注入します。

## 6. PostgreSQL 18.4

### 6.1 採用理由

- 新規開発であり、より長いサポート期間を利用できる
- Agent Run、Step、Job、Errorの内部IDに`uuidv7()`を標準機能として利用できる
- `FOR UPDATE SKIP LOCKED`を使ったジョブキューを構築できる
- JSONB、部分Index、Unique Constraint、Upsert、Transactionを利用できる
- Drizzle ORMとSQLを組み合わせやすい

### 6.2 Docker Volume

PostgreSQL 18では公式Docker Imageの永続Volumeを`/var/lib/postgresql`へマウントします。

```yaml
services:
  postgres:
    image: postgres:18.4
    volumes:
      - postgres_data:/var/lib/postgresql
```

新規構成ではPostgreSQL 17以前で一般的だった`/var/lib/postgresql/data`へのVolumeマウントを使用しません。

### 6.3 UUIDv7

次のような時系列性が必要な内部主キーに`uuidv7()`を使用します。

```text
connections.id
agent_jobs.id
agent_runs.id
agent_run_steps.id
agent_errors.id
review_requests.id
```

```ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid } from 'drizzle-orm/pg-core';

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
});
```

GmailやGoogle Calendarの外部IDはUUIDへ変換せず、文字列の専用カラムへ保存します。

### 6.4 本番環境

本番ではPostgreSQL 18対応のマネージドサービスを優先します。利用予定のサービスが18に未対応の場合のみ、一時的に本番を17とし、18対応後のアップグレード計画を同時に定義します。

ローカル開発とCIはPostgreSQL 18.4へ固定します。

## 7. Drizzle ORM

### 7.1 採用理由

- TypeScriptからSchemaを定義できる
- SQLとの距離が近い
- PostgreSQL固有機能を扱いやすい
- 複雑なQueryではSQLを併用できる
- Migration SQLを確認できる
- Hono + Bunの軽量な構成と合わせやすい

### 7.2 DB接続

初期MVPではDrizzle ORMと`postgres.js`を使用します。

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return {
    db: drizzle({ client }),
    close: () => client.end(),
  };
}
```

Bun組み込みSQLへ変更する場合は、並列処理、Transaction、Connection Pool、Migration、Docker環境を評価してからADRを更新します。

### 7.3 ORM境界

Drizzleの利用は`packages/database`へ限定します。

禁止例：

```ts
// agents/job-search-email/src/agent.ts
import { db } from '@ai-agents/database';
import { jobEmailMessages } from '@ai-agents/database/schema';
```

許可する形：

```ts
export interface JobEmailRepository {
  existsByGmailMessageId(messageId: string): Promise<boolean>;
  saveAnalysis(input: SaveAnalysisInput): Promise<void>;
}
```

具体的なDrizzle実装は`packages/database`に置きます。

## 8. Migration方針

- Schema変更はDrizzle SchemaからMigrationを生成する
- 生成されたSQLをレビューしてからコミットする
- 本番環境で`push`による直接同期を使用しない
- 適用済みMigrationを書き換えない
- PostgreSQL固有の部分Index、Constraint、FunctionはSQL Migrationで管理してよい
- Migration適用はAPI起動と分離し、明示的なコマンドで実行する
- PostgreSQL 18.4コンテナ上でMigration Testを実行する
- `uuidv7()`のデフォルト値をIntegration Testで検証する

推奨コマンド例：

```json
{
  "scripts": {
    "db:generate": "bun --filter @ai-agents/database drizzle-kit generate",
    "db:migrate": "bun --filter @ai-agents/database migrate",
    "db:studio": "bun --filter @ai-agents/database drizzle-kit studio"
  }
}
```

## 9. Transaction方針

次の処理は同一Transactionで行います。

- ジョブ確保と`processing`への状態更新
- Agent Run作成と最初のStep作成
- メール解析結果と処理状態の保存
- 外部操作成功結果と冪等性記録の保存

外部API呼び出し中にDB Transactionを長時間保持してはいけません。

```text
DBで実行予約を確保
  ↓ commit
外部APIを実行
  ↓
DBへ結果を保存
```

外部API成功後にDB保存だけが失敗した場合に備え、外部サービス側のIDと業務上の冪等性キーを利用して回復します。

## 10. PostgreSQLジョブキュー

初期段階ではRedisを追加せず、PostgreSQLを利用します。

必須要件：

- `FOR UPDATE SKIP LOCKED`による排他取得
- `idempotency_key`のUnique Constraint
- `available_at`による遅延実行
- `attempts`による上限管理
- `locked_at`と`locked_by`によるロック管理
- Worker停止時のロック回復
- 一時エラーと恒久エラーの分類

将来Cloud TasksやBullMQへ切り替える場合も、`JobQueue` interfaceは維持します。

## 11. Zod

Zodは次の境界で使用します。

- 環境変数
- Hono API入力
- Agent Input
- Agent Output
- LLM Structured OutputとFunction Calling引数
- Webhook payload
- DB JSONBから読み出した値

AIが返した値はSchema検証に成功するまで、ドメイン上の値として扱いません。

## 12. LLM Provider

エージェントはOpenAI SDKを直接importせず、`LlmProvider`へ依存します。ProviderはResponses APIの`function_call`を受け、アプリケーション側でツールを実行し、`function_call_output`を返す上限付きループを実装します。

モデル名、プロンプトバージョン、Schemaバージョン、Token使用量を実行履歴へ保存します。Run Stepにはツール名・回数だけを保存し、ツール引数、メール本文、生成本文は保存しません。

## 13. Google Connector

Google連携は`packages/connector-google`に限定します。

- OAuth URL生成
- Authorization Code交換
- Token更新
- Gmail message/thread取得
- MIME解析
- Gmail下書き作成
- Calendar予定作成
- Googleエラーの共通エラーへの変換

エージェントにGoogle固有レスポンス型を返さず、アプリケーション用の型へ変換します。

## 14. テスト方針

### Unit Test

- Policy
- Schema
- 状態遷移
- 冪等性キー生成
- Retry分類
- MIME整形

### Integration Test

- PostgreSQL 18.4 Repository
- Migration
- `uuidv7()`
- PostgreSQLジョブキュー
- Hono Route
- Google Adapter
- OpenAI Providerの構造化出力変換とFunction Callingループ

### Evaluation

- 就活メール判定
- 返信要否
- 日時抽出
- 会議URL抽出
- Prompt Injection耐性
- 返信文品質

外部APIを通常のCIで直接呼ばず、Fakeまたは記録済みFixtureを使用します。明示的なE2E環境でのみ実アカウントを使用します。

## 15. バージョン固定

- BunのDocker imageは具体的なVersionに固定する
- PostgreSQLは`18.4`へ固定する
- Lockfileを必ずコミットする
- SDKのMajor UpdateはADRまたはPR本文で影響を記録する
- Node.js互換性へ依存する外部SDKはIntegration Test対象にする
