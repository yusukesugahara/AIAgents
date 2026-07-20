# AIAgents 実装計画

## 1. 文書情報

| 項目 | 内容 |
|---|---|
| プロジェクト名 | AIAgents |
| アーキテクチャ | モジュラーモノリス |
| 最初のエージェント | 就職活動メールエージェント |
| 実行環境 | Docker Compose |
| データベース | PostgreSQL 18.4 |
| ステータス | Draft |
| バージョン | 0.3.0 |

## 2. プロジェクトの目的

AIAgentsは、用途の異なる複数のAIエージェントを、共通の実行基盤上で開発・実行・監視するためのリポジトリです。

各エージェントで次の機能を個別実装せず、共通基盤として再利用します。

- Agent実行
- ジョブ管理
- リトライ
- 冪等性制御
- LLM接続
- 外部サービス接続
- Google OAuth
- データベース接続
- 実行履歴
- エラー管理
- ログ
- 設定管理
- Human-in-the-loop

最初のエージェントとして、Gmailに届いた就職活動関連メールを解析し、返信下書きとGoogle Calendar予定を作成する「就職活動メールエージェント」を実装します。

## 3. 技術スタック

| 領域 | 採用技術 |
|---|---|
| Runtime | Bun |
| Package manager | Bun Workspaces |
| HTTP API | Hono |
| Worker | Bunプロセス |
| Language | TypeScript |
| Validation | Zod |
| Database | PostgreSQL 18.4 |
| ORM | Drizzle ORM |
| PostgreSQL Driver | postgres.js |
| Migration | Drizzle Kit |
| Primary Key | UUIDv7を原則使用 |
| Unit Test | `bun:test` |
| Local environment | Docker Compose |
| LLM | OpenAI API |
| Google連携 | Google OAuth 2.0 |
| メール | Gmail API |
| カレンダー | Google Calendar API |
| Logging | JSON形式の構造化ログ |
| CI | GitHub Actions |

## 4. 基本アーキテクチャ

AIAgentsは、エージェントごとにAPI、Worker、DBを分離するマイクロサービスではなく、最初はモジュラーモノリスとして実装します。

```text
┌─────────────────────────┐
│ Hono API                │
│                         │
│ OAuth                   │
│ Agent実行受付            │
│ 設定API                  │
│ 履歴API                  │
│ Webhook                  │
└────────────┬────────────┘
             │ Job登録
             ▼
┌─────────────────────────┐
│ PostgreSQL Job Queue    │
└────────────┬────────────┘
             │ Job取得
             ▼
┌─────────────────────────┐
│ Bun Worker              │
│                         │
│ Agent Registry          │
│ Agent Runner            │
│ Step Runner             │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Agent                   │
│                         │
│ manifest                │
│ agent                   │
│ ports                   │
│ policy                  │
│ steps                   │
│ prompts                 │
│ schemas                 │
└────────────┬────────────┘
             │ Port
             ▼
┌─────────────────────────┐
│ 共通Adapter             │
│                         │
│ Google                  │
│ OpenAI                  │
│ Drizzle Repository      │
└─────────────────────────┘
```

## 5. 実装原則

### 5.1 最初に縦に通す

共通基盤をすべて完成させてからエージェントを作るのではなく、最小限の共通基盤を作り、最初のエージェントを最後まで動かします。

最初の完成フローは次のとおりです。

```text
手動API実行
  ↓
PostgreSQLへJob登録
  ↓
WorkerがJob取得
  ↓
Gmailからスレッド取得
  ↓
OpenAIでメール解析
  ↓
返信条件をPolicyで判定
  ↓
Gmailへ返信下書き作成
  ↓
Calendar登録条件をPolicyで判定
  ↓
Google Calendarへ予定作成
  ↓
実行結果保存
```

このフローが完成してから、Gmail自動ポーリング、管理画面、Push通知を追加します。

### 5.2 AIと外部操作を分離する

AIは次だけを担当します。

- 分類
- 情報抽出
- 要約
- 返信文生成

AIに次を任せません。

- OAuth処理
- 権限判定
- 重複判定
- 下書き作成の最終可否
- Calendar登録の最終可否
- メール送信
- データ削除
- リトライ制御

外部書き込み前に、必ず通常のTypeScriptコードによるPolicy判定を実行します。

```text
外部データ取得
  ↓
AI解析
  ↓
Zod Schema検証
  ↓
TypeScript Policy検証
  ↓
外部サービスへの書き込み
```

### 5.3 エージェントを外部SDKから分離する

