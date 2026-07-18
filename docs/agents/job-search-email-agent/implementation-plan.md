# 就職活動メールエージェント 実装計画

## 1. 方針

最初からGmail Push通知や完全な管理画面を作らず、Docker Compose上で動くポーリング型MVPを段階的に完成させます。

各フェーズは、単にコードが存在することではなく、利用者が実際に操作できる受け入れ条件を満たした時点で完了とします。

## 2. フェーズ一覧

| フェーズ | 内容 | 完了時にできること |
|---|---|---|
| 0 | リポジトリ基盤 | 複数エージェントを追加できる |
| 1 | Docker・DB基盤 | API、Worker、PostgreSQLが起動する |
| 2 | Google OAuth | Gmail・Calendarを利用者が連携できる |
| 3 | Gmail読み取り | 就活メール候補を取得できる |
| 4 | AI解析 | 就活判定、返信要否、日時、URLをJSON化できる |
| 5 | Gmail下書き | 元スレッドに返信下書きを作れる |
| 6 | Calendar登録 | 確定Web面談を重複なく登録できる |
| 7 | 自動ポーリング | 5分ごとに未処理メールを処理できる |
| 8 | 管理画面 | 設定、履歴、要確認を確認できる |
| 9 | 本番化 | Push通知、監視、秘密情報管理を導入する |

## 3. Phase 0: リポジトリ基盤

### 実装内容

- npm workspacesまたはpnpm workspace
- `apps/`、`agents/`、`packages/` の作成
- ESLint、Prettier、TypeScript設定
- エージェントマニフェスト
- 共通Agent Runnerの最小インターフェース
- `.env.example`
- GitHub Actionsのlint、typecheck、test

### 受け入れ条件

- [ ] 新しいエージェントを `agents/<agent-id>/` に追加できる。
- [ ] `agent.manifest.ts` からAgent IDと機能を取得できる。
- [ ] 共通パッケージを各アプリ・エージェントから参照できる。
- [ ] CIでlint、typecheck、testが実行される。

## 4. Phase 1: Docker・DB基盤

### 実装内容

- `apps/api`
- `apps/worker`
- PostgreSQL
- Dockerfile
- `docker-compose.yml`
- Migration
- `/health`
- 構造化ログ

### 受け入れ条件

- [ ] `docker compose up --build` で全サービスが起動する。
- [ ] APIが `GET /health` に200を返す。
- [ ] Workerが起動し、待機状態になる。
- [ ] PostgreSQLのhealthcheckが成功する。
- [ ] Migrationを何度実行しても重複適用されない。
- [ ] コンテナ再起動後もDBデータが保持される。

## 5. Phase 2: Google OAuth

### 実装内容

- OAuth開始API
- OAuth callback
- `state` の保存と検証
- Gmail・Calendar scope
- リフレッシュトークン暗号化
- Google接続情報テーブル
- 接続解除API

### 受け入れ条件

- [ ] `/auth/google/start` からGoogle認可画面へ移動できる。
- [ ] 許可後、callbackでGoogleアカウントを保存できる。
- [ ] リフレッシュトークンが平文でDBに保存されない。
- [ ] callbackの `state` が不一致の場合は認証を拒否する。
- [ ] 再起動後も保存tokenからGmail APIへ接続できる。
- [ ] 連携解除後はエージェントがそのアカウントを処理しない。

## 6. Phase 3: Gmail読み取り

### 実装内容

- Gmailクライアント
- `messages.list`
- `messages.get`
- `threads.get`
- MIME本文抽出
- ヘッダー抽出
- メッセージ保存
- 処理済み判定

### 受け入れ条件

- [ ] 直近24時間の受信メール一覧を取得できる。
- [ ] 件名、送信者、本文、thread IDを取得できる。
- [ ] multipartメールから `text/plain` を取得できる。
- [ ] HTMLしかないメールから解析用テキストを生成できる。
- [ ] 同じGmail message IDをDBに重複登録しない。
- [ ] Gmail APIの一時エラーをリトライできる。

## 7. Phase 4: AI解析

### 実装内容

- OpenAIクライアント
- Structured Outputs
- Zod Schema
- 解析プロンプト
- Prompt Injection対策
- 解析結果保存
- 評価用メールfixture

### 受け入れ条件

- [ ] 就活関連・非関連をSchema通りに返す。
- [ ] 返信要否を返す。
- [ ] 会社名、担当者名を抽出する。
- [ ] 確定日時と候補日時を区別する。
- [ ] Web会議URLと予約ページURLを区別する。
- [ ] 明記されていない日時を推測しない。
- [ ] 不正な構造化出力は1回再試行後、要確認になる。
- [ ] メール本文中のAI向け命令に従わない。

### 初期評価基準

| 指標 | 目標 |
|---|---:|
| 就活メール判定の適合率 | 95%以上 |
| 会議URL抽出の正解率 | 99%以上 |
| 確定日時抽出の正解率 | 98%以上 |
| 誤ったCalendar自動登録 | 0件 |

## 8. Phase 5: Gmail下書き

### 実装内容

