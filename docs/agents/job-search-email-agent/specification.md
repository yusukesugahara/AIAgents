# 就職活動メールエージェント 仕様書

この文書は、現在の実装を正として記述します。将来構想や実装前の計画は
[`implementation-plan.md`](implementation-plan.md) を参照してください。

## 1. 文書情報

| 項目 | 内容 |
|---|---|
| Agent ID | `job-search-email` |
| 名称 | 就職活動メールエージェント |
| 実装バージョン | `0.2.0` |
| Runtime | Bun |
| API | Hono |
| Database | PostgreSQL 18.4 |
| ORM | Drizzle ORM + postgres.js |
| 実行方式 | Docker Compose + Gmailポーリング |
| 既定タイムゾーン | `Asia/Tokyo` |

## 2. 目的と対象範囲

Gmailに届いた就職活動関連メールを取得し、OpenAI Responses APIのStructured Outputsで分類・情報抽出します。返信が必要で、安全条件を満たす場合は元スレッドのGmail下書きを作成します。

メールは自動送信しません。利用者がGmail上で確認・編集して送信します。

実装済みの処理は次のとおりです。

- 就活関連メールの分類
- 返信要否、会社名、担当者名、面談日時、URLの抽出
- 返信下書きの生成とGmail Draftへの保存
- 日程調整メールに対する候補日時プレースホルダー付き下書き
- 確定したWeb面談のCalendar予定作成ロジック
- PostgreSQLジョブキュー、リトライ、Run・Step履歴
- Gmail DraftとCalendar Eventの冪等性制御

次は現行実装の対象外です。

- メールの自動送信
- Gmail Push通知とPub/Sub Webhook
- Calendar予定の更新・削除
- OAuth接続解除API
- Run IDを指定した再試行API
- Calendar設定を変更するUI/API

## 3. 設計方針

処理順序を固定したAIワークフローとして実装します。LLMは意味理解と構造化抽出を担当し、外部サービスへ書き込む可否はZodで検証済みの値とTypeScriptの条件分岐で決定します。

```text
Gmailから対象メールとスレッドを取得
  ↓
OpenAI APIで分類・情報抽出
  ↓
Zod Schemaで検証・正規化
  ↓
返信とCalendarの安全条件を判定
  ├── 返信可能       → Gmail下書き
  ├── 確定Web面談    → Calendar予定（設定が有効な場合）
  └── 安全条件不成立 → needs_review
  ↓
Run・Step・構造化結果・外部IDを保存
```

エージェント本体はHono、Drizzle、Google APIの具体的なHTTP実装へ直接依存せず、`ports.ts`で定義したinterfaceを介して利用します。

## 4. システム構成

| コンポーネント | 責務 |
|---|---|
| `apps/api` | OAuth、セットアップUI、Agent実行受付、Job・Run参照、履歴UI、Health Check |
| `apps/worker` | PostgreSQL Jobの取得、Agent実行、Gmail定期ポーリング |
| `agents/job-search-email` | Schema、Prompt、返信・Calendar判定、外部書き込み手順 |
| `packages/agent-core` | Agent Registry、Runner、Job・Runの型 |
| `packages/google-oauth` | Google OAuth、Token暗号化、Access Token更新 |
| `packages/connector-google` | Gmail・Google Calendarクライアント |
| `packages/llm` | OpenAI Responses API Structured Outputs |
| `packages/database` | PostgreSQL SchemaとRepository |
| `packages/config` | WorkerのGmail・Job・OpenAI設定の読込と検証 |

主要なAgent実装ファイルは次のとおりです。

```text
agents/job-search-email/src/
├── index.ts
├── manifest.ts
├── schemas.ts
├── ports.ts
├── prompt.ts
├── analysis-normalization.ts
├── reply-action.ts
├── calendar-action.ts
├── scheduled-gmail-poll.ts
├── run-step-tracker.ts
├── persistence.ts
└── validation.ts
```

## 5. Agent契約

### 5.1 Manifest

```ts
{
  id: 'job-search-email',
  name: '就職活動メールエージェント',
  version: '0.2.0',
  triggers: ['manual', 'schedule', 'gmail-push'],
}
```

`gmail-push`はManifest上の予約済みTriggerであり、Push通知を受け取るWebhookは未実装です。