エージェントから次を直接importしません。

```text
googleapis
openai
drizzle-orm
postgres
hono
```

エージェントが必要とする外部処理は`ports.ts`で定義します。

```text
Agent
  ↓
Port interface
  ↓
Adapter
  ↓
外部API・データベース
```

### 5.4 高リスク操作を初期実装しない

初期リリースでは次を実装しません。

- メール自動送信
- メール削除
- メール自動アーカイブ
- Calendar予定の自動変更
- Calendar予定の自動削除
- 相手との自動日程交渉
- 添付ファイルの自動提出
- 求人への自動応募

### 5.5 各PRを単独で検証可能にする

各PRには次を含めます。

- 実装内容
- 自動テスト
- 手動確認手順
- 受け入れ条件
- 仕様書の更新
- 未実装事項
- エラー処理
- セキュリティ確認

## 6. 推奨フォルダ構成

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
│   │       └── middleware/
│   ├── worker/
│   │   ├── package.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts
│   │       ├── bootstrap.ts
│   │       ├── job-loop.ts
│   │       ├── job-handlers/
│   │       └── schedulers/
│   └── web/
│       └── （MVP完成後に追加）
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
│   │       ├── analysis.schema.ts
│   │       ├── steps/
│   │       ├── prompts/
│   │       ├── evals/
│   │       └── tests/
│   └── _template/
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── manifest.ts
│           ├── agent.ts
│           ├── ports.ts
│           ├── policy.ts
│           └── tests/
├── packages/
│   ├── agent-core/
│   ├── connector-google/
│   ├── llm/
│   ├── database/
│   ├── config/
│   ├── observability/
│   └── testing/
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
├── .env.example
└── README.md
```

## 7. 依存関係ルール

許可する依存方向は次のとおりです。

```text
apps
  ↓
agents
  ↓
agent-coreの型・Port interface

apps
  ↓
packagesの具体実装
```

具体実装の組み立てはComposition Rootで行います。

```text
apps/api/src/bootstrap.ts
apps/worker/src/bootstrap.ts
```

禁止する依存関係は次のとおりです。

```text
packages → 特定Agent
connector-google → job-search-email
database → Agent Workflow
Agent → Hono
Agent → Drizzle
Agent → Google SDK
Agent → OpenAI SDK
Agent A → Agent Bの内部実装
```

複数のAgentで共通利用する処理が出た場合は、Agent間で直接共有せず、`packages/`へ昇格させます。

## 8. PostgreSQL 18.4設計

### 8.1 Docker構成

```yaml
services:
  api:
    build:
      context: .
      dockerfile: docker/api.Dockerfile
    ports:
      - "4000:4000"
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy

  worker:
    build:
      context: .
      dockerfile: docker/worker.Dockerfile
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:18.4
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ai_agents
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql
    healthcheck:
      test:
        - CMD-SHELL
        - pg_isready -U postgres -d ai_agents
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
```

PostgreSQL 18では、Docker Volumeを`/var/lib/postgresql`へマウントします。

### 8.2 UUID方針

時系列性が必要な内部IDには、PostgreSQL 18の`uuidv7()`を原則使用します。

対象例は次のとおりです。

```text
connections.id
agent_jobs.id
agent_runs.id
agent_run_steps.id
agent_errors.id
review_requests.id
```

Drizzle Schema例：

```ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid } from 'drizzle-orm/pg-core';

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
});
```

外部サービスのIDは変換せず、文字列として別カラムへ保存します。

```text
gmail_message_id
gmail_thread_id
gmail_draft_id
google_calendar_event_id
google_connection_subject
```

## 9. 共通データモデル

### 9.1 共通テーブル

```text
users
connections
agent_definitions
agent_settings
agent_jobs
agent_runs
agent_run_steps
agent_errors
review_requests
```

### 9.2 Agent固有テーブル

```text
job_email_messages
job_email_analyses
job_email_drafts
job_calendar_events
gmail_sync_states
```

### 9.3 Job状態

```text
QUEUED
  ↓
PROCESSING
  ├── RETRY_WAITING
  ├── FAILED
  └── COMPLETED
```

### 9.4 Agent Run状態

```text
QUEUED
  ↓
RUNNING
  ├── NEEDS_REVIEW
  ├── RETRY_WAITING
  ├── FAILED
  └── COMPLETED
```

### 9.5 Step状態

```text
PENDING
  ↓
RUNNING
  ├── SKIPPED
  ├── FAILED
  └── COMPLETED
