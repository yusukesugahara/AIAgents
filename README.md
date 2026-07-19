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
APP_ENV=development bun --filter @ai-agents/api start
```

PostgreSQL ベースの基盤実装では、次のヘルスチェックを利用できます。

```bash
curl http://localhost:4000/health/live
curl http://localhost:4000/health/ready
```

Docker での起動確認は次です。

```bash
cp .env.example .env
docker compose up --build
```

`.env`を作成しない場合でもDocker Composeは起動でき、コンテナ内のDB接続情報には
`compose.yaml`の開発用デフォルト値が使われます。Migrationは`migrate`サービスがAPI／Workerの
起動前に自動適用します。

Job は初回を含めて既定で最大 3 回実行され、再試行時は 1 秒、2 秒待機します。

DB Integration TestとDocker Compose全体のIntegration Testは、それぞれ次で実行します。

```bash
bun run test:integration:database
bun run test:integration:docker
```
