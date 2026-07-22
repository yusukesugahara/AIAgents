# 技術課題提出ガイド

## 選択テーマ

テーマA: AI APIを使ったAIエージェント開発

本アプリケーションは、就職活動メールを対象とする業務エージェントです。Gmailを実業務の入出力に用い、OpenAI APIでメール理解を行います。Google Calendar連携処理も実装済みですが、現行UIから作成設定を有効化する機能は未実装です。

## 提出前チェックリスト

| 課題要件 | 状態 | 根拠 |
|---|---|---|
| TypeScriptで実装 | 対応済み | Bun Workspace配下の全実装 |
| 任意のLLM APIを使うエージェント | 対応済み | OpenAI Responses API、Structured Outputs |
| UIを持つ | 対応済み | セットアップ・実行履歴Web画面 |
| E2Eで動作 | 一部対応 | Compose起動・Fake OAuth・`echo` AgentのE2Eと、Fake Gmail/Calendar/OpenAIを使う求人メール統合テスト。実Google/OpenAIの自動E2Eは未実装 |
| API・アーキテクチャ選定理由をREADMEへ記載 | 対応済み | [README](../README.md) |
| Function Calling / Tool Useループを自前実装 | **未対応** | 下記「提出前に追加する実装」参照 |
| README整備 | 対応済み | セットアップ、構成図、利用方法、設計意図を記載 |
| CI | 対応済み | `.github/workflows/ci.yml` |

## 提出前に追加する実装

課題文では、LLM APIを直接呼び、Function Calling / Tool Useループを自前で実装することがテーマAの中心要件です。現実装のLLM呼び出しはStructured Outputsのみであり、この要件を満たすには以下を追加します。

1. `get_email_thread`、`search_calendar_availability`、`prepare_reply_draft` などのツール定義を作る。
2. OpenAI Responses APIからのtool callを受け、Zodでツール引数を検証する。
3. ツールを実行し、結果をtool outputとしてResponses APIへ返す。
4. 最終回答または追加のtool callが返るまで、回数上限付きでループする。
5. ツール呼び出し履歴は、メール本文などの機微情報を除いた形でRun Stepへ記録する。
6. 既存のPolicyを外部書き込み境界として残し、LLMが直接メール送信・削除できないようにする。

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