```

## 10. 全体マイルストーン

| マイルストーン | 完成状態 |
|---|---|
| M1 基盤起動 | API、Worker、PostgreSQL 18.4がDockerで起動する |
| M2 Agent実行 | 共通Agent RunnerでテストAgentを実行できる |
| M3 Google連携 | OAuthでGmailとCalendarを連携できる |
| M4 メール解析 | Gmailメールを取得してAI解析結果を保存できる |
| M5 下書き作成 | 元スレッドに返信下書きを作成できる |
| M6 Calendar登録 | 確定Web面談を重複なく登録できる |
| M7 手動MVP | APIから一連の処理を手動実行できる |
| M8 自動実行 | 新着メールを定期的に自動処理できる |
| M9 運用可能 | エラー、要確認、履歴、再実行を管理できる |
| M10 本番対応 | Gmail Push通知とクラウド環境で運用できる |

## 11. PR単位の実装計画

### PR-01 リポジトリ基盤

#### 目的

Bun Workspacesによるモノレポを初期化し、API、Worker、Agent、共通パッケージを追加できる状態にします。

#### 実装内容

- Bun Workspaces設定
- `apps/`、`agents/`、`packages/`作成
- TypeScript共通設定
- パッケージ命名規則
- BiomeまたはESLint設定
- `bun:test`設定
- `.gitignore`
- `.env.example`
- GitHub Actions
- 共通スクリプト
- 最小のHono API
- 最小のBun Worker
- Agentテンプレート

#### 受け入れ条件

- [ ] `bun install`が成功する。
- [ ] `bun run typecheck`が成功する。
- [ ] `bun run lint`が成功する。
- [ ] `bun test`が成功する。
- [ ] 各Workspaceから共通パッケージをimportできる。
- [ ] GitHub Actionsでlint、typecheck、testが実行される。

### PR-02 Docker・PostgreSQL 18.4・Drizzle基盤

#### 目的

API、Worker、PostgreSQL 18.4をDocker Composeで起動し、Drizzle Migrationを実行できるようにします。

#### 実装内容

- PostgreSQL 18.4コンテナ
- APIコンテナ
- Workerコンテナ
- PostgreSQL Volume
- Docker healthcheck
- Drizzle ORM
- postgres.js
- Drizzle Kit
- Migrationコマンド
- DB接続
- Graceful Shutdown
- `GET /health/live`
- `GET /health/ready`
- UUIDv7デフォルト値
- DB Integration Test

#### 初期テーブル

```text
users
connections
agent_definitions
agent_settings
agent_jobs
agent_runs
agent_run_steps
agent_errors
review_requests
```

#### 受け入れ条件

- [ ] `docker compose up --build`で全サービスが起動する。
- [ ] PostgreSQLのバージョンが18.4である。
- [ ] `GET /health/live`が200を返す。
- [ ] DB接続可能な場合、`GET /health/ready`が200を返す。
- [ ] DB停止時、`GET /health/ready`が503を返す。
- [ ] APIからDBへ接続できる。
- [ ] WorkerからDBへ接続できる。
- [ ] Migrationを複数回実行しても重複適用されない。
- [ ] UUIDv7がDB側で生成される。
- [ ] コンテナ再起動後もデータが保持される。
- [ ] SIGTERM時にDB接続が正常終了する。

### PR-03 Agent Core最小実装

#### 目的

複数のAgentを登録、検索、実行できる共通基盤を作ります。

#### 実装対象

```text
packages/agent-core/src/
├── define-agent.ts
├── agent-context.ts
├── agent-registry.ts
├── agent-runner.ts
├── agent.types.ts
├── idempotency.ts
└── errors.ts
```

#### 実装内容

- Agent Manifest
- Agent Registry
- Agent Runner
- Agent Context
- Run ID発行
- 入力Schema検証
- 出力Schema検証
- Run保存
- エラー分類
- テスト用Agent

#### 受け入れ条件

- [ ] AgentをRegistryへ登録できる。
- [ ] Agent IDからAgentを取得できる。
- [ ] 未登録Agentは明示的なエラーになる。
- [ ] 不正入力は実行前に拒否される。
- [ ] Runの開始と終了が保存される。
- [ ] Agent例外が共通エラーへ変換される。
- [ ] Fake AgentによるUnit Testが通る。

### PR-04 PostgreSQLジョブキュー

#### 目的

APIとWorkerを分離し、Agent実行要求を非同期処理できるようにします。

#### 実装内容

- Job Queueインターフェース
- PostgreSQL Job Queue
- `FOR UPDATE SKIP LOCKED`
- idempotency key
- retry count
- `available_at`
- lock timeout
- stale job回収
- Workerポーリングループ
- Graceful Shutdown
- 複数Worker対応

#### 受け入れ条件

- [ ] APIからJobを登録できる。
- [ ] WorkerがJobを取得できる。
- [ ] 複数Workerが同じJobを取得しない。
- [ ] 同じidempotency keyを重複登録しない。
- [ ] stale jobを再取得できる。
- [ ] 一時エラーを再試行できる。
- [ ] 最大試行回数超過後は`FAILED`になる。

### PR-05 Hono API基盤

#### 目的

Agent、Job、Runを操作するHTTP APIを実装します。

#### API

```text
GET  /health/live
GET  /health/ready
GET  /agents
GET  /agents/:agentId
POST /agents/:agentId/runs
GET  /jobs/:jobId
GET  /runs/:runId
```

#### 実装内容

- Hono App Factory
- Composition Root
- Factory関数による依存注入
- Zod Validator
- Request ID
- 構造化ログ
- 共通エラーレスポンス
- Agent実行受付
- Job取得
- Run取得

#### 受け入れ条件

- [ ] Agent一覧を取得できる。
- [ ] Agent実行APIがJob IDを返す。
- [ ] Agent完了を待たず202を返す。
- [ ] 不正入力は400になる。
- [ ] 存在しないAgentは404になる。
- [ ] 予期しない例外は共通形式の500になる。

### PR-06 Google OAuth

#### 目的

Googleアカウントを連携し、GmailとCalendarをバックグラウンドから利用できるようにします。

#### API

```text
GET    /auth/google/start
GET    /auth/google/callback
GET    /connections/google
DELETE /connections/google
```

#### 実装内容

- Google認可URL生成
- OAuth state生成・保存・検証
- codeとtokenの交換
- refresh token暗号化
- 接続情報保存
- 接続状態管理
- 接続解除
- アクセストークン更新

#### 接続状態

```text
ACTIVE
REAUTH_REQUIRED
DISCONNECTED
ERROR
```

#### 受け入れ条件

- [ ] Google認可画面へ遷移できる。
- [ ] callback後に接続情報を保存できる。
- [ ] refresh tokenが暗号化される。
- [ ] 不正なstateを拒否する。
- [ ] 保存tokenからGoogle APIへ接続できる。
- [ ] 接続解除後はAPIを利用できない。
- [ ] secretやtokenをログへ出力しない。

### PR-07 Gmail読み取りコネクター

#### 目的

Gmailからメッセージとスレッドを取得し、Agentで使用できる内部型へ変換します。

#### 実装内容

- `messages.list`
- `messages.get`
- `threads.get`
- Base64URLデコード
- MIME解析
- `text/plain`取得
- HTMLメールのテキスト化
- ヘッダー抽出
- スレッド正規化
- Gmailエラー分類
- timeout
- retry

#### 受け入れ条件

- [ ] 直近24時間のメールを取得できる。
- [ ] 件名、送信者、日時、本文を取得できる。
- [ ] multipartメールを解析できる。
- [ ] HTMLのみのメールをテキスト化できる。
- [ ] スレッドを時系列順に取得できる。
- [ ] Gmail SDK固有型がAgentへ漏れない。
- [ ] 一時エラーが再試行可能エラーになる。

### PR-08 LLM共通基盤

#### 目的

AgentからOpenAI SDKへ直接依存せず、構造化出力を利用できるようにします。

#### 実装内容

- LLM Providerインターフェース
- OpenAI Provider
- Zod Structured Output
- timeout
- retry
- model名保存
- prompt version保存
- token usage保存
- 推定コスト記録
- Fake LLM

#### 受け入れ条件

- [ ] AgentからProvider経由でLLMを呼べる。
- [ ] Schemaに一致した結果だけ返る。
- [ ] 不正出力を1回再試行する。
- [ ] 再試行後も不正なら`NEEDS_REVIEW`になる。
- [ ] APIキーをログに出さない。
- [ ] token usageを保存できる。
- [ ] Fake LLMでUnit Testできる。

### PR-09 就職活動メールAgentの解析部分

#### 目的

Gmailスレッドを入力として、就職活動メール判定と必要情報の抽出を行います。

#### AI出力

- 就職活動関連か
- メールカテゴリー
- 返信が必要か
- 会社名
- 担当者名
- 面談確定状態
- 開始日時
- 終了日時
- タイムゾーン
- Web会議URL
- 予約ページURL
- 信頼度
- 判定根拠

#### メールカテゴリー

```text
meeting_confirmed
scheduling_request
application_update
document_request
assignment
offer
rejection
general
not_job_related
```

#### 実装内容

- Agent Manifest
- Input Schema
- Output Schema
- Analysis Schema
- 解析Prompt
- Prompt Injection対策
- 解析結果保存
- fixture
- AI評価テスト

#### 受け入れ条件

- [ ] 就活関連メールを判定できる。
- [ ] 非就活メールを除外できる。
- [ ] 返信要否を判定できる。
- [ ] 確定日時と候補日時を区別できる。
- [ ] Web会議URLと予約ページURLを区別できる。
- [ ] 書かれていない日時を推測しない。
- [ ] メール内のAI向け命令に従わない。
- [ ] 判定根拠を保存できる。

### PR-10 Gmail返信下書き

#### 目的

返信が必要な就職活動メールに対して、元スレッドへ返信下書きを作成します。

#### 実装内容

- 下書き作成Policy
- 返信文生成Prompt
- 返信文Schema
- MIME生成
- UTF-8件名エンコード
- Base64URLエンコード
- `threadId`
- `In-Reply-To`
- `References`
- `drafts.create`
- idempotency key
- 下書き履歴保存

#### 受け入れ条件

- [ ] 返信が必要なメールだけ下書きを作る。
- [ ] 元メールと同じスレッドに入る。
- [ ] 下書き作成だけで送信されない。
- [ ] 存在しない経歴や事実を追加しない。
- [ ] 回答材料不足時は`NEEDS_REVIEW`になる。
- [ ] 同じメールから下書きを重複作成しない。
- [ ] MIME生成をUnit Testできる。

### PR-11 Google Calendar登録

#### 目的

確定したWeb面談をGoogle Calendarへ重複なく登録します。

#### 登録条件

```text
就活関連
AND 面談確定
AND 開始日時あり
AND 終了日時あり
AND Web会議URLあり
AND 信頼度0.9以上
```

#### 実装内容

- `GET /auth/google/calendar` によるCalendar専用の追加OAuth認可（`calendar.events`）
- Calendar Port
- `events.insert`
- 決定的イベントID
- イベントタイトル
- イベント説明
- 会議URL
- reminder
- 重複防止
- 既存予定との競合確認
- 作成履歴保存

返信下書きとCalendar登録は外部書き込み前に両方のPolicyを評価します。いずれかが要確認の場合は、両方の外部書き込みを停止します。

#### 受け入れ条件

- [ ] 確定したWeb面談だけ登録される。
- [ ] 候補日時だけでは登録されない。
- [ ] 予約ページURLだけでは登録されない。
- [ ] 会社名、日時、URLが登録される。
- [ ] 同じメールから予定を重複作成しない。
- [ ] 予定競合時は自動登録せず要確認になる。
- [ ] 日時変更メールは初期MVPでは要確認になる。

### PR-12 手動E2Eフロー

#### 目的

1つのAPI呼び出しから、Gmail取得、AI解析、下書き作成、Calendar登録まで縦に実行します。

#### API

```text
POST /agents/job-search-email/runs
```

#### 入力

```json
{
  "idempotencyKey": "manual-run-unique-key",
  "input": {
    "googleConnectionId": "connection-id",
    "gmailMessageId": "message-id",
    "gmailThreadId": "thread-id"
  }
}
```

`idempotencyKey`は任意です。同じキーと同じ入力を再送した場合は既存Jobを返し、同じキーを異なる入力へ再利用した場合は`409`を返します。

#### Step構成

```text
FETCH_EMAIL_THREAD
ANALYZE_EMAIL
GENERATE_REPLY
CHECK_CALENDAR_POLICY
CREATE_DRAFT
CREATE_CALENDAR_EVENT
COMPLETE
```

`CHECK_CALENDAR_POLICY`は予定の作成前に、設定・日時・Web会議URL・権限・競合を確認します。各Stepは明示的な連番で実行順を保持します。本文・プロンプト・アクセストークンは保存せず、message/thread ID、処理可否、分類、外部リソースID、`NEEDS_REVIEW`理由、失敗コード、再試行可否だけを保存・返却します。

#### 受け入れ条件

- [ ] Gmail message IDを指定して実行できる。
- [ ] 各Stepの状態を確認できる。
- [ ] 失敗したStepを特定できる。
- [ ] 成功時にdraft IDを確認できる。
- [ ] 成功時にCalendar event IDを確認できる。
- [ ] 再実行しても外部リソースが重複しない。
- [ ] Fake外部サービスによるE2E Testが通る。
- [ ] `GET /jobs/:jobId`で最新Runの安全な出力とStep状態を確認できる。
- [ ] `GET /runs/:runId`で安全なStep状態とdraft／Calendar event IDを確認できる。

PR-12の完了時点を、手動実行可能なMVP完成とします。

### PR-13 Gmail自動ポーリング

#### 目的

有効なGoogle接続を定期確認し、新着メールを自動処理します。

#### 実装内容

- 5分間隔のポーリング
- 有効接続一覧取得
- Gmail検索
- 未処理メール判定
- Job登録
- アカウント単位ロック
- polling cursor
- 最終同期日時
- エラー分離

#### 受け入れ条件

- [ ] Agent有効時だけ処理する。
- [ ] 同じメールを複数回Job登録しない。
- [ ] ポーリングが重なっても二重処理しない。
- [ ] Worker再起動後も未処理メールを取得する。
- [ ] 認証失敗時は`REAUTH_REQUIRED`になる。
- [ ] 1アカウントの失敗が他アカウントを止めない。

### PR-14 実行履歴・要確認・再実行API

#### 目的

Agentの処理状況、判断結果、失敗理由を確認できるようにします。

#### API

```text
GET  /runs
GET  /runs/:runId
GET  /reviews
GET  /reviews/:reviewId
POST /runs/:runId/retry
POST /reviews/:reviewId/resolve
```

#### 受け入れ条件

- [ ] 実行結果を一覧確認できる。
- [ ] 各Stepの結果を確認できる。
- [ ] 失敗理由を確認できる。
- [ ] 要確認理由を確認できる。
- [ ] 失敗処理を再実行できる。
- [ ] 完了処理を重複実行しない。
- [ ] tokenなどの秘密情報を表示しない。

### PR-15 管理画面

#### 目的

Google連携、Agent設定、履歴確認、要確認対応をブラウザから操作できるようにします。

#### 画面

```text
Google連携画面
Agent一覧
Agent設定
処理履歴一覧
処理履歴詳細
要確認一覧
要確認詳細
```

#### 設定項目

- Agent有効・無効
- Gmailポーリング有効・無効
- 下書き作成有効・無効
- Calendar登録有効・無効
- 氏名
- メール署名
- タイムゾーン
- 下書き信頼度閾値
- Calendar信頼度閾値

#### 受け入れ条件

- [ ] Google連携状態を確認できる。
- [ ] Google連携を開始・解除できる。
- [ ] AgentをON/OFFできる。
- [ ] 署名を保存できる。
- [ ] 処理履歴を確認できる。
- [ ] 要確認処理を確認できる。
- [ ] 失敗処理を再実行できる。

管理画面はMVP完成後に追加し、React + ViteまたはNext.jsの採用をこの段階で判断します。

### PR-16 本番化

#### 目的

ローカルポーリング構成から、本番のイベント駆動構成へ移行します。

#### 本番フロー

```text
Gmail
  ↓