### 5.2 Input

```ts
z.object({
  googleConnectionId: z.uuid(),
  gmailMessageId: z.string().trim().min(1).max(255),
  gmailThreadId: z.string().trim().min(1).max(255),
}).strict()
```

Trigger種別は入力JSONには含めず、Jobの`trigger_type`としてRunnerへ渡します。

### 5.3 Output

```ts
z.object({
  analysis: JobEmailAnalysisSchema.nullable(),
  draftId: z.string().nullable(),
  calendarEventId: z.string().nullable(),
  result: z.enum(['completed', 'skipped', 'needs_review']),
}).strict()
```

- `analysis: null`は、LLM拒否やLLM出力不正による`needs_review`だけで許可します。
- `draftId`と`calendarEventId`を設定できるのは`completed`だけです。
- 求人に無関係なメールは`skipped`です。

## 6. Google OAuth

権限は用途ごとに追加認可します。

| 用途 | Route | 主なScope |
|---|---|---|
| Gmail読取 | `GET /auth/google` | `openid`、`email`、`profile`、`gmail.readonly` |
| Gmail下書き | `GET /auth/google/compose` | `gmail.compose` |
| Calendar予定 | `GET /auth/google/calendar` | `calendar.events` |

共通のcallbackは`GET /auth/google/callback`、完了後の遷移は`GET /auth/google/complete`です。

- `access_type=offline`を指定します。
- OAuth stateとブラウザnonceを照合します。
- PKCE verifierとRefresh TokenはAES-256-GCMで暗号化して保存します。
- Access Token更新時に認証が失効していれば接続を`reauth_required`へ変更します。
- 接続状態取得専用APIと接続解除APIはありません。接続一覧はセットアップ画面に表示します。

## 7. Gmail定期取得

Workerは起動直後と`GMAIL_POLL_INTERVAL_SECONDS`ごとにGmailを確認します。対象接続は次をすべて満たすものです。

1. 接続状態が`connected`
2. `gmail.readonly`と`gmail.compose`を認可済み
3. `createDrafts`が有効
4. `userName`が設定済み

検索条件は`GMAIL_LOOKBACK_QUERY`、1ページの件数は`GMAIL_POLL_MAX_RESULTS`を使用します。各メールは次のJob入力へ変換します。

```text
googleConnectionId
gmailMessageId
gmailThreadId
```

通常の定期実行のJob冪等キーは次の形式です。

```text
gmail-poll:{googleConnectionId}:{gmailMessageId}
```

セットアップ画面の「既存ジョブをリセットして再実行」は一意なprefixを使って新しいJobを作成します。過去のRunは削除しません。

## 8. AI解析

OpenAI Responses APIのStructured Outputsを使用します。解析結果には次を含みます。

- `isJobRelated`
- `category`
- `companyName`、`contactName`
- `needsReply`、`replyIntent`
- `missingRequiredInformation`
- `meeting.isConfirmed`
- `meeting.startAt`、`endAt`、`timezone`
- `meeting.url`、`urlType`
- `confidence`
- `evidence`

主な整合性条件は次のとおりです。

- `isJobRelated`と`category`を一致させる。
- `needsReply`と`replyIntent`を一致させる。
- 確定面談には明示的な開始日時を要求する。
- 開始日時がある場合はタイムゾーンを要求する。
- URLと`urlType`を一致させる。
- 候補日時と確定日時、Web会議URLと予約ページURLを区別する。

LLM拒否または検証不能な出力は、外部書き込みを行わず`needs_review`にします。LLM入力、Prompt、メール本文そのもの、生成した返信本文はDBへ保存しません。構造化解析結果の`evidence`は判断根拠として最大5件・各240文字まで保存します。

## 9. Gmail下書き

通常の返信下書きは次の条件を満たす場合に作成します。

```text
求人関連メールである
返信が必要である
返信下書き設定が存在し、createDraftsが有効
解析と返信生成の信頼度が設定値以上
必要情報が不足していない
返信先ヘッダーが安全
対象メールがスレッド内の最新返信対象
LLM警告がない
```

例外として、`scheduling_request`は不足情報があっても、利用者が候補日時を入力できるプレースホルダー付き下書きを作成します。この場合は返信生成LLMを呼びません。

