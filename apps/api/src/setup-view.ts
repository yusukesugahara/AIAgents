import type { GoogleConnectionSummary } from '@ai-agents/google-oauth';
import {
  calendarEventsScope,
  gmailComposeScope,
  gmailReadonlyScope,
} from '@ai-agents/google-oauth';
import { escapeHtml, renderWebPage } from './run-history-view';

export interface SetupJobView {
  readonly errorCode: string | null;
  readonly id: string;
  readonly latestRunId: string | null;
  readonly status: string;
}

export interface SetupMessageView {
  readonly from: string;
  readonly id: string;
  readonly sentAt: string;
  readonly subject: string;
  readonly threadId: string;
}

export interface SetupReplySettingsView {
  readonly createDrafts: boolean;
  readonly draftConfidenceThreshold: number;
  readonly emailSignature: string;
  readonly googleConnectionId: string;
  readonly userName: string;
}

interface SetupView {
  readonly connections: readonly GoogleConnectionSummary[];
  readonly csrfToken: string;
  readonly draftCreationReady: boolean;
  readonly draftTestErrorCode?: string;
  readonly draftTestReady: boolean;
  readonly draftTestResult?: {
    readonly draftId: string;
    readonly reused: boolean;
  };
  readonly gmailErrorCode?: string;
  readonly job?: SetupJobView;
  readonly messages: readonly SetupMessageView[];
  readonly oauthCompleted: boolean;
  readonly replySettings?: SetupReplySettingsView;
  readonly scheduledPollReady: boolean;
  readonly scheduledPollReset?: boolean;
  readonly scheduledPollResult?: {
    readonly connectionFailures: number;
    readonly eligibleConnections: number;
    readonly enqueueFailures: number;
    readonly jobRequestsAccepted: number;
    readonly messagesFound: number;
  };
  readonly selectedConnectionId?: string;
  readonly settingsSaved: boolean;
}

export function renderSetupPage(view: SetupView): string {
  const connected = view.connections.filter((connection) => connection.status === 'connected');
  return renderWebPage(
    'セットアップ',
    `<main class="container">
      <header class="page-header">
        <div>
          <p class="eyebrow">AIAgents</p>
          <h1>メールAgent セットアップ</h1>
          <p class="lead">Google権限を登録し、実際のジョブキューでテスト実行できます。</p>
        </div>
        <a class="button secondary" href="/history">実行履歴を見る</a>
      </header>
      ${view.oauthCompleted ? '<p class="notice" role="status">Googleアカウントの権限登録が完了しました。</p>' : ''}
      ${view.settingsSaved ? '<p class="notice" role="status">返信下書き設定を保存しました。</p>' : ''}
      ${renderDraftTestResult(view)}
      ${view.job ? renderJob(view.job) : ''}
      <section class="action-grid" aria-label="Google権限登録">
        ${authorizationCard('Gmail 読み取り', 'メール本文とスレッドを取得します。最初に登録してください。', '/auth/google')}
        ${authorizationCard('Gmail 下書き', '返信が必要な場合に、送信せず下書きだけを作成します。', '/auth/google/compose')}
        ${authorizationCard('Google Calendar', '確定したWeb面談をカレンダーへ登録します。', '/auth/google/calendar')}
      </section>
      <section class="panel" aria-labelledby="connections-heading">
        <div class="panel-heading"><h2 id="connections-heading">登録済みGoogleアカウント</h2><span class="muted">${view.connections.length}件</span></div>
        ${renderConnections(view.connections)}
      </section>
      ${renderReplySettings(view, connected)}
      ${renderScheduledPoll(view, connected)}
      ${renderInbox(view, connected)}
    </main>`,
  );
}