Google Cloud Pub/Sub
  ↓
Hono Webhook
  ↓
PostgreSQLまたはCloud Tasks
  ↓
Bun Worker
  ↓
Agent
```

#### 実装内容

- Gmail `users.watch`
- Google Cloud Pub/Sub
- Gmail Webhook
- `history.list`
- watch期限更新
- 定期差分同期
- Cloud Run
- マネージドPostgreSQL
- Secret Manager
- OpenTelemetry
- エラー通知
- 処理遅延監視
- OAuth公開要件確認
- バックアップ
- Migration運用

#### 受け入れ条件

- [ ] Gmail通知からJobを登録できる。
- [ ] Webhookが重い処理を待たず応答する。
- [ ] Pub/Sub通知の重複で二重処理しない。
- [ ] Push通知欠落時に定期同期で回復する。
- [ ] Gmail watchを期限前に更新する。
- [ ] 秘密情報をSecret Managerで管理する。
- [ ] 処理失敗とWorker停止を検知できる。
- [ ] DBバックアップから復旧できる。

本番のマネージドDBがPostgreSQL 18に未対応の場合は、PostgreSQL 18対応サービスを優先し、対応が難しい場合のみ一時的に本番環境を17とします。ローカル開発とCIはPostgreSQL 18.4を基準とします。

## 12. 実装優先順位

### 第1段階：共通基盤

```text
PR-01 リポジトリ基盤
PR-02 Docker・PostgreSQL 18.4・Drizzle
PR-03 Agent Core
PR-04 PostgreSQL Job Queue
PR-05 Hono API
```

完了時点：APIからAgent Jobを登録し、WorkerがテストAgentを実行して結果をPostgreSQLへ保存できます。

### 第2段階：外部接続

```text
PR-06 Google OAuth
PR-07 Gmail読み取り
PR-08 LLM共通基盤
```

完了時点：Googleアカウントを連携し、Gmailからメールを取得し、OpenAIへ構造化解析を依頼できます。

### 第3段階：就職活動メールAgent

```text
PR-09 メール解析
PR-10 Gmail下書き
PR-11 Calendar登録
PR-12 手動E2E
```

完了時点：Gmail message IDを指定し、AI解析、返信下書き、Calendar登録まで手動実行できます。

### 第4段階：自動化・運用

```text
PR-13 Gmail自動ポーリング
PR-14 履歴・要確認・再実行
```

完了時点：新着メールを自動処理し、失敗や曖昧な判断を管理できます。

### 第5段階：画面・本番化

```text
PR-15 管理画面
PR-16 本番化
```

完了時点：利用者がブラウザから設定・監視でき、クラウド上で継続運用できます。

## 13. テスト方針

### 13.1 Unit Test

対象：

- Policy
- Zod Schema
- Agent Registry
- エラー分類
- idempotency key
- MIME生成
- Gmailヘッダー解析
- Base64URL変換
- URL分類
- 日時判定
- UUIDv7生成

外部APIやDBは使用しません。

### 13.2 Integration Test

対象：

- Drizzle Repository
- PostgreSQL Job Queue
- Migration
- `uuidv7()`
- Transaction
- 複数Workerの排他制御
- Gmail Adapter
- Calendar Adapter
- OpenAI Provider

CIではPostgreSQL 18.4コンテナを起動します。Google APIとOpenAI APIの実通信テストは通常CIから分離します。

### 13.3 Agent Test

AgentへFake Portを注入して、ワークフローを検証します。

```text
Fake Gmail
Fake Calendar
Fake LLM
Fake Repository
Fake Clock
```

確認内容：

- Stepの実行順
- Policyによる分岐
- 下書き作成条件
- Calendar作成条件
- 要確認への遷移
- エラー時の停止位置
- 再実行時の冪等性

### 13.4 E2E Test

```text
Hono API
  ↓
