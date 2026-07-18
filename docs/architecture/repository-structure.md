# 複数AIエージェント向けリポジトリ構成

## 1. 目的

このリポジトリは、用途の異なる複数のAIエージェントを同一基盤上で設計・実装・運用することを前提とします。

エージェントごとにアプリケーションを完全分離するのではなく、認証、LLM接続、ジョブ実行、監視、ログ、データベース接続などの共通機能を再利用しつつ、エージェント固有のワークフローとルールを分離します。

## 2. 推奨構成

```text
AIAgents/
├── apps/
│   ├── web/                       # 管理画面
│   ├── api/                       # OAuth、設定、Webhook、履歴API
│   └── worker/                    # 非同期処理・定期処理
├── agents/
│   ├── job-search-email-agent/
│   │   ├── agent.manifest.ts
│   │   ├── application/
│   │   ├── domain/
│   │   ├── infrastructure/
│   │   ├── prompts/
│   │   ├── schemas/
│   │   └── tests/
│   └── <next-agent>/
├── packages/
│   ├── agent-core/                # 共通実行基盤
│   ├── ai-client/                 # LLMクライアント、構造化出力
│   ├── database/                  # DB接続、Migration
│   ├── observability/             # ログ、メトリクス、トレース
│   ├── security/                  # 暗号化、秘密情報管理
│   ├── shared/                    # 共通型、ユーティリティ
│   └── ui/                        # 共通UI
├── docs/
│   ├── architecture/
│   ├── agents/
│   └── decisions/
├── docker/
├── docker-compose.yml
├── package.json
└── README.md
```

## 3. エージェント境界

各エージェントは、少なくとも次の責務を持ちます。

```text
agents/<agent-id>/
├── agent.manifest.ts              # ID、名称、バージョン、利用ツール
├── application/                   # ワークフロー、ユースケース
├── domain/                        # 判定ルール、状態、値オブジェクト
├── infrastructure/                # Gmail等の固有アダプター
├── prompts/                       # プロンプトとバージョン
├── schemas/                       # LLM構造化出力スキーマ
└── tests/                         # 評価データ、Unit、Integration
```

エージェント間で直接内部実装を参照せず、共通化が必要な処理は `packages/` に昇格させます。

## 4. エージェントマニフェスト

各エージェントは、実行基盤から発見できるようにマニフェストを持ちます。

```ts
export const jobSearchEmailAgentManifest = {
  id: 'job-search-email-agent',
  name: '就職活動メールエージェント',
  version: '0.1.0',
  triggerTypes: ['schedule', 'gmail-push'],
  requiredConnections: ['google', 'openai'],
  capabilities: [
    'email.read',
    'email.draft.create',
    'calendar.event.create',
  ],
  defaultEnabled: false,
} as const;
```

## 5. 共通実行基盤

`packages/agent-core` は次を担当します。

- エージェント登録と起動
- トリガー受付
- 実行IDの発行
- 冪等性キーの検証
- ステップ実行と状態遷移
- リトライ
- タイムアウト
- Human-in-the-loop
- 実行ログ
- エラー分類

エージェント固有処理は、共通基盤が定義するインターフェースに実装します。

```ts
export interface AgentWorkflow<TInput, TResult> {
  execute(context: AgentContext, input: TInput): Promise<TResult>;
}
```

## 6. AIと外部操作の分離

AIには、分類、抽出、要約、文章生成だけを担当させます。

```text
外部データ取得
  ↓
AIによる解析・候補生成
  ↓
JSON Schema検証
  ↓
ドメインルール検証
  ↓
外部サービスへの書き込み
```

AIが返したツール名や引数を無条件で実行してはいけません。外部サービスへの書き込みは、必ずアプリケーション側の許可ルールを通します。

## 7. データ管理

共通テーブルとエージェント固有テーブルを分離します。

### 共通テーブル

- `users`
- `connections`
- `agent_definitions`
- `agent_settings`
- `agent_runs`
- `agent_run_steps`
- `agent_errors`

### エージェント固有テーブル

固有テーブルには、原則として `agent_id` または業務上の一意キーを持たせます。

```text
job_email_messages
job_email_analyses
job_email_drafts
job_calendar_events
```

## 8. 共通状態モデル

```text
QUEUED
  ↓
RUNNING
  ├── NEEDS_REVIEW
  ├── RETRY_WAITING
  ├── FAILED
  └── COMPLETED
```

各ステップにも同様の状態を持たせ、途中から再開できるようにします。

## 9. Docker Compose構成

初期段階では、次のコンテナを共通基盤として利用します。

```text
web       Next.js管理画面
api       NestJS API
worker    NestJS Worker
postgres  PostgreSQL
```

必要になった段階で次を追加します。

```text
redis     BullMQ用
otel      OpenTelemetry Collector
```

## 10. 設計原則

1. エージェントごとに固有の入力、出力、ルールを明示する。
2. AIの出力を信用境界の外に置く。
3. 外部書き込みは冪等にする。
4. 自動送信や削除などの高リスク操作は初期状態で無効にする。
5. プロンプトとスキーマにバージョンを付ける。
6. すべての実行に根拠、入力、出力、結果を記録する。
7. 失敗時にステップ単位で再実行できるようにする。
8. 新しいエージェントはテンプレートから追加する。