function renderInbox(view: SetupView, connections: readonly GoogleConnectionSummary[]): string {
  const options = connections
    .map(
      (connection) =>
        `<option value="${escapeHtml(connection.id)}"${connection.id === view.selectedConnectionId ? ' selected' : ''}>${escapeHtml(connection.email)}</option>`,
    )
    .join('');
  const picker = `<form class="form-grid" method="get" action="/setup"><label class="full">Googleアカウント<select name="connectionId" required>${options || '<option value="">登録済みアカウントがありません</option>'}</select></label><div class="full"><button class="button secondary" type="submit" ${connections.length === 0 ? 'disabled aria-disabled="true"' : ''}>最近の受信メールを取得</button></div></form>`;
  let result =
    '<p class="empty">アカウントを選択すると、直近7日間の受信メールを最大50件表示します。</p>';
  if (view.gmailErrorCode) {
    result = `<p class="empty">${renderGmailInboxError(view.gmailErrorCode)}</p>`;
  } else if (view.selectedConnectionId && view.messages.length === 0) {
    result = '<p class="empty">対象となる受信メールはありません。</p>';
  } else if (view.messages.length > 0) {
    result = `<div class="table-scroll"><table><thead><tr><th>差出人</th><th>件名</th><th>受信日時</th><th>操作</th></tr></thead><tbody>${view.messages
      .map(
        (message) =>
          `<tr><td>${escapeHtml(message.from)}</td><td>${escapeHtml(message.subject || '（件名なし）')}</td><td>${escapeHtml(message.sentAt)}</td><td><div style="display:grid;gap:8px;min-width:190px"><form method="post" action="/setup/draft-test"><input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}"><input type="hidden" name="googleConnectionId" value="${escapeHtml(view.selectedConnectionId ?? '')}"><input type="hidden" name="gmailMessageId" value="${escapeHtml(message.id)}"><input type="hidden" name="gmailThreadId" value="${escapeHtml(message.threadId)}"><button class="button" type="submit" ${view.draftTestReady ? '' : 'disabled aria-disabled="true"'}>テスト下書きを作成</button></form><form method="post" action="/setup/test-run"><input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}"><input type="hidden" name="googleConnectionId" value="${escapeHtml(view.selectedConnectionId ?? '')}"><input type="hidden" name="gmailMessageId" value="${escapeHtml(message.id)}"><input type="hidden" name="gmailThreadId" value="${escapeHtml(message.threadId)}"><button class="button secondary" type="submit" ${view.draftCreationReady ? '' : 'disabled aria-disabled="true"'}>AI解析・下書き作成</button></form></div></td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  }
  return `<section class="panel" aria-labelledby="inbox-heading" style="margin-top:24px"><div class="panel-heading"><div><h2 id="inbox-heading">最近の受信メール</h2><span class="muted">「テスト下書きを作成」は固定文面の返信下書きだけを作成します。送信やAI解析は行いません。</span></div></div>${picker}${result}</section>`;
}

function renderGmailInboxError(errorCode: string): string {
  const code = `（${escapeHtml(errorCode)}）`;
  if (errorCode === 'RATE_LIMITED') {
    return `Gmailの取得が一時的なレート制限に達しました${code}。数分待ってから再試行してください。権限の再登録は不要です。`;
  }
  if (errorCode === 'AUTHENTICATION_REQUIRED' || errorCode === 'PERMISSION_DENIED') {
    return `Gmailの取得に失敗しました${code}。Gmailの読み取り権限を再登録してから再試行してください。`;
  }
  if (errorCode === 'TEMPORARY_UNAVAILABLE') {
    return `Gmailを一時的に利用できません${code}。少し待ってから再試行してください。`;
  }
  return `Gmailの取得に失敗しました${code}。時間をおいて再試行してください。`;
}

function renderDraftTestResult(view: SetupView): string {
  if (view.draftTestErrorCode) {
    return `<p class="empty" role="alert">Gmail下書きテストに失敗しました（${escapeHtml(view.draftTestErrorCode)}）。Gmailの読み取り・下書き権限とAPIの状態を確認して、再試行してください。</p>`;
  }
  if (!view.draftTestResult) return '';
  const result = view.draftTestResult.reused
    ? '同じメールの既存テスト下書きを確認しました。'
    : 'Gmailにテスト下書きを作成しました。';
  return `<p class="notice" role="status">${result} Draft ID: <span class="mono">${escapeHtml(view.draftTestResult.draftId)}</span>（送信はしていません）</p>`;
}

function renderReplySettings(
  view: SetupView,
  connections: readonly GoogleConnectionSummary[],
): string {
  const settings = view.replySettings;
  if (!settings) {
    return '<section class="panel" style="margin-top:24px"><h2>返信下書き設定</h2><p class="empty">先にGoogleアカウントを登録してください。</p></section>';
  }
  const connection = connections.find((candidate) => candidate.id === settings.googleConnectionId);
  const hasComposePermission = connection?.grantedScopes.includes(gmailComposeScope) ?? false;
  return `<section class="panel" aria-labelledby="reply-settings-heading" style="margin-top:24px">
    <div class="panel-heading"><div><h2 id="reply-settings-heading">返信下書き設定</h2><span class="muted">${escapeHtml(connection?.email ?? settings.googleConnectionId)} のGmail下書きに使用します。</span></div></div>
    ${hasComposePermission ? '' : '<p class="empty">Gmail下書き権限がありません。上の「Gmail 下書き」から権限を登録してください。</p>'}
    <form class="form-grid" method="post" action="/setup/reply-settings">
      <input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}">
      <input type="hidden" name="googleConnectionId" value="${escapeHtml(settings.googleConnectionId)}">
      <label>あなたの名前<input name="userName" maxlength="100" required autocomplete="name" value="${escapeHtml(settings.userName)}" placeholder="例: 菅原祐介"></label>
      <label>自動作成の信頼度しきい値<input name="draftConfidenceThreshold" type="number" min="0" max="1" step="0.05" required value="${escapeHtml(String(settings.draftConfidenceThreshold))}"></label>
      <label class="full">メール署名<textarea name="emailSignature" maxlength="2000" rows="4" placeholder="例: 菅原祐介">${escapeHtml(settings.emailSignature)}</textarea></label>
      <label class="full"><input name="createDrafts" type="checkbox" value="true" ${settings.createDrafts ? 'checked' : ''}> 返信が必要で安全条件を満たすメールにGmail下書きを作成する</label>
      <div class="full"><button class="button" type="submit">返信設定を保存</button></div>
    </form>
  </section>`;
}

