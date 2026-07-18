# ADR-0002: APIにHono、RuntimeにBunを採用する

- Status: Accepted
- Date: 2026-07-18

## Context

AIAgentsは、HTTP API、定期実行Worker、外部API連携、LLM呼び出しをTypeScriptで実装します。

初期段階では少人数で開発し、多数のDecorator、DI Container、Framework固有機能よりも、明示的な依存関係と小さな実行単位を重視します。

また、複数packageを1つのリポジトリで管理し、開発環境とDocker環境を簡潔に保つ必要があります。

## Decision

- Runtime、Package Manager、Test RunnerにBunを採用する
- Monorepo管理にBun Workspacesを使用する
- HTTP APIにHonoを使用する
- WorkerはHonoを使わない通常のBunプロセスとする
- 依存注入はDecoratorベースのDI ContainerではなくFactory関数で行う
- Web標準の`Request`、`Response`、`fetch`を優先する

## Scope

Honoの利用範囲は次に限定します。

- Routing
- Middleware
- OAuth callback
- Webhook
- 入力検証
- 管理API
- Health check

AI解析、Gmail処理、Calendar処理、Job実行、RetryはHonoから分離します。

## Consequences

### Positive

- APIの起動と実装が軽量
- Bun Workspacesでモノレポを構成できる
- `bun:test`でTest環境を統一できる
- Framework固有の抽象化が少ない
- Factory関数により依存関係を追いやすい
- WorkerにHTTP Frameworkを持ち込まずに済む

### Negative

- NestJSのようなModule、Guard、DI、Schedule機能は自分で設計する必要がある
- 外部Node.js SDKのBun互換性を確認する必要がある
- チーム内で構造を定義しないと、自由度が高すぎて実装がばらつく

## Guardrails

- Hono Routeから重い処理を直接実行しない
- RouteはUse CaseまたはJob Queueを呼ぶ
- `bootstrap.ts`をComposition Rootとする
- Google SDKなどNode.js互換性に依存する箇所はAdapterへ閉じ込める
- Bunと外部SDKの組み合わせをIntegration Testする
- Docker imageとBun Versionを固定する

## Alternatives considered

### NestJS + Node.js

認証、DI、Module、Scheduleが揃っている一方、今回の初期MVPには抽象化が重くなりやすいため採用しませんでした。

### Hono + Node.js

将来のFallback候補です。Bun固有の互換性問題が解消できない場合、エージェント本体を維持したままRuntimeだけをNode.jsへ変更できる構造にします。

### Cloudflare Workers

Gmail、PostgreSQL、長時間Worker処理を含む初期構成とは実行モデルが合わないため、初期採用しません。

## Revisit conditions

- 主要SDKがBun上で安定動作しない
- Workerの実行モデルがBunと合わない
- Node.js専用のObservabilityまたはSecurity要件が必要
- Hono Routeと型共有の管理が複雑化する
