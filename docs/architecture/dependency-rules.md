# 依存関係ルール

## 1. 目的

AIAgentsへエージェントを追加し続けても、特定のエージェント、外部SDK、ORM、HTTP Frameworkが全体へ拡散しないように、パッケージ間の依存方向を定義します。

この文書のルールは、ディレクトリの見た目ではなくimportの可否を定めるものです。

## 2. レイヤー

```text
apps
  ↓
agents
  ↓
agent-coreの公開型

apps
  ↓
packagesの具体実装

packagesの高レベル実装
  ↓
packagesの低レベル実装
```

### `apps`

Composition Rootです。具体的な実装を生成し、interfaceへ注入します。

### `agents`

エージェント固有の処理順序、入力、出力、Policy、Prompt、Schemaを持ちます。

### `packages`

外部サービス、DB、ログ、共通実行基盤などの再利用可能な実装を持ちます。

## 3. 許可する依存

| From | To | 条件 |
|---|---|---|
| `apps/api` | `agents/*` | Agent Registry登録、型参照 |
| `apps/api` | `packages/*` | Route、Repository、Connectorの組み立て |
| `apps/worker` | `agents/*` | Agent Registry登録、実行 |
| `apps/worker` | `packages/*` | Job Queue、DB、Connector、LLMの組み立て |
| `agents/*` | `packages/agent-core` | 公開型、共通Error、Contextのみ |
| `packages/database` | Drizzle、postgres.js | DB実装内に限定 |
| `packages/connector-google` | Google SDK、`fetch` | Google実装内に限定 |
| `packages/llm` | OpenAI SDK | LLM実装内に限定 |
| `packages/observability` | Logging、Tracing SDK | Observability実装内に限定 |

## 4. 禁止する依存

### エージェントから外部SDK

禁止:

```ts
import OpenAI from 'openai';
import { google } from 'googleapis';
import { drizzle } from 'drizzle-orm/postgres-js';
```

エージェントは`ports.ts`で必要な能力を宣言します。

### エージェントからDB実装

禁止:

```ts
import { db } from '@ai-agents/database';
import { agentRuns } from '@ai-agents/database/schema';
```

Repository interfaceを経由します。

### エージェント間の直接参照

禁止:

```ts
import { analyzeCompany } from '@ai-agents/company-signal/internal';
```

再利用が必要な機能は、エージェント固有概念を除去して`packages`へ昇格させます。

### packagesからagents

`packages`は特定のエージェントを知ってはいけません。

禁止:

```ts
import { jobSearchEmailManifest } from '@ai-agents/job-search-email';
```

### agentsからapps

禁止:

```ts
import { app } from '@ai-agents/api';
```

### RouteからStepの直接実行

禁止:

```ts
app.post('/analyze', async () => analyzeEmailStep(...));
```

APIはAgent RunnerまたはJob Queueを経由します。

## 5. Composition Root

具体実装の組み立ては`apps/api/src/bootstrap.ts`と`apps/worker/src/bootstrap.ts`に置きます。

```ts
export function createWorkerDependencies(config: Config) {
  const { db, close } = createDatabase(config.databaseUrl);
  const google = createGoogleConnector(config.google);
  const llm = createOpenAiProvider(config.openai);

  const runRepository = createAgentRunRepository(db);
  const jobRepository = createAgentJobRepository(db);

  const registry = createAgentRegistry();
  registry.register(
    createJobSearchEmailAgent({
      gmail: google.gmail,
      calendar: google.calendar,
      llm,
      runs: runRepository,
    }),
  );

  return {
    registry,
    jobRepository,
    close,
  };
}
```

## 6. Portの配置

エージェント固有の要求は、対象エージェントの`ports.ts`に置きます。

```ts
export interface JobSearchEmailPorts {
  gmail: JobEmailGmailPort;
  calendar: JobEmailCalendarPort;
  llm: JobEmailLlmPort;
  runs: AgentRunPort;
}
```

複数のエージェントで同一のinterfaceが必要になった場合は、`packages/agent-core`または専用packageへの昇格を検討します。

最初から巨大な共通interfaceを作ってはいけません。

## 7. Domain型と外部サービス型

外部サービスの型をエージェント内部へ持ち込みません。

禁止:

```ts
async function analyze(message: gmail_v1.Schema$Message) {}
```

許可:

```ts
export type EmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  sentAt: Date;
  bodyText: string;
};
```

ConnectorでGoogleの型をアプリケーション型へ変換します。

## 8. エラー境界

外部SDK固有Errorをエージェントへ伝播させません。

```ts
export type AgentDependencyErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'TEMPORARY_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'UNKNOWN';
```

ConnectorとProviderは、外部SDKのErrorを共通Errorへ変換します。

Agent Runnerは共通Error Codeを使用して、Retry、Needs Review、Failedを判断します。

## 9. Schema境界

次の境界では必ずZodで検証します。

- HTTP Request
- Webhook payload
- Agent Input
- Agent Output
- LLM Structured Output
- 環境変数
- JSONBデータの復元

TypeScriptの型注釈だけで外部入力を信用してはいけません。

## 10. Import規則

各packageは公開APIを`src/index.ts`から提供します。

推奨:

```ts
import { createAgentRegistry } from '@ai-agents/agent-core';
```

原則禁止:

```ts
import { createAgentRegistry } from '@ai-agents/agent-core/src/agent-registry';
```

内部ファイルへのDeep Importは、同一package内に限定します。

## 11. 共通化の基準

次をすべて満たす場合に`packages`へ昇格します。

1. 2つ以上のエージェントで利用する。
2. 特定のエージェント固有用語を含まない。
3. 独立してTestできる。
4. 安定したinterfaceを定義できる。

将来使いそうという理由だけで共通化しません。

## 12. 自動検査

実装開始後は、次の方法で依存違反を検出します。

- TypeScript Project References
- packageごとの`exports`
- ESLintのrestricted imports
- Dependency Cruiserまたは同等ツール
- CIでの循環依存検査

検査対象の例:

- `agents/**`から`drizzle-orm`へのimport
- `agents/**`から`googleapis`へのimport
- `agents/**`から`openai`へのimport
- `packages/**`から`agents/**`へのimport
- Agent間のDeep Import