- 返信文生成プロンプト
- 返信Schema
- MIME生成
- Base64URLエンコード
- `drafts.create`
- `threadId`
- `In-Reply-To`
- `References`
- 下書き履歴保存

### 受け入れ条件

- [ ] 返信が必要な就活メールだけ下書きを作る。
- [ ] 下書きは元メールと同じスレッドに表示される。
- [ ] 下書き作成だけで送信されない。
- [ ] 返信本文に存在しない経歴や実績を追加しない。
- [ ] 重要な回答材料が不足する場合は下書きを作らず要確認にする。
- [ ] 同じメールを再処理しても下書きが増えない。

## 9. Phase 6: Google Calendar登録

### 実装内容

- Calendarクライアント
- 予定作成ポリシー
- `events.insert`
- 決定的イベントIDまたは冪等性キー
- 重複予定確認
- Calendar作成履歴

### 受け入れ条件

- [ ] 確定日時、終了日時、Web会議URLがある場合だけ登録する。
- [ ] 予約ページURLだけのメールは登録しない。
- [ ] 候補日時だけのメールは登録しない。
- [ ] タイトル、日時、URL、会社名、担当者名を確認できる。
- [ ] 同じメールを再処理しても予定が増えない。
- [ ] 既存予定との重複候補は自動作成せず要確認にする。
- [ ] 日時変更メールは初期MVPでは要確認にする。

## 10. Phase 7: 自動ポーリング

### 実装内容

- `@nestjs/schedule`
- 5分間隔の定期処理
- 接続アカウント単位の処理
- 排他制御
- リトライ状態
- 手動再実行

### 受け入れ条件

- [ ] エージェント有効時だけ定期処理する。
- [ ] 複数回ポーリングが重なっても同じメールを同時処理しない。
- [ ] APIコンテナとWorkerコンテナを分離できる。
- [ ] Worker再起動後に未完了処理を再開できる。
- [ ] 一時エラーは最大3回リトライする。
- [ ] 認証失敗時は再連携が必要な状態になる。

## 11. Phase 8: 管理画面

### 実装内容

- Google連携画面
- エージェント設定画面
- 処理履歴一覧・詳細
- 要確認一覧
- 手動実行ボタン
- エラー表示

### 受け入れ条件

- [ ] Google連携状態を確認できる。
- [ ] エージェントをON/OFFできる。
- [ ] 氏名と署名を設定できる。
- [ ] 下書き作成とCalendar登録を個別にON/OFFできる。
- [ ] 処理したメールと結果を確認できる。
- [ ] 要確認になった理由を確認できる。
- [ ] エラーになった処理を手動再実行できる。

## 12. Phase 9: 本番化

### 実装内容

- Gmail `users.watch`
- Google Cloud Pub/Sub
- Webhook
- Cloud Tasksまたは本番ジョブキュー
- watchの日次更新
- 同期漏れ確認
- Secret Manager
- Cloud SQL
- Cloud Run
- OpenTelemetry
- アラート

### 受け入れ条件

- [ ] Gmailの変更通知から新着メール処理を開始できる。
- [ ] Webhookは重い処理を待たず成功応答する。
- [ ] Push通知が欠落しても定期同期で回復できる。
- [ ] Gmail watchを期限切れ前に更新できる。
- [ ] 秘密情報をDocker imageやGitHubに含めない。
- [ ] エラー率と処理停止を監視できる。
- [ ] OAuthスコープと公開要件を確認済みである。

## 13. テスト構成

```text
agents/job-search-email-agent/tests/
├── fixtures/
│   ├── meeting-confirmed/
│   ├── scheduling-request/
│   ├── rejection/
│   ├── non-job-related/
│   ├── prompt-injection/
│   └── ambiguous-date/
├── unit/
│   ├── draft-policy.spec.ts
│   ├── calendar-policy.spec.ts
│   └── mime-parser.spec.ts
├── integration/
│   ├── gmail.adapter.spec.ts
│   ├── calendar.adapter.spec.ts
│   └── workflow.spec.ts
└── evaluation/
    └── job-email-analysis.eval.ts
```

## 14. 必須テストケース

### Gmail

- 通常のtext/plainメール
- HTMLのみのメール
- multipart/alternative
- 返信スレッド
- 日本語件名
- 長い引用履歴

### AI解析

- 面談確定
- 候補日時提示
- 日程予約ページ
- 不採用通知
- 課題提出依頼
- 書類受領通知
- 一般的な営業メール
- メール本文内のPrompt Injection
- タイムゾーン明記あり・なし
- 終了時刻がないメール

### 冪等性

- 同じmessage IDの連続処理
- Worker二重起動
- Gmail成功後にDB保存失敗
- Calendar成功後にDB保存失敗

## 15. Definition of Done

各フェーズは次をすべて満たした場合に完了とします。

- [ ] 仕様書の受け入れ条件を満たす。
- [ ] Unit Testと必要なIntegration Testが通る。
- [ ] lint、typecheck、buildが通る。
- [ ] エラー時の動作を確認している。
- [ ] 秘密情報がコミットされていない。
- [ ] Docker Composeで再現できる。
- [ ] 実装に合わせて仕様書を更新している。