PostgreSQL 18.4 Job Queue
  ↓
Bun Worker
  ↓
Agent
  ↓
Fake外部サービス
```

Docker Compose上で実行します。

### 13.5 AI評価

最低限、次のfixtureを用意します。

```text
面談確定メール
日程候補メール
予約ページ案内
課題提出依頼
書類提出依頼
選考通過
不採用
オファー
転職エージェント
就活以外のメール
日時が曖昧なメール
終了時間がないメール
URLがないメール
HTMLメール
長いスレッド
過去メールの引用
Prompt Injectionを含むメール
```

初期評価目標：

| 指標 | 目標 |
|---|---:|
| 就活メール判定の適合率 | 95%以上 |
| Web会議URL抽出の正解率 | 99%以上 |
| 確定日時抽出の正解率 | 98%以上 |
| 誤ったCalendar自動登録 | 0件 |
| 非対象メールへの下書き作成 | 0件 |
| 重複下書き | 0件 |
| 重複Calendar予定 | 0件 |

## 14. セキュリティ方針

### 14.1 OAuth

- OAuth stateを検証する。
- refresh tokenを暗号化する。
- 最小権限のScopeを使用する。
- 接続解除時にtokenを削除する。
- 認証失敗時は自動処理を停止する。

### 14.2 秘密情報

Git管理しないもの：

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
OPENAI_API_KEY
TOKEN_ENCRYPTION_KEY
DATABASE_URL
```

