import type { toRunResponse } from './presenters';

type RunView = ReturnType<typeof toRunResponse>;

interface RunHistoryListView {
  readonly hasMore: boolean;
  readonly page: number;
  readonly runs: readonly RunView[];
}

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Asia/Tokyo',
});

export function renderRunHistoryList(view: RunHistoryListView): string {
  const rows = view.runs.length
    ? view.runs.map(renderRunRow).join('')
    : '<tr><td colspan="7" class="empty">実行履歴はまだありません。</td></tr>';
  const previous =
    view.page > 1
      ? `<a class="button secondary" href="/history?page=${view.page - 1}">前へ</a>`
      : '<span></span>';
  const next = view.hasMore
    ? `<a class="button secondary" href="/history?page=${view.page + 1}">次へ</a>`
    : '<span></span>';

  return renderWebPage(
    '実行履歴',
    `<main class="container">
      <header class="page-header">
        <div>
          <p class="eyebrow">AIAgents</p>
          <h1>実行履歴</h1>
          <p class="lead">Agentの実行状態と生成された外部リソースを確認できます。</p>
        </div>
        <a class="button" href="/history">更新</a>
      </header>
      <section class="panel table-panel" aria-labelledby="runs-heading">
        <div class="panel-heading">
          <h2 id="runs-heading">Runs</h2>
          <span class="muted">${view.runs.length}件表示 · ${view.page}ページ</span>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>状態</th><th>Agent</th><th>対象メール</th><th>結果</th><th>開始</th><th>所要時間</th><th>詳細</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
      <nav class="pagination" aria-label="ページ移動">${previous}<span>Page ${view.page}</span>${next}</nav>
    </main>`,
  );
}

export function renderRunHistoryDetail(run: RunView): string {
  const output = run.output;
  const steps = run.steps.length
    ? run.steps.map(renderStep).join('')
    : '<li class="empty">記録されたStepはありません。</li>';

  return renderWebPage(
    `Run ${run.id}`,
    `<main class="container">
      <nav class="breadcrumb"><a href="/history">実行履歴</a><span>/</span><span>Run詳細</span></nav>
      <header class="page-header detail-header">
        <div>
          <div class="title-line">${statusBadge(run.status)}<span class="mono">${escapeHtml(run.id)}</span></div>
          <h1>${escapeHtml(run.agentId)}</h1>
          <p class="lead">${formatDate(run.startedAt)} に開始 · ${escapeHtml(run.triggerType)}</p>
          ${run.emailSubject ? `<p class="lead">対象メール: ${escapeHtml(run.emailSubject)}</p>` : ''}
        </div>
        <a class="button" href="/history/runs/${encodeURIComponent(run.id)}">更新</a>
      </header>
      <section class="summary-grid" aria-label="実行概要">
        ${summaryCard('Job ID', run.jobId, true)}
        ${summaryCard('結果', output?.result ?? '—')}
        ${summaryCard('所要時間', formatDuration(run.startedAt, run.completedAt))}
        ${summaryCard('エラーコード', run.errorCode ?? '—', true)}
        ${summaryCard('Gmail Draft ID', output?.draftId ?? '—', true)}
        ${summaryCard('Calendar Event ID', output?.calendarEventId ?? '—', true)}
      </section>
      ${run.errorDetail ? `<section class="panel error-detail" aria-label="エラー詳細"><h2>エラー詳細</h2><p>${escapeHtml(run.errorDetail)}</p></section>` : ''}
      <section class="panel" aria-labelledby="steps-heading">
        <div class="panel-heading"><h2 id="steps-heading">Steps</h2><span class="muted">${run.steps.length}件</span></div>
        <ol class="timeline">${steps}</ol>
      </section>
    </main>`,
  );
}

function renderRunRow(run: RunView): string {
  return `<tr>
    <td>${statusBadge(run.status)}</td>
    <td><strong>${escapeHtml(run.agentId)}</strong><small class="mono">${escapeHtml(run.id)}</small></td>
    <td>${escapeHtml(run.emailSubject ?? '—')}</td>
    <td>${escapeHtml(run.output?.result ?? '—')}</td>
    <td>${formatDate(run.startedAt)}</td>
    <td>${escapeHtml(formatDuration(run.startedAt, run.completedAt))}</td>
    <td><a class="text-link" href="/history/runs/${encodeURIComponent(run.id)}">開く</a></td>
  </tr>`;
}

