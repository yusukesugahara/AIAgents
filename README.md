# AIAgents

複数のAIエージェントを設計・実装・運用するためのリポジトリです。

各エージェントの仕様、アーキテクチャ、運用ルールは `docs/` 以下で管理します。

## 開発

必要環境は Bun 1.3.14 です。

```bash
bun install
bun run typecheck
bun run lint
bun test
```

開発用 API は次で起動します。

```bash
bun --filter @ai-agents/api start
```

最初の基盤実装では、`GET /health/live` が利用できます。PostgreSQL、Docker、ジョブキュー、外部サービス連携は後続の実装範囲です。
