# 技術課題提出ガイド

## 選択テーマ

テーマA: AI APIを使ったAIエージェント開発

本アプリケーションは、就職活動メールを対象とする業務エージェントです。Gmailを実業務の入出力に用い、OpenAI APIでメール理解を行います。Google Calendar連携処理も実装済みですが、現行UIから作成設定を有効化する機能は未実装です。

## 提出前チェックリスト

| 課題要件 | 状態 | 根拠 |
|---|---|---|
| TypeScriptで実装 | 対応済み | Bun Workspace配下の全実装 |
| 任意のLLM APIを使うエージェント | 対応済み | OpenAI Responses API、Function Calling、Structured Outputs |
| UIを持つ | 対応済み | セットアップ・実行履歴Web画面 |
| E2Eで動作 | 対応済み | Compose実行経路と求人メール統合テスト。実Google/OpenAIはREADME記載の手動確認手順を使用 |
| API・アーキテクチャ選定理由をREADMEへ記載 | 対応済み | [README](../README.md) |
| Function Calling / Tool Useループを自前実装 | 対応済み | `packages/llm`のResponses APIループと、分析・下書きTools |
| README整備 | 対応済み | セットアップ、構成図、利用方法、設計意図を記載 |
| CI | 対応済み | `.github/workflows/ci.yml` |

## Function Calling実装

課題文の中心要件に対応するため、次のFunction Calling / Tool Useループを実装しています。

1. 分析ループで`get_email_thread`と`get_agent_context`を呼び、検証済み分析を返す。
2. 下書きループで`create_reply_draft`または`create_scheduling_placeholder_draft`を呼ぶ。
3. tool callの名前・引数をZodで検証し、アプリ側で実行する。
4. 同じ`call_id`の`function_call_output`を返し、最終回答まで上限付きで反復する。
5. ツール名・回数・作成/再利用状態だけをRun Stepへ記録する。
6. Policyと冪等性を外部書き込み境界に残し、メール送信・削除ツールを公開しない。

## 30分デモの進め方

1. 課題と対象ユーザーを説明（2分）
2. アーキテクチャと安全設計を説明（5分）
3. Google OAuth・返信下書き設定を表示（3分）
4. 面談調整メールを定期実行へ投入（5分）
5. 実行履歴で分類・Step・Draft IDを確認（5分）
6. Gmail下書きを開き、候補日時を編集して送信直前までを示す（3分）
7. 冪等性、再実行、エラー時の要確認化を説明（3分）
8. AI開発支援ツールの利用方法、学び、今後の拡張を説明（4分）

## デモ時に説明する設計意図

- LLMの役割を「意味理解・構造化」に限定し、外部書き込みの可否は型付きPolicyで決定する。
- 送信を自動化せず、ユーザーの確認を最後に残す。
- Gmail Draft ID、Calendar Event ID、Jobの冪等性キーを分けて、同じメールの重複処理を防ぐ。
- 失敗を握りつぶさず、Run・Step・安全なエラーコードとして残す。
- メール本文やPromptを永続化しないことで、業務メールの露出を最小化する。