ログへ出さないもの：

```text
access token
refresh token
OAuth code
OpenAI API key
暗号化キー
メール本文全文
```

### 14.3 Prompt Injection

メール本文は信頼できない外部データとして扱います。

AIには、メール本文に書かれた命令へ従わず、本文を分類と情報抽出の対象としてのみ扱い、外部ツールの実行判断をしないよう指示します。

### 14.4 外部書き込み

- AI出力をそのまま実行しない。
- Policyを通す。
- 冪等性キーを検証する。
- 曖昧な場合は`NEEDS_REVIEW`にする。
- 自動送信は実装しない。

## 15. ログ・監視方針

すべてのログをJSON形式で出力します。

共通項目：

```text
requestId
jobId
runId
stepId
agentId
connectionId
status
durationMs
errorCode
retryCount
```

保存する指標：

- Agent実行数
- 成功率
- 失敗率
- 要確認率
- 平均処理時間
- Step別処理時間
- Gmail APIエラー率
- Calendar APIエラー率
- OpenAI APIエラー率
- token使用量
- 推定LLMコスト
- Job滞留数
- 最古Jobの待機時間
- Worker最終稼働日時

## 16. リトライ方針

| エラー | リトライ | 動作 |
|---|---:|---|
| Gmail一時エラー | Yes | 指数バックオフ |
| Calendar一時エラー | Yes | 指数バックオフ |
| OpenAI一時エラー | Yes | 指数バックオフ |
| PostgreSQL一時エラー | Yes | Job再取得 |
| OAuth認証失敗 | No | `REAUTH_REQUIRED` |
| Schema不正 | 1回 | 再生成後に要確認 |
| 入力不正 | No | `FAILED` |
| Policy不一致 | No | `SKIPPED`または要確認 |
| 重複実行 | No | 既存結果を返す |
| Prompt Injection疑い | No | `NEEDS_REVIEW` |

