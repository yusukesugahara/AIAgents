# 就職活動メールエージェント 実装計画

## 1. 方針

最初からGmail Push通知、管理画面、Redisを導入せず、Docker Compose上で動くポーリング型MVPを段階的に完成させます。

各フェーズは、コードが存在するだけでは完了としません。利用者が実際に操作でき、受け入れ条件とテストを満たした時点で完了とします。

技術スタックは次に固定します。

```text
Runtime: Bun
API: Hono
Worker: Bunプロセス
Database: PostgreSQL 17
ORM: Drizzle ORM
Driver: postgres.js
Validation: Zod
Test: bun:test
Local: Docker Compose
```

## 2. フェーズ一覧

| フェーズ | 内容 | 完了時にできること |
|---|---|---|
| 0 | Monorepo基盤 | 複数エージェントをpackageとして追加できる |
| 1 | Docker・DB基盤 | Hono API、Bun Worker、PostgreSQLが起動する |
| 2 | Agent Core・Job Queue | ジョブから任意のエージェントを実行できる |
| 3 | Google OAuth | Gmail・Calendarを連携できる |
| 4 | Gmail読み取り | メールとスレッドを取得できる |
| 5 | AI解析 | 就活判定、返信要否、日時、URLをJSON化できる |
| 6 | Gmail下書き | 元スレッドに返信下書きを作れる |
| 7 | Calendar登録 | 確定Web面談を重複なく登録できる |
| 8 | 自動ポーリング | 5分ごとに未処理メールを処理できる |
| 9 | 履歴・要確認API | 実行結果と要確認理由を取得できる |
| 10 | 本番化 | Push通知、監視、秘密情報管理を導入する |

## 3. Phase 0: Monorepo基盤

### 実装対象

```text
apps/
├── api/
└── worker/

agents/
├── _template/
└── job-search-email/

packages/
├── agent-core/
├── config/
├── database/
├── connector-google/
├── llm/
├── observability/
└── testing/
```

### 実装内容

- Bun Workspaces
- ルート`package.json`
- `tsconfig.base.json`
- `bunfig.toml`
- packageごとの`exports`
- Zodによる環境変数Schema
- `.env.example`
- `bun:test`
- CIのtypecheck、test、dependency check
- ESLintまたは同等のimport制限

### 受け入れ条件

- [ ] `bun install`が成功する。
- [ ] `bun run typecheck`が全Workspaceで成功する。
- [ ] `bun test`が成功する。
- [ ] 新規エージェントを`agents/<agent-id>`へ追加できる。
- [ ] `packages`から`agents`へのimportをCIが検出する。
- [ ] `agents`からDrizzle、Google SDK、OpenAI SDKへの直接importをCIが検出する。

## 4. Phase 1: Docker・DB基盤

### 実装内容

- `apps/api`: Hono + Bun
- `apps/worker`: Bunプロセス
- PostgreSQL 17
- `docker/api.Dockerfile`
- `docker/worker.Dockerfile`
- `compose.yaml`
- Drizzle ORM
- postgres.js
- Drizzle Kit
- Migration command
- `/health/live`
- `/health/ready`
- 構造化ログ
- Graceful Shutdown

### 受け入れ条件

- [ ] `docker compose up --build`で全サービスが起動する。
- [ ] `GET /health/live`が200を返す。
- [ ] DB接続可能な場合、`GET /health/ready`が200を返す。
- [ ] DB停止時、`GET /health/ready`が503を返す。
- [ ] Workerが起動し待機状態になる。
- [ ] PostgreSQL healthcheckが成功する。
- [ ] Migrationを複数回実行しても重複適用されない。
- [ ] コンテナ再起動後もDBデータが保持される。
- [ ] SIGTERM時にDB接続を閉じて終了する。

## 5. Phase 2: Agent Core・PostgreSQL Job Queue

### 実装対象

```text
packages/agent-core/src/
├── define-agent.ts
├── agent-context.ts
├── agent-registry.ts
├── agent-runner.ts
├── step-runner.ts
├── idempotency.ts
└── errors.ts
```

### 実装内容

- `AgentDefinition<TInput, TOutput>`
- Agent Registry
- Agent Context
- Run ID、Step ID
- Agent Job Repository
- Agent Run Repository
- PostgreSQL Job Queue
- `FOR UPDATE SKIP LOCKED`
- `idempotency_key`
- Retry状態
- ロック期限切れ回復
- Fake Agent

### 受け入れ条件

- [ ] AgentをRegistryへ登録できる。
- [ ] Agent IDから対象Agentを取得できる。
- [ ] APIからAgent Jobを登録できる。
- [ ] WorkerがJobを1件だけ排他的に取得できる。
- [ ] Workerを2つ起動しても同一Jobを同時実行しない。
- [ ] 同一idempotency keyのJobを重複登録しない。
- [ ] Agent RunとStep状態が保存される。
- [ ] Worker停止後、期限切れロックを回復できる。
- [ ] 一時エラーは`retry_waiting`へ移行する。

## 6. Phase 3: Google OAuth

### 実装対象