function renderScheduledPoll(
  view: SetupView,
  connections: readonly GoogleConnectionSummary[],
): string {
  const disabled = !view.scheduledPollReady || connections.length === 0;
  return `<section class="panel" aria-labelledby="scheduled-poll-heading" style="margin-top:24px">
    <div class="panel-heading"><div><h2 id="scheduled-poll-heading">定期実行</h2><span class="muted">定期実行と同じ条件で、下書き作成が有効な全Googleアカウントの対象メールをキューへ投入します。</span></div></div>
    ${renderScheduledPollResult(view.scheduledPollResult, view.scheduledPollReset ?? false)}
    <form class="form-grid" method="post" action="/setup/scheduled-poll">
      <input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}">
      <div class="full" style="display:flex;flex-wrap:wrap;gap:10px"><button class="button" type="submit" ${disabled ? 'disabled aria-disabled="true"' : ''}>今すぐ定期実行を実行</button></div>
    </form>
    <form class="form-grid" method="post" action="/setup/scheduled-poll-reset">
      <input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken)}">
      <div class="full"><button class="button secondary" type="submit" ${disabled ? 'disabled aria-disabled="true"' : ''}>既存ジョブをリセットして再実行</button><p class="muted" style="margin:10px 0 0">過去の実行履歴は削除せず、同じメールを新しいジョブとして再解析します。Gmail下書きとカレンダー予定は重複作成しません。</p></div>
    </form>
  </section>`;
}

function renderScheduledPollResult(
  result: SetupView['scheduledPollResult'],
  reset: boolean,
): string {
  if (!result) return '';
  if (result.eligibleConnections === 0) {
    return '<p class="empty" role="status">対象となるアカウントがありません。Gmailの読み取り・下書き権限、返信下書き設定の「作成する」、あなたの名前を確認してください。</p>';
  }
  const summary = `${reset ? '既存ジョブをリセットして再実行しました。' : ''}対象アカウント: ${result.eligibleConnections}件、対象メール: ${result.messagesFound}件、キュー登録要求: ${result.jobRequestsAccepted}件`;
  if (result.messagesFound === 0) {
    return `<p class="notice" role="status">${summary}。検索条件に一致する新しいメールがないため、実行履歴に新しいジョブは表示されません。</p>`;
  }
  if (result.connectionFailures > 0 || result.enqueueFailures > 0) {
    return `<p class="empty" role="alert">${summary}。アカウント取得エラー: ${result.connectionFailures}件、キュー登録エラー: ${result.enqueueFailures}件。エラーがあるため、実行履歴に一部またはすべてのジョブが表示されない可能性があります。</p>`;
  }
  return `<p class="notice" role="status">${summary}。${reset ? '新しい実行履歴が作成されます。' : '同じメールは重複防止のため既存ジョブを再利用するので、新しい実行履歴が増えない場合があります。'}</p>`;
}

function authorizationCard(title: string, description: string, href: string): string {
  return `<article class="panel action-card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><a class="button" href="${escapeHtml(href)}">登録する</a></article>`;
}

function renderConnections(connections: readonly GoogleConnectionSummary[]): string {
  if (connections.length === 0) {
    return '<p class="empty">Googleアカウントはまだ登録されていません。</p>';
  }
  return `<ul class="connection-list">${connections
    .map((connection) => {
      const permissions = [
        connection.grantedScopes.includes(gmailReadonlyScope) ? '読取' : null,
        connection.grantedScopes.includes(gmailComposeScope) ? '下書き' : null,
        connection.grantedScopes.includes(calendarEventsScope) ? 'Calendar' : null,
      ].filter(Boolean);
      const status = connection.status === 'connected' ? '接続済み' : '再認証が必要';
      return `<li><div><strong>${escapeHtml(connection.email)}</strong><small class="mono">${escapeHtml(connection.id)}</small><small>権限: ${escapeHtml(permissions.join(' / ') || 'なし')}</small></div><span class="status ${connection.status === 'connected' ? 'completed' : 'failed'}">${status}</span></li>`;
    })
    .join('')}</ul>`;
}

function renderJob(job: SetupJobView): string {
  const runLink = job.latestRunId
    ? `<a class="text-link" href="/history/runs/${encodeURIComponent(job.latestRunId)}">Run詳細を見る</a>`
    : '<span class="muted">Workerの処理待ちです。少し待って更新してください。</span>';
  return `<section class="panel job-result" aria-labelledby="job-result-heading"><div class="panel-heading" style="padding:0 0 14px;margin-bottom:14px"><h2 id="job-result-heading">テスト実行結果</h2><a class="button secondary" href="/setup?jobId=${encodeURIComponent(job.id)}">更新</a></div><dl><dt>Job ID</dt><dd class="mono">${escapeHtml(job.id)}</dd><dt>状態</dt><dd>${escapeHtml(job.status)}</dd><dt>エラーコード</dt><dd>${escapeHtml(job.errorCode ?? '—')}</dd><dt>Run</dt><dd>${runLink}</dd></dl></section>`;
}
