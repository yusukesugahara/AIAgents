# AIAgents

複数のAIエージェントを設計・実装・運用するためのリポジトリです。

各エージェントの仕様、アーキテクチャ、運用ルールは `docs/` 以下で管理します。

## 開発

必要環境は Bun 1.3.14 です。

```bash
bun --no-env-file install
bun --no-env-file run typecheck
bun --no-env-file run lint
bun --no-env-file test
```

開発用 API は次で起動します。

```bash
APP_ENV=development bun --no-env-file --filter @ai-agents/api start
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

このリポジトリではBunによる`.env`の自動読込を無効化しています。秘密値はOS／CIの環境変数または
Docker Composeの環境設定から渡してください。Migrationは`migrate`サービスがAPI／Workerの起動前に
自動適用します。

Job は初回を含めて既定で最大 3 回実行され、再試行時は 1 秒、2 秒待機します。

## Google OAuth

Google OAuthを有効にするには、Google Cloud ConsoleでWebアプリケーションのOAuth Clientを作成し、
`GOOGLE_REDIRECT_URI`（既定値: `http://localhost:4000/auth/google/callback`）を承認済みリダイレクトURIへ登録します。
localhost以外のリダイレクトURIにはHTTPSが必須です。
OS／CIの環境変数へClient ID、Client Secret、および`openssl rand -base64 32`で作成した`TOKEN_ENCRYPTION_KEY`を設定後、
`GET /auth/google`をブラウザで開いて接続します。Gmail本文の読取権限だけを要求し、Refresh Tokenは暗号化して保存します。

## OpenAI LLM Provider

`packages/llm`はOpenAI Responses APIのStructured OutputsをZodスキーマで検証し、Agentへ検証済みの結果だけを返します。
`OPENAI_API_KEY`は`.env`ではなくOS／CIの環境変数から実行プロセスへ渡してください。モデル名は呼び出し側が指定し、
モデル、Prompt版、Schema版、Token使用量、推定コストのみを`llm_invocations`へ保存します。Prompt、メール本文、生成結果本文は保存しません。

`job-search-email` AgentはGmailのMessage／Thread IDを受け取り、就活メール分類、返信要否、面談情報と短い根拠を構造化して
`job_email_analyses`へRun単位で追記します。`OPENAI_ANALYSIS_MODEL`が未設定の場合、Workerは起動しません。
LLM拒否または構造不正時は本文を保存せず、Runと結び付いた`review_requests`を作成します。

DB Integration TestとDocker Compose全体のIntegration Testは、それぞれ次で実行します。

```bash
bun --no-env-file run test:integration:database
bun --no-env-file run test:integration:docker
```