最大試行回数の初期値は3回とします。

## 17. 冪等性方針

次の操作は必ず冪等にします。

- Agent Job登録
- Gmailメッセージ保存
- AI解析結果保存
- Gmail下書き作成
- Calendar予定作成
- Run再実行

キー例：

```text
Agent Job:
agent_id + connection_id + gmail_message_id

Gmail draft:
connection_id + gmail_message_id + draft_policy_version

Calendar:
connection_id + gmail_message_id + calendar_policy_version
```

DBのUnique Constraintとアプリケーション判定の両方を利用します。

## 18. 各PRの完了条件

各PRは次を満たした場合に完了とします。

- 仕様書と実装が一致している。
- typecheckが成功する。
- lintが成功する。
- Unit Testが成功する。
- 必要なIntegration Testが成功する。
- Docker環境で動作確認できる。
- 受け入れ条件を満たす。
- エラー処理がある。
- ログに秘密情報を出さない。
- 外部書き込みが冪等である。
- コンテナ再起動後も処理を継続できる。
- Migrationを再実行できる。
- PostgreSQL 18.4で動作する。
- 未実装事項をPR本文に記載している。
- 動作確認コマンドをPR本文に記載している。

## 19. 最初に着手する作業

最初の実装PRでは次を行います。

```text
Bun Workspaces初期化
apps/api作成
apps/worker作成
agents/_template作成
agents/job-search-email作成
packages/agent-core作成
packages/config作成
packages/database作成
packages/connector-google作成
packages/llm作成
packages/testing作成
TypeScript設定
BiomeまたはESLint設定
bun:test設定
GitHub Actions設定
.env.example作成
```

