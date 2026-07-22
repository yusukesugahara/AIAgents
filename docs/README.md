# AIAgents ドキュメント

このディレクトリでは、リポジトリ内で開発する複数のAIエージェントについて、共通設計、設計判断、エージェント固有仕様を分離して管理します。

## ディレクトリ構成

```text
docs/
├── README.md
├── architecture/
│   ├── repository-structure.md
│   ├── technical-stack.md
│   └── dependency-rules.md
├── agents/
│   ├── _template/
│   │   └── specification-template.md
│   └── job-search-email-agent/
│       ├── specification.md
│       ├── implementation-plan.md
│       └── operation-guide.md
└── decisions/
    ├── 0001-modular-monolith.md
    ├── 0002-hono-and-bun.md
    └── 0003-drizzle-and-postgresql.md
```

提出時に確認する要件とデモの進め方は [submission.md](submission.md) を参照してください。

## 共通アーキテクチャ

| 文書 | 内容 |
|---|---|
| `architecture/repository-structure.md` | `apps`、`agents`、`packages`の構成と責務 |
| `architecture/technical-stack.md` | Hono、Bun、PostgreSQL、Drizzle等の利用範囲 |
| `architecture/dependency-rules.md` | package間の依存方向と禁止import |

## 設計判断

| ADR | 判断 |
|---|---|
| `0001-modular-monolith.md` | API、Worker、DBを共有するモジュラーモノリスとして開始する |
| `0002-hono-and-bun.md` | APIにHono、RuntimeとWorkspaceにBunを採用する |
| `0003-drizzle-and-postgresql.md` | PostgreSQL、Drizzle ORM、postgres.jsを採用する |

## 管理方針

- 共通アーキテクチャ、認証、監視、セキュリティ、デプロイ方針は`docs/architecture/`に置く。
- 個別エージェントの目的、入力、出力、外部サービス、ワークフロー、Policy、受け入れ条件は`docs/agents/<agent-id>/`に置く。
- 新しいエージェントを追加するときは`docs/agents/_template/specification-template.md`を複製する。
- 重要な技術選定や構造変更は`docs/decisions/`へADRとして残す。
- AIの判断と外部サービスへの書き込み処理を分離する。
- エージェントはGoogle SDK、OpenAI SDK、Drizzle ORMへ直接依存しない。
- 外部書き込み前にZod SchemaとTypeScript Policyを通す。
- 自動送信、削除、購入などの高リスク操作は初期状態で無効にする。

## 標準技術スタック

```text
Runtime / Package manager / Test: Bun
API: Hono
Worker: Bunプロセス
Validation: Zod
Database: PostgreSQL 18.4
ORM: Drizzle ORM
Driver: postgres.js
Local runtime: Docker Compose
```

## 登録済みエージェント

| Agent ID | 名称 | 概要 | 状態 |
|---|---|---|---|
| `job-search-email` | 就職活動メールエージェント | Gmailの就活関連メールを解析し、返信下書きとWeb面談予定を作成する | 実装済み |

## 新規エージェント追加手順

1. `docs/agents/_template/specification-template.md`を複製する。
2. Agent ID、目的、入力、出力、Trigger、Capabilityを定義する。
3. AIへ任せる処理とアプリケーションで決定する処理を分離する。
4. `ports.ts`へ必要な外部能力を定義する。
5. `policy.ts`へ外部書き込み条件を純粋関数として定義する。
6. Agent Input、Output、LLM OutputのZod Schemaを定義する。
7. データモデル、冪等性Key、状態遷移を定義する。
8. Unit Test、Integration Test、LLM Evaluationを定義する。
9. 技術選定や共通構造の変更が必要ならADRを追加する。
10. `docs/README.md`の登録済みエージェント一覧へ追記する。