下書きには元メールの`threadId`、`In-Reply-To`、`References`、Subjectを使用します。メールは送信しません。

冪等性は次で保護します。

- `(google_connection_id, gmail_message_id)`のUnique Index
- 下書きPolicyを含む`idempotency_key`のUnique Index
- `gmail_draft_id`のUnique Index
- DB上のDraft IDを再利用する前のGmail実在確認
- Gmail側で削除済みの場合の安全な再作成

## 10. Google Calendar

Calendar予定は次の条件を満たす場合に作成します。

```text
meeting.isConfirmed = true
companyName、startAt、endAtが存在する
urlが存在し、urlType = web_meeting
confidence >= calendarConfidenceThreshold
createCalendarEvents = true
設定値と解析値のタイムゾーンが有効
同じ時間帯に競合予定がない
calendar.events権限がある
```

作成先は接続Googleアカウントのprimary calendarです。予定には会社名、担当者名、Web会議URL、元Gmail message IDを含めます。

冪等性は次で保護します。

- `(google_connection_id, gmail_message_id)`のUnique Index
- Calendar Policyを含む`idempotency_key`のUnique Index
- `google_event_id`のUnique Index
- 決定的なGoogle Event ID
- 作成前の既存Event確認と時間帯競合確認

### 現行UIの制約

Calendar作成処理と追加認可Routeは実装済みですが、セットアップ画面が保存できるのは返信下書き設定だけです。返信設定を初回保存すると`createCalendarEvents`は`false`になります。現時点ではUI/APIからCalendar作成を有効化できません。

## 11. 実行結果と要確認

Agent出力の`needs_review`は業務上の確認結果です。`review_requests`へ理由を保存しますが、Agent自体は正常終了するためJobとRunは`completed`になります。

主な要確認理由は次のとおりです。

- LLM拒否または出力不正
- 解析・返信生成・Calendar判定の信頼度不足
- 必要情報不足
- 返信先ヘッダー不正
- スレッド更新による返信対象の変化
- Calendar設定・権限不足
- Calendar日時不正または競合

## 12. Job、Run、Step

### 12.1 Job

Job statusの型は次の値を持ちます。

```text
queued
processing
retry_waiting
needs_review
completed
failed
```

現行Workerが遷移させるのは`queued`、`processing`、`retry_waiting`、`completed`、`failed`です。業務上の`needs_review`はJob statusには使用しません。

一時エラーは既定で最大3試行まで再実行します。処理中Jobのleaseを定期更新し、期限切れJobは`retry_waiting`または`failed`へ回復します。

### 12.2 Run

Run statusは次の3種類です。

```text
running
completed
failed
```

再試行時は同じRunの途中から再開せず、新しいRunを最初から実行します。Gmail DraftとCalendar Eventの予約・冪等キー・外部存在確認により、副作用の重複を防止します。

### 12.3 Step

Step statusは`pending`、`succeeded`、`failed`です。実行順は次のとおりです。

```text
FETCH_EMAIL_THREAD
ANALYZE_EMAIL
GENERATE_REPLY
CHECK_CALENDAR_POLICY
CREATE_DRAFT
CREATE_CALENDAR_EVENT
COMPLETE
```

適用されない外部書き込みStepは作成されません。Stepには本文やPromptではなく、安全なID、判定結果、外部リソースID、エラーコードを保存します。

## 13. API

### OAuth

```text
GET /auth/google
GET /auth/google/compose
GET /auth/google/calendar
GET /auth/google/callback
GET /auth/google/complete
```

### セットアップUI

```text
GET  /setup
POST /setup/reply-settings
POST /setup/scheduled-poll
POST /setup/scheduled-poll-reset
POST /setup/test-run
POST /setup/draft-test
```

### Agent、Job、Run

```text
GET  /agents
GET  /agents/:agentId
POST /agents/:agentId/runs
GET  /jobs/:jobId
GET  /runs/:runId
```

### 履歴UI

```text
GET /history
GET /history/runs/:runId
```

### Health Check

```text
GET /health/live
GET /health/ready
```

JSON APIの手動実行は次の形式で受け付け、Agentのinput schemaで検証してからJobを登録します。

