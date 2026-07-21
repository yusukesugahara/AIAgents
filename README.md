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

## 実行履歴Web画面

API起動後に `http://localhost:4000/history` を開くと、直近のAgent Runを25件単位で確認できます。
Run詳細では処理Step、失敗コード、Gmail draft ID、Calendar event IDを表示します。メール本文、
Prompt、Step入力などの機微情報は表示せず、レスポンスはキャッシュしません。

## セットアップWeb画面

`http://localhost:4000/` を開くとセットアップ画面へ移動します。画面からGmail読取、Gmail下書き、
Google CalendarのOAuth登録を開始できます。登録済みGoogleアカウントの直近の受信メールを選ぶか、
GmailのMessage／Thread IDを指定すると、`job-search-email` Agentを実際のJob Queueへテスト投入し、
実行状況と履歴を確認できます。受信メールの本文はセットアップ画面、ログ、DBへ保存しません。
Gmailとの下書き接続だけを確認する場合は、最近の受信メールにある「テスト下書きを作成」を押します。
元メールへの固定文面の返信下書きを作成しますが、AI解析とメール送信は行いません。同じメールでもう一度
押した場合は既存のテスト下書きを再利用するため、下書きは重複しません。
Gmail下書きを作成する場合は、Gmail下書き権限を登録し、画面の「返信下書き設定」で氏名、署名、
信頼度しきい値を保存してから「AI解析・下書き作成」を実行します。Agentが返信不要と判断した場合や、
必要情報不足、低信頼度などの安全条件に該当した場合は下書きを作成せずレビュー待ちにします。

### Gmailの定期取得

Workerは起動直後と、その後 `GMAIL_POLL_INTERVAL_SECONDS` ごと（既定300秒＝5分）にGmailを確認します。
対象は読取・下書き権限があり、返信下書き設定を保存して下書き作成をONにした接続済みアカウントです。
`GMAIL_LOOKBACK_QUERY`（既定 `in:inbox newer_than:1d`）に一致するメールを、1回につき
`GMAIL_POLL_MAX_RESULTS` 件（既定50件）まで確認し、`schedule` Jobとして投入します。
同じGoogle接続・Gmail Message IDには同じ冪等キーを使うため、次回以降のポーリングでは
同じメールのJobやGmail下書きを重複作成しません。

### 開発時のホットリロード

開発時は次のコマンドで起動すると、`apps/`、`agents/`、`packages/` 以下の変更を監視し、
APIとWorkerをそれぞれ自動再起動します。

```bash
bun --no-env-file run compose:dev
```

停止する場合は `Ctrl+C` を押し、必要に応じて次を実行します。

```bash
bun --no-env-file run compose:dev:down
```

依存パッケージやDockerfileを変更した場合は、ホットリロードではなく再ビルドが必要です。

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