```text
packages/connector-google/src/oauth/
├── oauth-client.ts
├── oauth-state-store.ts
└── token-store.ts

apps/api/src/routes/
└── auth.route.ts
```

### 実装内容

- OAuth開始API
- OAuth callback
- `state`保存と検証
- Gmail・Calendar Scope
- Authorization Code交換
- Refresh Token暗号化
- Google接続情報テーブル
- Token更新
- 接続解除API
- Google SDKのBun Integration Test
- SDKに問題がある場合のREST Adapter境界

### 受け入れ条件

- [ ] `/auth/google/start`からGoogle認可画面へ移動できる。
- [ ] 許可後にGoogleアカウントを保存できる。
- [ ] Refresh Tokenが平文でDBへ保存されない。
- [ ] OAuth state不一致を拒否する。
- [ ] コンテナ再起動後も保存TokenからGmail APIへ接続できる。
- [ ] Access Token期限切れ時に更新できる。
- [ ] 連携解除後は対象アカウントを処理しない。
- [ ] Token取消時に`reauth_required`へ移行する。

## 7. Phase 4: Gmail読み取り

### 実装対象

```text
packages/connector-google/src/gmail/
├── gmail-client.ts
├── gmail-rest-client.ts
├── gmail.types.ts
├── mime-parser.ts
└── message-mapper.ts
```

### 実装内容

- `messages.list`
- `messages.get`
- `threads.get`
- Gmail型からアプリケーション型への変換
- MIME本文抽出
- Header抽出
- HTMLから解析用Text生成
- Thread整形
- `job_email_messages`
- 処理済み判定
- Google Errorの共通Error変換

### 受け入れ条件

- [ ] 直近24時間の受信メール一覧を取得できる。
- [ ] 件名、送信者、本文、message ID、thread IDを取得できる。
- [ ] multipartメールから`text/plain`を取得できる。
- [ ] HTMLしかないメールから解析用Textを生成できる。
- [ ] Thread内の送信者と時系列を保持できる。
- [ ] 同じGmail message IDをDBへ重複登録しない。
- [ ] Gmail APIの一時エラーを共通Errorへ変換する。
- [ ] エージェントへGoogle SDK型を返さない。

## 8. Phase 5: AI解析

### 実装対象

```text
packages/llm/src/
├── llm-provider.ts
├── openai-provider.ts
└── structured-output.ts

agents/job-search-email/src/
├── output.schema.ts
├── prompts/analyze-email.prompt.ts
├── steps/analyze-email.step.ts
└── evals/
```

### 実装内容

- `LlmProvider`
- OpenAI Provider
- Structured Outputs
- `JobEmailAnalysisSchema`
- 解析Prompt
- Prompt Version
- Schema Version
- Prompt Injection対策
- 解析結果保存
- Token・Latency記録
- 評価Fixture

### 受け入れ条件

- [ ] 就活関連・非関連をSchema通りに返す。
- [ ] 返信要否を返す。
- [ ] 会社名と担当者名を抽出する。
- [ ] 確定日時と候補日時を区別する。
- [ ] Web会議URLと予約ページURLを区別する。
- [ ] 明記されていない日時を推測しない。
- [ ] 終了日時がない場合に自動補完しない。
- [ ] 不正な構造化出力は1回再試行後、要確認になる。
- [ ] メール本文中のAI向け命令に従わない。
- [ ] Prompt Version、Model、TokenをDBへ保存する。

### 初期評価基準

| 指標 | 目標 |
|---|---:|
| 就活メール判定の適合率 | 95%以上 |
| Web会議URL抽出の正解率 | 99%以上 |
| 確定日時抽出の正解率 | 98%以上 |
| 誤ったCalendar自動登録 | 0件 |

## 9. Phase 6: Gmail下書き

### 実装対象

```text
agents/job-search-email/src/
├── policy.ts
├── prompts/generate-reply.prompt.ts
├── steps/generate-reply.step.ts
└── steps/create-draft.step.ts

packages/connector-google/src/gmail/
└── mime-message.ts
```

### 実装内容

- `shouldCreateDraft`
- 返信文生成Prompt
- 返信Schema
- MIME生成
- Base64URL Encoding
- `drafts.create`
- `threadId`
- `In-Reply-To`
- `References`
- `job_email_drafts`
- 冪等性Key

### 受け入れ条件

- [ ] 返信が必要な就活メールだけ下書きを作る。
- [ ] PolicyをUnit Testできる。
- [ ] 下書きが元メールと同じThreadへ表示される。
- [ ] 下書き作成だけで送信されない。
- [ ] 元メールにない経歴や実績を追加しない。
- [ ] 必要な回答材料が不足する場合は要確認にする。
- [ ] 同じメールを再処理しても下書きが増えない。
- [ ] Gmail API成功後のDB保存失敗から回復できる。

## 10. Phase 7: Google Calendar登録

### 実装対象

```text
packages/connector-google/src/calendar/
├── calendar-client.ts
├── calendar.types.ts
└── event-mapper.ts

agents/job-search-email/src/
├── policy.ts
└── steps/create-calendar-event.step.ts
```

### 実装内容