最初のPRでは、Google API、OpenAI API、実DB処理は実装しません。

最初の完了条件：

```text
bun install
bun run typecheck
bun run lint
bun test
```

次のPRで次を追加します。

```text
postgres:18.4
Volume: /var/lib/postgresql
Drizzle ORM
postgres.js
Drizzle Kit
uuidv7()
Migration
DB healthcheck
Hono GET /health/live
Hono GET /health/ready
Worker DB接続
```

その後、次の順番で進めます。

```text
Agent Core
  ↓
PostgreSQL Job Queue
  ↓
Hono API
  ↓
Google OAuth
  ↓
Gmail Connector
  ↓
LLM Provider
  ↓
就活メール解析
  ↓
Gmail下書き
  ↓
Calendar登録
  ↓
手動E2E
  ↓
自動ポーリング
  ↓
管理・本番化
```

## 20. 最終完成条件

AIAgentsの初期バージョンは、次をすべて満たした時点で完成とします。

- 複数AgentをRegistryへ登録できる。
- APIとWorkerが分離されている。
- PostgreSQL Job Queueで非同期実行できる。
- Agent実行をStep単位で記録できる。
- GoogleアカウントをOAuth連携できる。
- Gmailから新着メールを取得できる。
- 就職活動関連メールをAIで解析できる。
- 返信が必要な場合だけGmail下書きを作成できる。
- 確定Web面談だけGoogle Calendarへ登録できる。
- メールを自動送信しない。
- 曖昧な判断を要確認へ送れる。
- 失敗した処理を再実行できる。
- 外部書き込みが重複しない。
- PostgreSQL 18.4上で動作する。
- Docker Composeでローカル実行できる。
- 自動テストとAI評価を実行できる。
- 新しいAgentをテンプレートから追加できる。
