# AIAgents ドキュメント

このディレクトリでは、リポジトリ内で開発する複数のAIエージェントについて、共通設計とエージェント固有仕様を分離して管理します。

## ディレクトリ構成

```text
docs/
├── README.md
├── architecture/
│   └── repository-structure.md
├── agents/
│   ├── _template/
│   │   └── specification-template.md
│   └── job-search-email-agent/
│       ├── specification.md
│       └── implementation-plan.md
└── decisions/
    └── （将来、ADRを配置）
```

## 管理方針

- 共通アーキテクチャ、認証、監視、セキュリティ、デプロイ方針は `docs/architecture/` に置く。
- 個別エージェントの目的、入力、出力、ツール、ワークフロー、受け入れ条件は `docs/agents/<agent-id>/` に置く。
- 新しいエージェントを追加するときは `docs/agents/_template/specification-template.md` を複製する。
- 重要な設計判断は、将来 `docs/decisions/` にADRとして残す。
- AIの判断と外部サービスへの書き込み処理を分離し、書き込み前にアプリケーション側でルール検証する。

## 登録済みエージェント

| Agent ID | 名称 | 概要 | 状態 |
|---|---|---|---|
| `job-search-email-agent` | 就職活動メールエージェント | Gmailの就活関連メールを解析し、返信下書きとWeb面談予定を作成する | 仕様策定中 |