- `shouldCreateCalendarEvent`
- Calendar Event検索
- 重複・競合確認
- `events.insert`
- 決定的Event IDまたは冪等性Key
- `job_calendar_events`

### 受け入れ条件

- [ ] 確定日時、終了日時、Web会議URLがある場合だけ登録する。
- [ ] 予約ページURLだけでは登録しない。
- [ ] 候補日時だけでは登録しない。
- [ ] 終了日時不明では登録しない。
- [ ] タイトル、日時、URL、会社名、担当者名を確認できる。
- [ ] 同じメールを再処理しても予定が増えない。
- [ ] 既存予定との競合時は要確認にする。
- [ ] 日時変更メールは初期MVPでは要確認にする。

## 11. Phase 8: 自動ポーリング

### 実装対象

```text
apps/worker/src/
├── job-loop.ts
└── schedules/gmail-poll.schedule.ts
```

### 実装内容

- Bun TimerまたはSchedule Loop
- 5分間隔
- 有効なGoogle接続の取得
- Gmail候補取得
- MessageごとのAgent Job登録
- Polling Jobの排他制御
- Retry
- 手動再実行

### 受け入れ条件

- [ ] Agent有効時だけポーリングする。
- [ ] 複数Workerでポーリングが重なっても同じメールを重複処理しない。
- [ ] APIコンテナとWorkerコンテナを分離できる。
- [ ] Worker再起動後に未完了Jobを再開できる。
- [ ] 一時エラーは最大3回Retryする。
- [ ] OAuth失効時は再連携が必要な状態になる。
- [ ] Polling間隔を環境変数で変更できる。

## 12. Phase 9: 履歴・要確認API

### 実装対象

```text
apps/api/src/routes/
├── agents.route.ts
└── runs.route.ts
```

### 実装内容

- Agent一覧
- Agent設定取得・更新
- 手動実行
- Run一覧
- Run詳細
- Step一覧
- Needs Review一覧
- Retry API
- Hono RPC型共有を見据えたRoute型

### 受け入れ条件

- [ ] Google連携状態をAPIで取得できる。
- [ ] AgentをON/OFFできる。
- [ ] 氏名と署名を設定できる。
- [ ] 下書き作成とCalendar登録を個別にON/OFFできる。
- [ ] 実行履歴とStep結果を確認できる。
- [ ] 要確認になった理由を確認できる。
- [ ] FailedまたはNeeds ReviewのJobを手動Retryできる。
- [ ] API RouteがAgent Stepを直接呼んでいない。

## 13. Phase 10: 本番化

### 実装内容

- Gmail `users.watch`
- Google Cloud Pub/Sub
- Hono Webhook
- Cloud Tasksまたは本番Job Queue
- Gmail watchの日次更新
- 定期差分同期
- Secret Manager
- Cloud SQL
- Cloud Run
- OpenTelemetry
- Alert
- OAuth公開要件確認

### 受け入れ条件

- [ ] Gmail変更通知から新着メール処理を開始できる。
- [ ] Webhookが重い処理を待たず成功応答する。
- [ ] Pub/Subの重複配信でもJobを重複作成しない。
- [ ] Push通知欠落時に定期同期で回復できる。
- [ ] Gmail watchを期限切れ前に更新できる。
- [ ] 秘密情報をDocker imageやGitHubへ含めない。
- [ ] Agent別の成功率、失敗率、遅延を監視できる。
- [ ] OAuth Scopeと審査要件を確認済みである。

## 14. 実装順序

初期開発は次の順序を厳守します。

```text
1. WorkspaceとDocker
2. PostgreSQLとMigration
3. Agent CoreとFake Agent
4. PostgreSQL Job Queue
5. Google OAuth
6. Gmail読み取り
7. AI解析
8. Gmail下書き
9. Calendar登録
10. 自動ポーリング
11. 履歴API
12. Push通知
```

GmailやOpenAI連携より前に、Fake AgentでAgent RunnerとJob Queueを完成させます。

## 15. Pull Request分割

推奨PR単位:

```text
PR-01 Repository bootstrap
PR-02 Database and migrations
PR-03 Agent core and registry
PR-04 PostgreSQL job queue
PR-05 Google OAuth connector
PR-06 Gmail read connector
PR-07 Job email analysis
PR-08 Gmail draft creation
PR-09 Calendar event creation
PR-10 Polling worker
PR-11 Run and review APIs
PR-12 Production push notifications
```

1つのPRでOAuth、Gmail、AI、Calendarをまとめて実装しません。

## 16. Definition of Done

各Phaseは次をすべて満たして完了とします。

- [ ] 仕様に対応するコードがある。
- [ ] Unit Testがある。
- [ ] 必要なIntegration Testがある。
- [ ] Typecheckが成功する。
- [ ] Migration SQLをレビューした。
- [ ] ErrorとRetry動作を確認した。
- [ ] ログにTokenやメール本文全文を出していない。
- [ ] 依存関係ルールに違反していない。
- [ ] 受け入れ条件を実環境またはTest環境で確認した。
- [ ] 変更した設計判断をDocsまたはADRへ反映した。
