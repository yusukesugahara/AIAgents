# ADR-0003: PostgreSQLとDrizzle ORMを採用する

- Status: Accepted
- Date: 2026-07-18

## Context

AIAgentsでは、次のデータ処理が必要です。

- Agent RunとStepの状態管理
- Gmail message IDによる冪等性
- Google OAuth Tokenの保存
- JSON形式のAI解析結果
- PostgreSQLジョブキュー
- `FOR UPDATE SKIP LOCKED`による排他制御
- Unique ConstraintとUpsert
- Transaction
- 実行履歴の検索

CRUDだけでなく、SQLとPostgreSQL固有機能を明示的に扱う必要があります。

## Decision

- DatabaseにPostgreSQL 17を採用する
- ORMにDrizzle ORMを採用する
- PostgreSQL Driverに`postgres.js`を採用する
- Migration生成にDrizzle Kitを使用する
- ORM利用は`packages/database`へ限定する
- エージェントはRepository interfaceへ依存する
- 複雑なQueryではDrizzleのSQL TemplateまたはSQL Migrationを使用する

## Consequences

### Positive

- TypeScript Schemaから型推論できる
- SQLに近く、実行内容を把握しやすい
- PostgreSQL固有機能を扱いやすい
- Migration SQLをレビューできる
- Hono + Bunの軽量な構成と合わせやすい
- ORMから生SQLへ段階的に下りられる

### Negative

- RepositoryやRelationの設計を自分で決める必要がある
- Prismaほど統一された高レベルCRUD体験ではない
- SQLとIndexの知識が必要
- Drizzle Schemaと手書きSQLの整合性を管理する必要がある

## Driver decision

初期MVPでは`postgres.js`を使用します。

Bun組み込みSQLは将来候補としますが、次を確認するまでは切り替えません。

- 並列Query
- Connection Pool
- Transaction
- Docker環境
- Migration
- Workerの長時間実行
- Shutdown時のConnection Close

## Migration rules

- 適用済みMigrationを変更しない
- 生成されたSQLをレビューする
- 本番環境でSchema Pushを使わない
- 部分Index、Function、TriggerはSQL Migrationで管理可能
- MigrationはAPI起動時に暗黙実行しない

## Transaction rules

外部API呼び出し中にTransactionを保持しません。

```text
DBで実行権を確保
  ↓ commit
外部APIを実行
  ↓
DBへ結果を保存
```

外部API成功後のDB保存失敗に備え、業務上の冪等性キーと外部サービスIDを保存します。

## ORM boundary

禁止:

```ts
// agents配下
import { db } from '@ai-agents/database';
import { eq } from 'drizzle-orm';
```

許可:

```ts
export interface AgentRunPort {
  start(input: StartRunInput): Promise<AgentRun>;
  recordStep(input: RecordStepInput): Promise<void>;
  complete(runId: string): Promise<void>;
}
```

具体的なDrizzle実装は`packages/database`に置きます。

## Alternatives considered

### Prisma

開発体験は優れていますが、PostgreSQLジョブキュー、`SKIP LOCKED`、部分Index、複雑なSQLを扱う今回の構成では、SQLとの距離が近いDrizzleを優先しました。

### Kysely

有力な代替候補です。SQL中心の実装がさらに増えた場合は再評価します。現時点ではSchema、Migration、Queryを同一エコシステムで管理しやすいDrizzleを選びます。

### TypeORM

DecoratorとEntity中心の設計をHono + Bunへ持ち込む必要性が低いため採用しません。

## Revisit conditions

- Drizzleで重要なPostgreSQL機能を安全に扱えない
- Query Builderより手書きSQLの割合が大半になる
- Migration運用が不安定になる
- Bunと`postgres.js`の組み合わせに重大な問題が発生する
