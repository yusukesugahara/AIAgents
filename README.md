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

PostgreSQL ベースの基盤実装では、次のヘルスチェックを利用できます。

```bash
curl http://localhost:4000/health/live
curl http://localhost:4000/health/ready
```

Docker での起動確認は次です。

```bash
cp .env.example .env
docker compose up --build -d postgres
bun run db:migrate
docker compose up --build
```

`.env`を作成しない場合でもDocker Composeは起動でき、コンテナ内のDB接続情報には
`compose.yaml`の開発用デフォルト値が使われます。ホストからMigrationを実行する場合は、
上記のように`.env.example`をコピーしてください。

DB Integration TestとDocker Compose全体のIntegration Testは、それぞれ次で実行します。

```bash
bun run test:integration:database
bun run test:integration:docker
```