function renderStep(step: RunView['steps'][number]): string {
  const outputEntries = step.output ? Object.entries(step.output) : [];
  const output = outputEntries.length
    ? `<dl class="step-output">${outputEntries
        .map(
          ([key, value]) =>
            `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
        )
        .join('')}</dl>`
    : '';
  return `<li class="timeline-item">
    <div class="timeline-marker ${escapeHtml(step.status)}"></div>
    <div class="timeline-content">
      <div class="step-heading"><strong>${escapeHtml(step.stepName)}</strong>${statusBadge(step.status)}</div>
      <p class="muted">${formatDate(step.startedAt)} · ${escapeHtml(formatDuration(step.startedAt, step.completedAt))}</p>
      ${step.errorCode ? `<p class="error-code">${escapeHtml(step.errorCode)}</p>` : ''}
      ${output}
    </div>
  </li>`;
}

function summaryCard(label: string, value: string, mono = false): string {
  return `<article class="summary-card"><span>${escapeHtml(label)}</span><strong${mono ? ' class="mono"' : ''}>${escapeHtml(value)}</strong></article>`;
}

function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    completed: '完了',
    failed: '失敗',
    pending: '処理中',
    running: '実行中',
    succeeded: '成功',
  };
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(labels[status] ?? status)}</span>`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? escapeHtml(value)
    : `<time datetime="${escapeHtml(value)}">${escapeHtml(dateFormatter.format(parsed))}</time>`;
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '実行中';
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}秒`;
  return `${Math.floor(durationMs / 60_000)}分${Math.floor((durationMs % 60_000) / 1_000)}秒`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

export function renderWebPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · AIAgents</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a2f; --line:#26324f; --text:#eef3ff; --muted:#96a3bf; --accent:#7dd3fc; --green:#4ade80; --red:#fb7185; --amber:#fbbf24; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--text); background:radial-gradient(circle at 15% 0%,#172554 0,transparent 34rem),var(--bg); font:14px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:inherit; }
    .container { width:min(1180px,calc(100% - 32px)); margin:0 auto; padding:48px 0 72px; }
    .page-header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:28px; }
    .detail-header { align-items:center; }
    .eyebrow { margin:0 0 4px; color:var(--accent); font-size:12px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    h1,h2,p { margin-top:0; } h1 { margin-bottom:4px; font-size:clamp(28px,5vw,44px); line-height:1.15; } h2 { margin:0; font-size:18px; }
    .lead,.muted { color:var(--muted); } .lead { margin:0; }
    .panel,.summary-card { border:1px solid var(--line); border-radius:16px; background:rgba(18,26,47,.9); box-shadow:0 18px 50px rgba(0,0,0,.18); }
    .panel-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 20px; border-bottom:1px solid var(--line); }
    .table-scroll { overflow-x:auto; } table { width:100%; border-collapse:collapse; } th,td { padding:15px 20px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; } th { color:var(--muted); font-size:12px; letter-spacing:.04em; text-transform:uppercase; } tbody tr:last-child td { border-bottom:0; } tbody tr:hover { background:rgba(125,211,252,.04); }
    td small { display:block; max-width:210px; overflow:hidden; color:var(--muted); text-overflow:ellipsis; white-space:nowrap; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .status { display:inline-flex; align-items:center; min-width:58px; justify-content:center; padding:3px 9px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px; font-weight:700; }
    .status.completed,.status.succeeded { border-color:rgba(74,222,128,.35); color:var(--green); background:rgba(74,222,128,.08); }
    .status.failed { border-color:rgba(251,113,133,.35); color:var(--red); background:rgba(251,113,133,.08); }
    .status.running,.status.pending { border-color:rgba(251,191,36,.35); color:var(--amber); background:rgba(251,191,36,.08); }
    .button { display:inline-flex; min-height:40px; align-items:center; justify-content:center; padding:8px 15px; border:1px solid var(--accent); border-radius:10px; color:#082f49; background:var(--accent); font-weight:800; text-decoration:none; }
    .button.secondary { color:var(--text); border-color:var(--line); background:var(--panel); }
    .button[aria-disabled="true"] { cursor:not-allowed; opacity:.45; pointer-events:none; }
    .text-link,.breadcrumb a { color:var(--accent); font-weight:700; text-decoration:none; }
    .top-nav { display:flex; align-items:center; justify-content:space-between; gap:20px; width:min(1180px,calc(100% - 32px)); margin:0 auto; padding:18px 0 0; }
    .top-nav strong { letter-spacing:.04em; } .top-nav div { display:flex; gap:16px; } .top-nav a { color:var(--muted); font-weight:700; text-decoration:none; } .top-nav a:hover { color:var(--accent); }
    .pagination { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:20px; margin-top:20px; color:var(--muted); } .pagination > :last-child { justify-self:end; }
    .breadcrumb { display:flex; gap:10px; margin-bottom:24px; color:var(--muted); }
    .title-line { display:flex; align-items:center; gap:12px; margin-bottom:10px; color:var(--muted); }
    .summary-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:24px; }
    .summary-card { min-height:112px; padding:18px; } .summary-card span { display:block; margin-bottom:10px; color:var(--muted); font-size:12px; } .summary-card strong { display:block; }
    .timeline { margin:0; padding:20px; list-style:none; } .timeline-item { position:relative; display:grid; grid-template-columns:18px 1fr; gap:14px; padding-bottom:24px; } .timeline-item:not(:last-child)::before { position:absolute; top:17px; bottom:0; left:6px; width:2px; background:var(--line); content:""; }
    .timeline-marker { z-index:1; width:14px; height:14px; margin-top:5px; border:3px solid var(--panel); border-radius:50%; background:var(--muted); box-shadow:0 0 0 1px var(--line); } .timeline-marker.succeeded { background:var(--green); } .timeline-marker.failed { background:var(--red); } .timeline-marker.pending { background:var(--amber); }
    .step-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; } .step-heading + p { margin:4px 0 0; }
    .error-code { color:var(--red); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .step-output { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 16px; margin:12px 0 0; padding:12px; border-radius:10px; background:rgba(11,16,32,.6); } .step-output div { min-width:0; } dt { color:var(--muted); font-size:11px; } dd { margin:0; overflow-wrap:anywhere; }
    .empty { padding:36px; color:var(--muted); text-align:center; }
    .error-detail { margin-bottom:24px; padding:18px 20px; border-color:rgba(251,113,133,.35); }
    .error-detail h2 { color:var(--red); } .error-detail p { margin:8px 0 0; overflow-wrap:anywhere; }
    .action-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:24px; }
    .action-card { display:flex; min-height:190px; flex-direction:column; align-items:flex-start; padding:20px; } .action-card p { flex:1; color:var(--muted); }
    .notice { margin-bottom:20px; padding:12px 16px; border:1px solid rgba(74,222,128,.35); border-radius:12px; color:var(--green); background:rgba(74,222,128,.08); }
    .form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; padding:20px; } .form-grid .full { grid-column:1/-1; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:700; } input,select,textarea { width:100%; min-height:42px; padding:9px 11px; border:1px solid var(--line); border-radius:9px; color:var(--text); background:var(--bg); font:inherit; } textarea { resize:vertical; } input[type="checkbox"] { width:auto; min-height:0; padding:0; } input:focus,select:focus,textarea:focus { border-color:var(--accent); outline:2px solid rgba(125,211,252,.2); }
    .connection-list { display:grid; gap:10px; margin:0; padding:20px; list-style:none; } .connection-list li { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:13px; border:1px solid var(--line); border-radius:10px; } .connection-list small { display:block; color:var(--muted); }
    .job-result { margin-bottom:24px; padding:20px; } .job-result dl { display:grid; grid-template-columns:auto 1fr; gap:6px 16px; margin:0; } .job-result dt { color:var(--muted); } .job-result dd { margin:0; }
    @media (max-width:760px) { .container,.top-nav { width:min(100% - 20px,1180px); } .container { padding-top:28px; } .page-header { align-items:stretch; flex-direction:column; } .page-header .button { align-self:flex-start; } .summary-grid,.action-grid,.form-grid { grid-template-columns:1fr; } .form-grid .full { grid-column:auto; } th,td { padding:12px; } .step-output { grid-template-columns:1fr; } }
  </style>
</head>
<body><nav class="top-nav" aria-label="メインナビゲーション"><strong>AIAgents</strong><div><a href="/setup">セットアップ</a><a href="/history">実行履歴</a></div></nav>${content}</body>
</html>`;
}