```json
{
  "input": {
    "googleConnectionId": "00000000-0000-0000-0000-000000000000",
    "gmailMessageId": "message-id",
    "gmailThreadId": "thread-id"
  },
  "idempotencyKey": "optional-client-key"
}
```

## 14. データベース

主な共通テーブルは次のとおりです。

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

エージェント固有テーブルは次の3つです。

| テーブル | 用途 | 主な一意性 |
|---|---|---|
| `job_email_analyses` | Runごとの構造化解析結果 | `run_id` |
| `job_email_drafts` | Gmail Draftの予約と完了状態 | 接続+message、idempotency key、Draft ID |
| `job_calendar_events` | Calendar Eventの予約と完了状態 | 接続+message、idempotency key、Event ID |

メールは再解析できるため、同じGmail messageに対する解析履歴をRunごとに保存します。専用の`job_email_messages`テーブルはありません。

## 15. 環境変数

公開設定名の完全な一覧と説明はリポジトリ直下の`.env.example`を正とします。主な値は次のとおりです。

```text
APP_ENV
APP_PORT
API_ACCESS_TOKEN
APP_TIMEZONE
LOG_LEVEL
DATABASE_URL

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
TOKEN_ENCRYPTION_KEY

OPENAI_API_KEY
OPENAI_ANALYSIS_MODEL
OPENAI_REPLY_MODEL

GMAIL_POLL_INTERVAL_SECONDS
GMAIL_POLL_MAX_RESULTS
GMAIL_LOOKBACK_QUERY

AGENT_JOB_MAX_ATTEMPTS
AGENT_JOB_LOCK_TIMEOUT_SECONDS
AGENT_JOB_POLL_INTERVAL_MS
AGENT_JOB_LEASE_HEARTBEAT_MS
```

設定検証は1つのZod schemaへ集約されていません。`packages/config`、`packages/google-oauth`、`packages/database`、`apps/api`が担当範囲ごとに起動時検証します。

## 16. 設定

返信下書き設定はセットアップ画面から保存できます。

```text
createDrafts
draftConfidenceThreshold
userName
emailSignature
replyStyle = polite_concise
```

保存済み設定JSONはCalendar用に次の値も扱えます。

```text
createCalendarEvents
calendarConfidenceThreshold
timezone
```

ただし、現行セットアップ画面にはCalendar設定フォームがありません。返信設定の初回保存時は`createCalendarEvents = false`です。

## 17. セキュリティとデータ取り扱い

- Refresh TokenとOAuth PKCE verifierをAES-256-GCMで暗号化します。
- Token、メール本文そのもの、Prompt、生成返信本文をログやRun履歴へ保存しません。構造化解析結果の`evidence`は保存対象です。
- HTTP入力、LLM出力、Google API応答を境界で検証します。
- 返信対象が最新か外部書き込み直前に再確認します。
- Gmail下書きだけを作成し、送信・削除は行いません。
- Calendar競合、権限不足、曖昧な日時は`needs_review`にします。

## 18. テスト範囲

- Unit Test: Schema、Prompt、返信・Calendar条件、Run Step、Connector、Repository
- PostgreSQL Integration Test: Migration、Queue、OAuth、各Repository、APIとWorkerをFake外部クライアントで結合
- Docker Compose Integration Test: Compose起動、Health Check、Migration、Fake OAuth、`echo` AgentのAPI→Queue→Worker→Run

通常の自動テストはGoogle・OpenAIへ実通信しません。実Googleアカウントを使ったOAuth→Gmail下書き→Calendar予定の一貫した自動E2Eテストはありません。

## 19. 現在の制約と将来拡張

現在の主な制約は次のとおりです。

- Calendar設定をUI/APIから有効化できない。
- Gmail Push通知を受け取れない。
- 接続解除、Run一覧JSON API、Run ID指定再試行APIがない。
- Function Calling / Tool Useループはなく、Structured Outputsを使用している。
- 実外部サービスを使う自動E2Eテストがない。

将来候補は次のとおりです。

- Calendar設定UI/API
- Gmail Push通知とPub/Sub Webhook
- OAuth接続解除
- Calendar予定の更新候補提示
- 求人票や企業情報を参照するRAG
- ユーザーの空き時間を使った候補日時提案
- Function Calling / Tool Useループ
