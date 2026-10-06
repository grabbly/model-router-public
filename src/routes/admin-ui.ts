/**
 * HTML UI generator for Admin Dashboard and Login pages.
 * Fully self-contained: inline CSS and JS, zero external dependencies, system font stack.
 */

export function render429Page(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Слишком много попыток · model-router</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --danger: #ef4444;
      --border: #23314d;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 16px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    }
    h1 { font-size: 20px; margin: 0 0 12px; color: var(--danger); }
    p { color: var(--text-muted); font-size: 14px; line-height: 1.5; margin: 0 0 20px; }
    a { color: #3b82f6; text-decoration: none; font-size: 14px; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>429 · Слишком много попыток</h1>
    <p>Превышен лимит неудачных попыток входа (максимум 5 попыток за 10 минут). Пожалуйста, подождите 10 минут перед следующей попыткой.</p>
    <a href="/admin/login">Вернуться на страницу входа</a>
  </div>
</body>
</html>`;
}

export function renderLoginPage(hasError: boolean): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Вход · model-router</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --border: #23314d;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.12);
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --text-muted: #64748b;
        --primary: #2563eb;
        --primary-hover: #1d4ed8;
        --danger: #dc2626;
        --danger-bg: #fee2e2;
      }
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 16px;
    }
    .login-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2);
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
    }
    .sub {
      color: var(--text-muted);
      font-size: 13px;
    }
    .alert-error {
      background: var(--danger-bg);
      border: 1px solid var(--danger);
      color: var(--danger);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
      text-align: center;
      font-weight: 500;
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    input:focus {
      border-color: var(--primary);
    }
    input[readonly] {
      opacity: 0.75;
      background: rgba(125, 125, 125, 0.08);
      cursor: default;
    }
    button {
      width: 100%;
      padding: 11px;
      border: none;
      border-radius: 8px;
      background: var(--primary);
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
      margin-top: 8px;
    }
    button:hover {
      background: var(--primary-hover);
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="header">
      <div class="logo">model-router</div>
      <div class="sub">Панель управления и мониторинг</div>
    </div>

    ${hasError ? '<div class="alert-error">Неверный пароль</div>' : ''}

    <form method="post" action="/admin/login">
      <div class="form-group">
        <label for="username">Имя пользователя</label>
        <input id="username" name="username" autocomplete="username" value="admin" readonly>
      </div>

      <div class="form-group">
        <label for="password">Пароль</label>
        <input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
      </div>

      <button type="submit">Войти</button>
    </form>
  </div>
</body>
</html>`;
}

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>model-router · мониторинг</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-hover: #f1f5f9;
      --border: #e2e8f0;
      --border-dark: #cbd5e1;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #16a34a;
      --warning: #d97706;
      --danger: #dc2626;
      --badge-bg: #f1f5f9;
      --drawer-bg: #ffffff;
      --code-bg: #f1f5f9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0f19;
        --surface: #131b2e;
        --surface-hover: #1e293b;
        --border: #23314d;
        --border-dark: #334155;
        --text: #f1f5f9;
        --text-muted: #94a3b8;
        --primary: #3b82f6;
        --primary-hover: #60a5fa;
        --success: #22c55e;
        --warning: #f59e0b;
        --danger: #ef4444;
        --badge-bg: #1e293b;
        --drawer-bg: #131b2e;
        --code-bg: #0b0f19;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }
    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 16px 20px 48px;
    }
    /* Header */
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand h1 {
      font-size: 17px;
      font-weight: 700;
      margin: 0;
      letter-spacing: -0.01em;
    }
    .brand .tag {
      font-size: 11px;
      color: var(--text-muted);
      background: var(--badge-bg);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .btn-group {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface);
    }
    .btn-group button {
      background: transparent;
      border: none;
      border-right: 1px solid var(--border);
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
    }
    .btn-group button:last-child { border-right: none; }
    .btn-group button.active {
      background: var(--primary);
      color: #fff;
    }
    .custom-range {
      display: none;
      align-items: center;
      gap: 6px;
    }
    .custom-range.show { display: inline-flex; }
    select, input[type="text"], input[type="datetime-local"] {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      outline: none;
    }
    select:focus, input:focus { border-color: var(--primary); }
    .refresh-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
    }
    .live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      display: inline-block;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(0.9); }
      100% { opacity: 1; transform: scale(1); }
    }
    .btn {
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      transition: background 0.1s;
    }
    .btn:hover { background: var(--surface-hover); }
    .btn-primary {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    .btn-primary:hover { background: var(--primary-hover); }

    /* KPI Row */
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .kpi-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .kpi-val {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-success { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
    .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
    .badge-neutral { background: var(--badge-bg); color: var(--text-muted); border: 1px solid var(--border); }

    /* Charts Grid */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .chart-container {
      position: relative;
      width: 100%;
    }
    .chart-svg {
      width: 100%;
      height: 220px;
      display: block;
      overflow: visible;
    }
    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 10px;
      font-size: 11px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      color: var(--text-muted);
      user-select: none;
    }
    .legend-item.dimmed { opacity: 0.35; }
    .legend-color {
      width: 10px;
      height: 10px;
      border-radius: 3px;
    }
    .tooltip {
      position: absolute;
      display: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 11px;
      pointer-events: none;
      box-shadow: 0 4px 15px rgba(0,0,0,0.25);
      z-index: 10;
      min-width: 150px;
    }

    /* Sub-charts grid */
    .sub-charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .bar-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .bar-label {
      width: 120px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-muted);
    }
    .bar-track {
      flex: 1;
      height: 8px;
      background: var(--badge-bg);
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 4px;
    }
    .bar-val {
      min-width: 36px;
      text-align: right;
      font-weight: 600;
    }

    /* Tables */
    .table-scroll {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 12px;
    }
    th {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      white-space: nowrap;
    }
    td {
      padding: 10px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      vertical-align: middle;
    }
    tr.clickable {
      cursor: pointer;
    }
    tr.clickable:hover {
      background: var(--surface-hover);
    }
    tr.expanded-row td {
      background: var(--code-bg);
      white-space: normal;
      padding: 12px;
    }
    .json-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 0;
    }

    /* Filters Row in Requests Table */
    .filters-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .filters-grid input, .filters-grid select {
      flex: 1 1 120px;
      font-size: 12px;
    }

    /* Client Drawer */
    .drawer-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 100;
      display: none;
      backdrop-filter: blur(2px);
    }
    .drawer-overlay.open { display: block; }
    .drawer {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 480px;
      max-width: 90vw;
      background: var(--drawer-bg);
      border-left: 1px solid var(--border);
      z-index: 101;
      padding: 24px;
      overflow-y: auto;
      box-shadow: -10px 0 30px rgba(0,0,0,0.3);
      transform: translateX(100%);
      transition: transform 0.2s ease-out;
    }
    .drawer.open { transform: translateX(0); }
    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .drawer-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
    }
    .drawer-close {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: var(--text-muted);
    }
    .drawer-section {
      margin-bottom: 20px;
    }
    .drawer-section h3 {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      margin: 0 0 8px;
    }
    .drawer-list {
      list-style: none;
      padding: 0;
      margin: 0;
      font-size: 12px;
    }
    .drawer-list li {
      padding: 5px 0;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
    }
    .drawer-list li:last-child { border-bottom: none; }

    /* Alert Banner */
    #api-error-banner {
      display: none;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--danger);
      color: var(--danger);
      padding: 10px 14px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    #api-error-banner a {
      color: var(--danger);
      font-weight: 700;
      text-decoration: underline;
    }
    .form-group-field {
      margin-bottom: 12px;
    }
    .form-group-field label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .form-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .form-grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }
    .tenant-drawer-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
    }
    .tenant-drawer-box h4 {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .token-display-box {
      display: none;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid var(--warning);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div id="api-error-banner"></div>

    <header>
      <div class="brand">
        <h1>model-router · мониторинг</h1>
        <span class="tag">OpenAI Router</span>
      </div>

      <div class="controls">
        <div class="btn-group" id="range-presets">
          <button data-range="1h">1 ч</button>
          <button data-range="24h" class="active">24 ч</button>
          <button data-range="7d">7 дн</button>
          <button data-range="30d">30 дн</button>
          <button data-range="custom">Свой</button>
        </div>

        <div class="custom-range" id="custom-inputs">
          <input type="datetime-local" id="custom-from">
          <span>—</span>
          <input type="datetime-local" id="custom-to">
          <button class="btn btn-primary" id="btn-apply-custom">OK</button>
        </div>

        <select id="client-filter-top">
          <option value="">Все клиенты</option>
        </select>

        <label class="refresh-toggle">
          <input type="checkbox" id="auto-refresh" checked>
          <span class="live-dot" id="live-indicator"></span>
          <span>Авто (30с)</span>
        </label>

        <form method="post" action="/admin/logout" style="margin: 0;">
          <button class="btn" type="submit">Выйти</button>
        </form>
      </div>
    </header>

    <div style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
      <button class="btn btn-primary" id="btn-tab-monitoring" onclick="switchMainTab('monitoring')">Мониторинг</button>
      <button class="btn" id="btn-tab-tenants" onclick="switchMainTab('tenants')">Клиенты и лимиты</button>
      <button class="btn" id="btn-tab-notifications" onclick="switchMainTab('notifications')">Уведомления</button>
      <button class="btn" id="btn-tab-catalog" onclick="switchMainTab('catalog')">Каталог моделей</button>
      <button class="btn" id="btn-tab-watch" onclick="switchMainTab('watch')">Вотчер</button>
    </div>

    <!-- View: Monitoring -->
    <div id="view-monitoring">
      <!-- MiniMax Provider Quota Overview -->
    <div class="card" id="provider-quota-card" style="margin-bottom: 20px;">
      <div class="card-title">
        <span>Квота MiniMax (Coding Plan)</span>
        <span id="provider-freshness-badge" class="badge badge-neutral">—</span>
      </div>
      <div id="provider-quota-content">
        <div style="color: var(--text-muted); font-size: 12px;">Загрузка данных о квоте...</div>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-title">Запросов</div>
        <div class="kpi-val" id="kpi-requests">—</div>
        <div class="kpi-sub" id="kpi-requests-sub">всего за период</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Ошибок</div>
        <div class="kpi-val" id="kpi-errors">—</div>
        <div class="kpi-sub" id="kpi-errors-sub">доля от всех запросов</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Токены (вход / выход)</div>
        <div class="kpi-val" id="kpi-tokens">—</div>
        <div class="kpi-sub" id="kpi-tokens-sub">prompt / completion</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Задержка (средняя / p95)</div>
        <div class="kpi-val" id="kpi-latency">—</div>
        <div class="kpi-sub" id="kpi-latency-sub">время ответа клиенту</div>
      </div>
    </div>

    <!-- Chart: Requests over time -->
    <div class="card">
      <div class="card-title">
        <span>Запросы по времени</span>
        <span style="font-size: 11px; color: var(--text-muted);" id="chart-bucket-label">шаг: час</span>
      </div>
      <div class="chart-container">
        <svg class="chart-svg" id="chart-svg" viewBox="0 0 1000 220" preserveAspectRatio="none">
          <g id="chart-grid"></g>
          <g id="chart-bars"></g>
          <g id="chart-axes"></g>
        </svg>
        <div class="tooltip" id="chart-tooltip"></div>
      </div>
      <div class="chart-legend" id="chart-legend"></div>
    </div>

    <!-- Sub-charts -->
    <div class="sub-charts">
      <div class="card">
        <div class="card-title">По тирам (Logical)</div>
        <div id="tiers-chart">
          <div style="color: var(--text-muted); font-size: 12px;">Загрузка...</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">По моделям (Backend)</div>
        <div id="backends-chart">
          <div style="color: var(--text-muted); font-size: 12px;">Загрузка...</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Статусы ответов</div>
        <div id="status-chart">
          <div style="color: var(--text-muted); font-size: 12px;">Загрузка...</div>
        </div>
      </div>
    </div>

    <!-- Clients Table -->
    <div class="card">
      <div class="card-title">
        <span>Клиенты</span>
        <span style="font-size: 11px; color: var(--text-muted);">кликните на строку для фильтрации и деталей</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Ключ</th>
              <th>Тип входа</th>
              <th>Приложения / Агенты</th>
              <th>Последний запрос</th>
              <th>24ч (Запросы / Токены / Ошибки)</th>
              <th>Без меты</th>
              <th>Лимит MiniMax (Сутки / Час)</th>
            </tr>
          </thead>
          <tbody id="clients-table-body">
            <tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Загрузка клиентов...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Requests Table -->
    <div class="card">
      <div class="card-title">
        <span>Список запросов</span>
        <button class="btn" id="btn-reset-filters" style="font-size: 11px; padding: 3px 8px;">Сбросить фильтры</button>
      </div>

      <div class="filters-grid">
        <select id="req-filter-tenant"><option value="">Все клиенты</option></select>
        <input type="text" id="req-filter-app" placeholder="Приложение (app)...">
        <input type="text" id="req-filter-agent" placeholder="Агент (agent)...">
        <input type="text" id="req-filter-session" placeholder="Поиск по session...">
        <select id="req-filter-tier">
          <option value="">Все тиры</option>
          <option value="text-high">text-high</option>
          <option value="text-high-think">text-high-think</option>
          <option value="text-low">text-low</option>
          <option value="text-summarize">text-summarize</option>
          <option value="text-uncensored-high">text-uncensored-high</option>
          <option value="text-uncensored-low">text-uncensored-low</option>
          <option value="vision-high">vision-high</option>
          <option value="vision-low">vision-low</option>
          <option value="vision-uncensored-high">vision-uncensored-high</option>
          <option value="vision-uncensored-low">vision-uncensored-low</option>
        </select>
        <input type="text" id="req-filter-backend" placeholder="Backend...">
        <select id="req-filter-status">
          <option value="">Все статусы</option>
          <option value="2xx">2xx (успех)</option>
          <option value="4xx">4xx (ошибки клиента)</option>
          <option value="5xx">5xx (ошибки сервера)</option>
        </select>
        <input type="text" id="req-filter-error" placeholder="Код ошибки...">
      </div>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Время</th>
              <th>Клиент</th>
              <th>App / Agent</th>
              <th>Session</th>
              <th>Тир → Backend</th>
              <th>Статус</th>
              <th>Токены (in/out)</th>
              <th>Задержка</th>
              <th>Флаги</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody id="requests-table-body">
            <tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Загрузка запросов...</td></tr>
          </tbody>
        </table>
      </div>

      <div style="text-align: center; margin-top: 14px;">
        <button class="btn btn-primary" id="btn-load-more" style="display: none;">Показать ещё</button>
      </div>
    </div>
    </div>
    <!-- End View: Monitoring -->

    <!-- View: Tenants & Limits -->
    <div id="view-tenants" style="display: none;">
      <div class="card">
        <div class="card-title">
          <span>Клиенты и лимиты</span>
          <button class="btn btn-primary" onclick="openTenantDrawer(null)">+ Новый клиент</button>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
          Управление реестром клиентов, токенами и лимитами (RPM, concurrent, dayRequests, Loop Guard, MiniMax).
          Нажмите на строку любого клиента для редактирования параметров.
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Имя</th>
                <th>Статус</th>
                <th>RPM</th>
                <th>Concurrent</th>
                <th>В сутки</th>
                <th>Loop (max/sec)</th>
                <th>MiniMax (день/час)</th>
                <th>Сегодня</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody id="tenants-table-body">
              <tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Загрузка клиентов...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <!-- End View: Tenants & Limits -->

    <!-- View: Notifications -->
    <div id="view-notifications" style="display: none;">
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-title">
          <span>Каналы уведомлений</span>
          <button class="btn btn-primary" id="btn-send-test-notify" onclick="handleSendTestNotification()">Отправить тестовое</button>
        </div>
        <div id="notify-test-result" style="display: none; margin-bottom: 14px; padding: 10px 12px; border-radius: 6px; font-size: 13px;"></div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <strong>Email (SMTP)</strong>
              <span id="notify-status-email" class="badge badge-neutral">—</span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); line-height: 1.5;">
              <div>Получатели: <span id="notify-recipients-email" style="font-family: monospace;">—</span></div>
            </div>
          </div>
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <strong>Telegram Bot</strong>
              <span id="notify-status-telegram" class="badge badge-neutral">—</span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); line-height: 1.5;">
              <div>Получатели: <span id="notify-recipients-telegram" style="font-family: monospace;">—</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Последние 50 доставок</span>
          <button class="btn" onclick="loadNotificationsView()">Обновить</button>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Клиент</th>
                <th>Тип события</th>
                <th>Канал</th>
                <th>Получатель</th>
                <th>Статус</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody id="notifications-table-body">
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Загрузка доставок...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <!-- End View: Notifications -->

    <!-- View: Catalog -->
    <div id="view-catalog" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2 style="font-size: 16px; margin: 0;">Каталог моделей</h2>
        <button class="btn btn-primary" id="btn-refresh-catalog" onclick="handleRefreshCatalog()">Обновить каталоги</button>
      </div>

      <div id="catalog-refresh-message" style="display: none; margin-bottom: 16px; font-size: 13px;"></div>

      <div class="card" style="margin-bottom: 24px;">
        <div class="card-title"><span>Правила</span></div>
        <div class="table-scroll">
          <table class="table" style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th>Маршрут</th>
                <th>Правило</th>
                <th>Выбрано сейчас</th>
              </tr>
            </thead>
            <tbody id="catalog-rules-table-body">
              <tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Загрузка правил...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div id="catalogs-container">
        <div style="color: var(--text-muted); font-size: 13px;">Загрузка данных каталога...</div>
      </div>
    </div>
    <!-- End View: Catalog -->

    <!-- View: Watcher -->
    <div id="view-watch" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2 style="font-size: 16px; margin: 0;">Ночной вотчер</h2>
        <div style="display: flex; gap: 8px;">
          <button class="btn" id="btn-watch-run" onclick="handleRunWatch(false)">Проверить сейчас</button>
          <button class="btn btn-primary" id="btn-watch-run-notify" onclick="handleRunWatch(true)">Проверить и отправить письмо</button>
        </div>
      </div>

      <div id="watch-run-message" style="display: none; margin-bottom: 16px; padding: 10px 12px; border-radius: 6px; font-size: 13px;"></div>

      <div style="display: grid; grid-template-columns: 360px 1fr; gap: 20px; align-items: start;">
        <!-- Left: Reports list -->
        <div class="card">
          <div class="card-title">
            <span>Отчёты вотчера</span>
            <button class="btn" onclick="loadWatchReportsList()">Обновить</button>
          </div>
          <div class="table-scroll" style="max-height: 600px; overflow-y: auto;">
            <table class="table" style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Уровень</th>
                  <th>Сигналы</th>
                </tr>
              </thead>
              <tbody id="watch-reports-table-body">
                <tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Загрузка отчётов...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Right: Report details -->
        <div class="card" id="watch-report-details-card">
          <div class="card-title">
            <span id="watch-report-title">Детали отчёта</span>
            <span id="watch-report-level-badge" class="badge badge-neutral">—</span>
          </div>
          <div id="watch-report-content">
            <div style="color: var(--text-muted); font-size: 13px;">Выберите отчёт из списка слева</div>
          </div>
        </div>
      </div>
    </div>
    <!-- End View: Watcher -->
  </div>

  <!-- Client Detail Drawer -->
  <div class="drawer-overlay" id="drawer-overlay"></div>
  <div class="drawer" id="client-drawer">
    <div class="drawer-header">
      <h2 id="drawer-tenant-title">Детали клиента</h2>
      <button class="drawer-close" id="drawer-close-btn">&times;</button>
    </div>

    <div class="drawer-section">
      <h3>Общие сведения</h3>
      <ul class="drawer-list" id="drawer-info-list"></ul>
    </div>

    <div class="drawer-section">
      <h3>Агенты (запросы)</h3>
      <ul class="drawer-list" id="drawer-agents-list"></ul>
    </div>

    <div class="drawer-section">
      <h3>IP адреса (до 10 последних)</h3>
      <ul class="drawer-list" id="drawer-ips-list"></ul>
    </div>

    <div class="drawer-section">
      <h3>User-Agent (до 5 последних)</h3>
      <ul class="drawer-list" id="drawer-useragents-list"></ul>
    </div>

    <div class="drawer-section">
      <h3>MiniMax Бюджет</h3>
      <div id="drawer-budget-details" style="font-size: 12px;"></div>
    </div>
  </div>

  <!-- Tenant Edit Drawer -->
  <div class="drawer" id="tenant-edit-drawer" style="width: 580px;">
    <div class="drawer-header">
      <h2 id="tenant-drawer-title">Настройка клиента</h2>
      <button class="drawer-close" onclick="closeTenantDrawer()">&times;</button>
    </div>

    <div id="tenant-form-error" class="alert-error" style="display: none; margin-bottom: 14px; text-align: left; white-space: pre-line;"></div>

    <div id="tenant-token-display-box" class="token-display-box">
      <div style="font-weight: 700; color: var(--warning); margin-bottom: 6px; font-size: 12px;">⚠️ Токен выпущен (показывается только один раз!):</div>
      <div style="display: flex; gap: 8px;">
        <input type="text" id="minted-token-val" readonly style="flex: 1; font-family: monospace; font-size: 11px;">
        <button type="button" class="btn btn-primary" id="btn-copy-minted-token" onclick="copyMintedToken()">Скопировать</button>
      </div>
    </div>

    <form id="tenant-edit-form" onsubmit="event.preventDefault(); saveTenantForm();">
      <div class="form-group-field">
        <label for="tenant-input-id">ID клиента (tenantId)</label>
        <input type="text" id="tenant-input-id" required pattern="^[A-Za-z0-9._-]{1,64}|\\*$" placeholder="например: alpha-service или *">
      </div>

      <div class="form-grid-2">
        <div class="form-group-field">
          <label for="tenant-input-name">Имя / Описание</label>
          <input type="text" id="tenant-input-name" placeholder="Название проекта">
        </div>
        <div class="form-group-field">
          <label for="tenant-input-status">Статус</label>
          <select id="tenant-input-status">
            <option value="active">active (активен)</option>
            <option value="disabled">disabled (отключен)</option>
          </select>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group-field">
          <label for="tenant-input-mode">Режим (Mode)</label>
          <select id="tenant-input-mode">
            <option value="shared">Общий (shared)</option>
            <option value="byok">Свои ключи (byok)</option>
          </select>
        </div>
        <div class="form-group-field" style="display: flex; align-items: center; margin-top: 22px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; text-transform: none; font-size: 13px;">
            <input type="checkbox" id="tenant-input-allow-shared-embeddings" style="width: auto;">
            Разрешить общие эмбеддинги
          </label>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group-field">
          <label for="tenant-input-overlay">Uncensored overlay</label>
          <select id="tenant-input-overlay">
            <option value="auto">auto</option>
            <option value="off">off</option>
          </select>
        </div>
        <div class="form-group-field">
          <label for="tenant-input-thinking-with-tools">Thinking with tools</label>
          <select id="tenant-input-thinking-with-tools">
            <option value="model-default">model default</option>
            <option value="off">off</option>
          </select>
        </div>
      </div>

      <div class="form-group-field">
        <label for="tenant-input-notes">Заметки / Примечания</label>
        <textarea id="tenant-input-notes" rows="2" style="width: 100%; box-sizing: border-box; background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 12px;"></textarea>
      </div>

      <!-- BYOK Section -->
      <div class="tenant-drawer-box" id="tenant-byok-box">
        <h4>Ключи провайдеров (BYOK)</h4>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
          Для режима «Свои ключи» укажите API-ключи провайдеров (Ollama Cloud, OpenAI). Запросы клиента будут использовать только их.
        </div>

        <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 12px; margin-bottom: 6px;">Ключ Ollama</div>
          <div id="tenant-ollama-key-status" style="margin-bottom: 10px; font-size: 12px; color: var(--text-muted);">
            Статус ключа: <span id="tenant-ollama-key-badge" class="badge badge-neutral">Не настроен</span>
            <span id="tenant-ollama-key-details" style="margin-left: 8px;"></span>
          </div>
          <div class="form-group-field">
            <label for="tenant-input-ollama-key">Новый ключ Ollama (write-only)</label>
            <div style="display: flex; gap: 8px;">
              <input type="password" id="tenant-input-ollama-key" placeholder="Вставьте ключ для сохранения" autocomplete="off" style="flex: 1;">
              <button type="button" class="btn btn-primary" id="btn-save-ollama-key" onclick="handleSaveOllamaKey()">Проверить и сохранить</button>
              <button type="button" class="btn btn-danger" id="btn-delete-ollama-key" style="display: none;" onclick="handleDeleteOllamaKey()">Удалить ключ</button>
            </div>
            <div id="tenant-ollama-key-msg" style="display: none; font-size: 12px; margin-top: 6px;"></div>
          </div>
        </div>

        <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 12px; margin-bottom: 6px;">Ключ OpenAI</div>
          <div id="tenant-openai-key-status" style="margin-bottom: 10px; font-size: 12px; color: var(--text-muted);">
            Статус ключа: <span id="tenant-openai-key-badge" class="badge badge-neutral">Не настроен</span>
            <span id="tenant-openai-key-details" style="margin-left: 8px;"></span>
          </div>
          <div class="form-group-field">
            <label for="tenant-input-openai-key">Новый ключ OpenAI (write-only)</label>
            <div style="display: flex; gap: 8px;">
              <input type="password" id="tenant-input-openai-key" placeholder="Вставьте ключ для сохранения" autocomplete="off" style="flex: 1;">
              <button type="button" class="btn btn-primary" id="btn-save-openai-key" onclick="handleSaveOpenaiKey()">Проверить и сохранить</button>
              <button type="button" class="btn btn-danger" id="btn-delete-openai-key" style="display: none;" onclick="handleDeleteOpenaiKey()">Удалить ключ</button>
            </div>
            <div id="tenant-openai-key-msg" style="display: none; font-size: 12px; margin-top: 6px;"></div>
          </div>
        </div>

        <div class="form-group-field" style="margin-bottom: 14px;">
          <label for="tenant-input-provider-order">Порядок провайдеров</label>
          <select id="tenant-input-provider-order" style="width: 100%; box-sizing: border-box; background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 12px;">
            <option value="ollama-cloud,openai">Ollama Cloud → OpenAI (по умолчанию)</option>
            <option value="openai,ollama-cloud">OpenAI → Ollama Cloud</option>
          </select>
        </div>

        <div style="margin-top: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <strong style="font-size: 12px;">Модели клиента</strong>
            <button type="button" class="btn" style="padding: 2px 8px; font-size: 11px;" onclick="loadTenantPools()">Обновить модели</button>
          </div>
          <div class="table-scroll" style="max-height: 200px;">
            <table style="width: 100%; font-size: 11px;">
              <thead>
                <tr>
                  <th>Маршрут</th>
                  <th>Модель</th>
                  <th>Правило</th>
                  <th>Допуск</th>
                  <th>Охлаждение</th>
                </tr>
              </thead>
              <tbody id="tenant-pools-table-body">
                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Сохраните клиента для просмотра моделей</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="form-group-field" style="margin-top: 14px;">
          <label for="tenant-input-pools-json">Переопределить пулы (JSON)</label>
          <textarea id="tenant-input-pools-json" rows="3" placeholder='{"text-high": [...]}' style="width: 100%; box-sizing: border-box; background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 11px; font-family: monospace;"></textarea>
        </div>
      </div>

      <!-- Rate Limits -->
      <div class="tenant-drawer-box">
        <h4>Лимиты запросов (Rate limits) <span style="font-size: 10px; font-weight: normal; color: var(--text-muted);">пусто = наследовать</span></h4>
        <div class="form-grid-3">
          <div class="form-group-field">
            <label for="tenant-input-rate-rpm">RPM (в минуту)</label>
            <input type="number" id="tenant-input-rate-rpm" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-rate-concurrent">Concurrent (одновр.)</label>
            <input type="number" id="tenant-input-rate-concurrent" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-rate-day">Запросов в день</label>
            <input type="number" id="tenant-input-rate-day" min="0" placeholder="наслед.">
          </div>
        </div>
      </div>

      <!-- Loop Guard Limits -->
      <div class="tenant-drawer-box">
        <h4>Защита от циклов (Loop Guard) <span style="font-size: 10px; font-weight: normal; color: var(--text-muted);">пусто = наследовать</span></h4>
        <div class="form-group-field">
          <label for="tenant-input-loop-mode">Режим (Mode)</label>
          <select id="tenant-input-loop-mode">
            <option value="">Наследовать из шаблона / env</option>
            <option value="enforce">enforce (блокировать)</option>
            <option value="dry-run">dry-run (только логи)</option>
            <option value="off">off (отключен)</option>
          </select>
        </div>
        <div class="form-grid-3">
          <div class="form-group-field">
            <label for="tenant-input-loop-maxReq">Max Req</label>
            <input type="number" id="tenant-input-loop-maxReq" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-loop-reqWindowSec">Req Window (сек)</label>
            <input type="number" id="tenant-input-loop-reqWindowSec" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-loop-maxTokens">Max Tokens</label>
            <input type="number" id="tenant-input-loop-maxTokens" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-loop-tokenWindowSec">Token Window (сек)</label>
            <input type="number" id="tenant-input-loop-tokenWindowSec" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-loop-maxRepeat">Max Repeat</label>
            <input type="number" id="tenant-input-loop-maxRepeat" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-loop-blockSec">Block (сек)</label>
            <input type="number" id="tenant-input-loop-blockSec" min="0" placeholder="наслед.">
          </div>
        </div>
      </div>

      <!-- MiniMax Budget Limits -->
      <div class="tenant-drawer-box">
        <h4>Лимиты MiniMax <span style="font-size: 10px; font-weight: normal; color: var(--text-muted);">пусто = наследовать</span></h4>
        <div class="form-grid-2">
          <div class="form-group-field">
            <label for="tenant-input-minimax-day">Сутки (токенов)</label>
            <input type="number" id="tenant-input-minimax-day" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-minimax-hour">Час (токенов)</label>
            <input type="number" id="tenant-input-minimax-hour" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-minimax-user-day">Пользователь: сутки</label>
            <input type="number" id="tenant-input-minimax-user-day" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-minimax-user-hour">Пользователь: час</label>
            <input type="number" id="tenant-input-minimax-user-hour" min="0" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-minimax-dayShare">QuotaMax dayShare (0..1)</label>
            <input type="number" id="tenant-input-minimax-dayShare" step="0.01" min="0" max="1" placeholder="наслед.">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-minimax-hourShare">QuotaMax hourShare (0..1)</label>
            <input type="number" id="tenant-input-minimax-hourShare" step="0.01" min="0" max="1" placeholder="наслед.">
          </div>
        </div>
      </div>

      <!-- Notifications -->
      <div class="tenant-drawer-box">
        <h4>Уведомления (Phase 2)</h4>
        <div class="form-group-field">
          <label for="tenant-input-notify-email">Email адреса (через запятую)</label>
          <input type="text" id="tenant-input-notify-email" placeholder="dev@example.com, alert@example.com">
        </div>
        <div class="form-grid-2">
          <div class="form-group-field">
            <label for="tenant-input-notify-telegram">Telegram Chat IDs (через запятую)</label>
            <input type="text" id="tenant-input-notify-telegram" placeholder="12345678, -10012345678">
          </div>
          <div class="form-group-field">
            <label for="tenant-input-notify-lang">Язык уведомлений</label>
            <select id="tenant-input-notify-lang">
              <option value="">Наследовать</option>
              <option value="ru">Русский (ru)</option>
              <option value="en">English (en)</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Additional JSON: limits.agents -->
      <div class="tenant-drawer-box">
        <h4>Дополнительно (JSON для limits.agents)</h4>
        <textarea id="tenant-input-agents-json" rows="3" placeholder='{"agent-worker": {"rate": {"rpm": 10}}}' style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 11px; background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 10px;"></textarea>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px;">
        <button type="submit" class="btn btn-primary" id="btn-save-tenant">Сохранить</button>
        <button type="button" class="btn" id="btn-mint-token" onclick="mintCurrentTenantToken(false)">Выпустить токен</button>
        <button type="button" class="btn" id="btn-rotate-token" onclick="mintCurrentTenantToken(true)">Перевыпустить (отозвать старый)</button>
        <button type="button" class="btn" id="btn-unblock-tenant" onclick="unblockCurrentTenant()">Снять блокировку</button>
        <button type="button" class="btn" id="btn-delete-tenant" style="color: var(--danger); border-color: var(--danger);" onclick="deleteCurrentTenant()">Удалить</button>
      </div>
    </form>
  </div>

  <script>
    // State
    const state = {
      range: '24h',
      from: null,
      to: null,
      tenant: '',
      app: '',
      agent: '',
      session: '',
      tier: '',
      backend: '',
      status: '',
      errorCode: '',
      nextBefore: null,
      clients: [],
      hiddenTenants: new Set(),
      isAutoRefreshing: true,
      refreshInterval: null
    };

    const PALETTE = [
      '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
      '#06b6d4', '#f97316', '#6366f1', '#14b8a6', '#84cc16'
    ];

    function getTenantColor(tenant, index) {
      let hash = 0;
      for (let i = 0; i < tenant.length; i++) {
        hash = tenant.charCodeAt(i) + ((hash << 5) - hash);
      }
      return PALETTE[Math.abs(hash) % PALETTE.length];
    }

    function formatNumber(n) {
      if (n === null || n === undefined || isNaN(n)) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
      return String(n);
    }

    function formatBytesOrChars(n) {
      if (!n) return '0';
      return formatNumber(n);
    }

    function formatMs(ms) {
      if (ms === null || ms === undefined || isNaN(ms)) return '0 мс';
      if (ms >= 1000) return (ms / 1000).toFixed(2) + ' с';
      return ms + ' мс';
    }

    function formatDateLocal(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, '0');
      return \`\${pad(d.getDate())}.\${pad(d.getMonth() + 1)} \${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\`;
    }

    function getRangeDates() {
      const now = new Date();
      let fromDate;
      if (state.range === '1h') {
        fromDate = new Date(now.getTime() - 3600 * 1000);
      } else if (state.range === '24h') {
        fromDate = new Date(now.getTime() - 24 * 3600 * 1000);
      } else if (state.range === '7d') {
        fromDate = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      } else if (state.range === '30d') {
        fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      } else if (state.range === 'custom') {
        return {
          from: state.from ? new Date(state.from).toISOString() : new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
          to: state.to ? new Date(state.to).toISOString() : now.toISOString()
        };
      }
      return { from: fromDate.toISOString(), to: now.toISOString() };
    }

    function updateUrlParams() {
      const p = new URLSearchParams();
      if (state.range) p.set('range', state.range);
      if (state.range === 'custom') {
        if (state.from) p.set('from', state.from);
        if (state.to) p.set('to', state.to);
      }
      if (state.tenant) p.set('tenant', state.tenant);
      if (state.app) p.set('app', state.app);
      if (state.agent) p.set('agent', state.agent);
      if (state.session) p.set('session', state.session);
      if (state.tier) p.set('tier', state.tier);
      if (state.backend) p.set('backend', state.backend);
      if (state.status) p.set('status', state.status);
      if (state.errorCode) p.set('errorCode', state.errorCode);
      window.history.replaceState(null, '', '?' + p.toString());
    }

    function parseUrlParams() {
      const p = new URLSearchParams(window.location.search);
      if (p.has('range')) state.range = p.get('range');
      if (p.has('from')) state.from = p.get('from');
      if (p.has('to')) state.to = p.get('to');
      if (p.has('tenant')) state.tenant = p.get('tenant');
      if (p.has('app')) state.app = p.get('app');
      if (p.has('agent')) state.agent = p.get('agent');
      if (p.has('session')) state.session = p.get('session');
      if (p.has('tier')) state.tier = p.get('tier');
      if (p.has('backend')) state.backend = p.get('backend');
      if (p.has('status')) state.status = p.get('status');
      if (p.has('errorCode')) state.errorCode = p.get('errorCode');

      // Update preset buttons
      document.querySelectorAll('#range-presets button').forEach((b) => {
        b.classList.toggle('active', b.dataset.range === state.range);
      });
      if (state.range === 'custom') {
        document.getElementById('custom-inputs').classList.add('show');
        if (state.from) document.getElementById('custom-from').value = state.from.slice(0, 16);
        if (state.to) document.getElementById('custom-to').value = state.to.slice(0, 16);
      }

      // Sync form fields
      document.getElementById('req-filter-tenant').value = state.tenant || '';
      document.getElementById('client-filter-top').value = state.tenant || '';
      document.getElementById('req-filter-app').value = state.app || '';
      document.getElementById('req-filter-agent').value = state.agent || '';
      document.getElementById('req-filter-session').value = state.session || '';
      document.getElementById('req-filter-tier').value = state.tier || '';
      document.getElementById('req-filter-backend').value = state.backend || '';
      document.getElementById('req-filter-status').value = state.status || '';
      document.getElementById('req-filter-error').value = state.errorCode || '';
    }

    async function apiFetch(url) {
      const res = await fetch(url);
      if (res.status === 401) {
        const b = document.getElementById('api-error-banner');
        b.innerHTML = 'Сессия истекла. Пожалуйста, <a href="/admin/login">авторизуйтесь снова</a>.';
        b.style.display = 'block';
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        throw new Error('API Error: ' + res.status);
      }
      return await res.json();
    }

    async function loadBudget() {
      try {
        const data = await apiFetch('/admin/api/budget');
        state.budget = data;
        renderProviderQuota(data?.provider);
      } catch (err) {
        console.error('Budget fetch error:', err);
      }
    }

    function renderProviderQuota(prov) {
      const badge = document.getElementById('provider-freshness-badge');
      const content = document.getElementById('provider-quota-content');
      if (!badge || !content) return;

      if (!prov || !prov.snapshot) {
        badge.className = 'badge badge-neutral';
        badge.textContent = 'Нет данных';
        content.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Данные о квоте MiniMax ещё не получены (ожидание первого опроса).</div>';
        return;
      }

      const s = prov.snapshot;
      const fresh = prov.fresh;
      badge.className = fresh ? 'badge badge-success' : 'badge badge-warning';
      badge.textContent = fresh ? 'Актуально' : 'Устарело';

      const est = prov.estimates || {};
      const estRawStr = est.weeklyQuotaRaw !== null && est.weeklyQuotaRaw !== undefined
        ? formatNumber(est.weeklyQuotaRaw)
        : '—';
      const estWeightedStr = est.weeklyQuotaWeighted !== null && est.weeklyQuotaWeighted !== undefined
        ? formatNumber(est.weeklyQuotaWeighted)
        : '—';

      const weeklyEndStr = s.weeklyEnd ? formatDateLocal(s.weeklyEnd) : '—';
      const intervalEndStr = s.intervalEnd ? formatDateLocal(s.intervalEnd) : '—';
      const fetchedAtStr = s.fetchedAt ? formatDateLocal(s.fetchedAt) : '—';

      const weeklyPct = s.weeklyRemainingPct ?? 0;
      const intervalPct = s.intervalRemainingPct ?? 0;

      content.innerHTML = \`
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px;">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">Неделя (остаток)</div>
            <div style="font-size: 18px; font-weight: 700;">\${weeklyPct}% <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">осталось</span></div>
            <div class="bar-track" style="margin-top: 6px; height: 5px;">
              <div class="bar-fill" style="width: \${weeklyPct}%; background: \${weeklyPct < 15 ? 'var(--danger)' : weeklyPct < 30 ? 'var(--warning)' : 'var(--primary)'};"></div>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">Окно до: <strong>\${weeklyEndStr}</strong></div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">Интервал (остаток)</div>
            <div style="font-size: 18px; font-weight: 700;">\${intervalPct}% <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">осталось</span></div>
            <div class="bar-track" style="margin-top: 6px; height: 5px;">
              <div class="bar-fill" style="width: \${intervalPct}%; background: \${intervalPct < 15 ? 'var(--danger)' : intervalPct < 30 ? 'var(--warning)' : 'var(--primary)'};"></div>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">Окно до: <strong>\${intervalEndStr}</strong></div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">Оценка квоты (raw / weighted)</div>
            <div style="font-size: 16px; font-weight: 700; margin-top: 2px;">\${estRawStr} / \${estWeightedStr}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">Обновлено: <strong>\${fetchedAtStr}</strong></div>
          </div>
        </div>
      \`;
    }

    async function loadClients() {
      try {
        const data = await apiFetch('/admin/api/clients');
        state.clients = data;
        renderClientsDropdown(data);
        renderClientsTable(data);
      } catch (err) {
        console.error('Clients fetch error:', err);
      }
    }

    function renderClientsDropdown(clients) {
      const topSelect = document.getElementById('client-filter-top');
      const reqSelect = document.getElementById('req-filter-tenant');

      const currentVal = state.tenant;

      let options = '<option value="">Все клиенты</option>';
      for (const c of clients) {
        options += \`<option value="\${c.tenant}">\${c.tenant}</option>\`;
      }
      topSelect.innerHTML = options;
      reqSelect.innerHTML = options;

      topSelect.value = currentVal;
      reqSelect.value = currentVal;
    }

    function renderClientsTable(clients) {
      const tbody = document.getElementById('clients-table-body');
      if (!clients || clients.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Клиенты не найдены</td></tr>';
        return;
      }

      let html = '';
      for (const c of clients) {
        const authBadges = (c.authTypes || []).map(a => \`<span class="badge badge-neutral">\${a}</span>\`).join(' ');
        const appsStr = (c.apps || []).join(', ') || '—';
        const keyHint = (c.keyHints && c.keyHints[0]) ? c.keyHints[0] : '—';
        const lastSeen = c.lastSeen ? formatDateLocal(c.lastSeen) : '—';
        const metaShare = Math.round((c.missingMetadataShare24h || 0) * 100);
        const metaBadge = metaShare > 0 ? \`<span class="badge badge-warning">\${metaShare}%</span>\` : \`<span class="badge badge-success">0%</span>\`;

        // MiniMax Budget limits & usage
        const b = c.budget || {};
        const dayUsed = b.dayUsed || 0;
        const dayLimit = b.dayLimit || 0;
        const hourUsed = b.hourUsed || 0;
        const hourLimit = b.hourLimit || 0;

        let budgetHtml = '—';
        if (dayLimit > 0) {
          const dayPct = Math.min(100, Math.round((dayUsed / dayLimit) * 100));
          budgetHtml = \`
            <div style="font-size: 11px;">
              <span>Сутки: \${formatNumber(dayUsed)} / \${formatNumber(dayLimit)} (\${dayPct}%)</span>
              <div class="bar-track" style="margin-top: 3px; height: 5px;">
                <div class="bar-fill" style="width: \${dayPct}%; background: \${dayPct > 90 ? 'var(--danger)' : 'var(--primary)'};"></div>
              </div>
            </div>\`;
        }

        html += \`
          <tr class="clickable" onclick="openClientDetails('\${c.tenant}')">
            <td><strong>\${c.tenant}</strong></td>
            <td><code style="font-size: 11px;">\${keyHint}</code></td>
            <td>\${authBadges}</td>
            <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis;">\${appsStr}</td>
            <td>\${lastSeen}</td>
            <td>\${formatNumber(c.requests24h)} / \${formatNumber(c.tokens24h)} / <span style="color: \${c.errors24h > 0 ? 'var(--danger)' : 'inherit'};">\${c.errors24h}</span></td>
            <td>\${metaBadge}</td>
            <td>\${budgetHtml}</td>
          </tr>
        \`;
      }
      tbody.innerHTML = html;
    }

    function openClientDetails(tenant) {
      // Set client filter
      state.tenant = tenant;
      document.getElementById('client-filter-top').value = tenant;
      document.getElementById('req-filter-tenant').value = tenant;
      updateUrlParams();
      loadSummary();
      loadRequests(true);

      const client = state.clients.find(c => c.tenant === tenant);
      if (!client) return;

      document.getElementById('drawer-tenant-title').textContent = client.tenant;

      // Info
      const infoList = document.getElementById('drawer-info-list');
      infoList.innerHTML = \`
        <li><span>Первый запрос</span><span>\${formatDateLocal(client.firstSeen)}</span></li>
        <li><span>Последний запрос</span><span>\${formatDateLocal(client.lastSeen)}</span></li>
        <li><span>Запросов за 24 ч</span><span>\${formatNumber(client.requests24h)}</span></li>
        <li><span>Запросов за 7 дн</span><span>\${formatNumber(client.requests7d)}</span></li>
        <li><span>Токенов за 24 ч</span><span>\${formatNumber(client.tokens24h)}</span></li>
        <li><span>Ошибок за 24 ч</span><span>\${client.errors24h}</span></li>
        <li><span>Доля без метаданных (24ч)</span><span>\${Math.round((client.missingMetadataShare24h || 0) * 100)}%</span></li>
        <li><span>Блокировок Loop Guard (7д)</span><span><strong style="color: \${client.loopBlocks7d > 0 ? 'var(--danger)' : 'inherit'};">\${client.loopBlocks7d}</strong></span></li>
      \`;

      // Agents
      const agentsList = document.getElementById('drawer-agents-list');
      const agents = Object.entries(client.agents || {});
      if (agents.length === 0) {
        agentsList.innerHTML = '<li style="color: var(--text-muted);">Нет данных</li>';
      } else {
        agentsList.innerHTML = agents.map(([ag, count]) => \`<li><span>\${ag}</span><span>\${count}</span></li>\`).join('');
      }

      // IPs
      const ipsList = document.getElementById('drawer-ips-list');
      if (!client.ips || client.ips.length === 0) {
        ipsList.innerHTML = '<li style="color: var(--text-muted);">Нет данных</li>';
      } else {
        ipsList.innerHTML = client.ips.map(ip => \`<li><code>\${ip}</code></li>\`).join('');
      }

      // User Agents
      const uaList = document.getElementById('drawer-useragents-list');
      if (!client.userAgents || client.userAgents.length === 0) {
        uaList.innerHTML = '<li style="color: var(--text-muted);">Нет данных</li>';
      } else {
        uaList.innerHTML = client.userAgents.map(ua => \`<li style="word-break: break-all; font-size: 11px;">\${ua}</li>\`).join('');
      }

      // Budget
      const b = client.budget || {};
      const budgetDiv = document.getElementById('drawer-budget-details');
      let budgetHtml = \`
        <div style="margin-bottom: 6px;">Суточный лимит: <strong>\${formatNumber(b.dayLimit || 0)}</strong> (использовано: \${formatNumber(b.dayUsed || 0)})</div>
        <div style="margin-bottom: 6px;">Часовой лимит: <strong>\${formatNumber(b.hourLimit || 0)}</strong> (использовано: \${formatNumber(b.hourUsed || 0)})</div>
        <div>Статус: \${b.over ? '<span class="badge badge-danger">Превышен</span> (' + (b.reason || '') + ')' : '<span class="badge badge-success">В норме</span>'}</div>
      \`;

      if (state.budget && state.budget.provider && state.budget.provider.snapshot) {
        const ps = state.budget.provider.snapshot;
        const pFresh = state.budget.provider.fresh;
        const fBadge = pFresh ? '<span class="badge badge-success">Актуально</span>' : '<span class="badge badge-warning">Устарело</span>';
        budgetHtml += \`
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
            Квота MiniMax: неделя <strong>\${ps.weeklyRemainingPct}%</strong>, интервал <strong>\${ps.intervalRemainingPct}%</strong> (\${fBadge})
          </div>
        \`;
      }

      if (b.quota && b.quota.granted) {
        const q = b.quota;
        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const reqDayStr = q.requested && q.requested.day ? formatNumber(q.requested.day) : '—';
        const reqHourStr = q.requested && q.requested.hour ? formatNumber(q.requested.hour) : '—';
        const grantDayStr = formatNumber(q.granted.day);
        const grantHourStr = formatNumber(q.granted.hour);
        const limitedBadge = q.limitedBy ? ' <span class="badge badge-warning">' + esc(q.limitedBy) + '</span>' : '';
        const expStr = q.expiresAt ? formatDateLocal(q.expiresAt) : '—';

        budgetHtml += \`
          <div style="margin-top: 12px; padding: 10px; border-radius: 6px; background: rgba(125, 125, 125, 0.08); border: 1px solid var(--border);">
            <div style="font-weight: 600; margin-bottom: 6px;">Квота по запросу (активна)</div>
            <div style="margin-bottom: 4px;">Запрошено: сутки <strong>\${reqDayStr}</strong>, час <strong>\${reqHourStr}</strong></div>
            <div style="margin-bottom: 4px;">Выделено: сутки <strong>\${grantDayStr}</strong>, час <strong>\${grantHourStr}</strong>\${limitedBadge}</div>
            <div>Истекает: <strong>\${expStr}</strong></div>
          </div>
        \`;
      }

      if (b.users && b.users.length > 0) {
        budgetHtml += \`
          <div style="margin-top: 14px; margin-bottom: 6px; font-weight: 600;">Пользователи за сегодня (\${b.users.length}):</div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Час</th>
                  <th>Сутки</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                \${b.users.map(u => \`
                  <tr>
                    <td style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px;">\${u.user}</td>
                    <td>\${formatNumber(u.hourUsed)} / \${u.hourLimit > 0 ? formatNumber(u.hourLimit) : '∞'}</td>
                    <td>\${formatNumber(u.dayUsed)} / \${u.dayLimit > 0 ? formatNumber(u.dayLimit) : '∞'}</td>
                    <td>\${u.over ? '<span class="badge badge-danger">' + (u.reason || 'over') + '</span>' : '<span class="badge badge-success">OK</span>'}</td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        \`;
      }
      budgetDiv.innerHTML = budgetHtml;

      // Open drawer
      document.getElementById('drawer-overlay').classList.add('open');
      document.getElementById('client-drawer').classList.add('open');
    }

    function closeDrawer() {
      document.getElementById('drawer-overlay').classList.remove('open');
      document.getElementById('client-drawer').classList.remove('open');
    }

    async function loadSummary() {
      const dates = getRangeDates();
      const p = new URLSearchParams({
        from: dates.from,
        to: dates.to
      });
      if (state.tenant) p.set('tenant', state.tenant);
      if (state.app) p.set('app', state.app);
      if (state.agent) p.set('agent', state.agent);
      if (state.session) p.set('session', state.session);
      if (state.tier) p.set('tier', state.tier);
      if (state.backend) p.set('backend', state.backend);
      if (state.status) p.set('status', state.status);
      if (state.errorCode) p.set('errorCode', state.errorCode);

      try {
        const data = await apiFetch('/admin/api/summary?' + p.toString());
        renderKPIs(data.totals);
        renderTimelineChart(data.series);
        renderSubCharts(data);
      } catch (err) {
        console.error('Summary fetch error:', err);
      }
    }

    function renderKPIs(totals) {
      if (!totals) return;
      document.getElementById('kpi-requests').textContent = formatNumber(totals.requests);

      const errPct = totals.requests > 0 ? ((totals.errors / totals.requests) * 100).toFixed(1) : '0';
      document.getElementById('kpi-errors').innerHTML = \`\${totals.errors} <span style="font-size: 15px; font-weight: normal; color: \${totals.errors > 0 ? 'var(--danger)' : 'var(--text-muted)'};">(\${errPct}%)</span>\`;

      document.getElementById('kpi-tokens').textContent = \`\${formatNumber(totals.promptTokens)} / \${formatNumber(totals.completionTokens)}\`;
      document.getElementById('kpi-latency').textContent = \`\${formatMs(totals.avgLatencyMs)} / \${formatMs(totals.p95LatencyMs)}\`;
    }

    function renderTimelineChart(series) {
      const svg = document.getElementById('chart-svg');
      const gridG = document.getElementById('chart-grid');
      const barsG = document.getElementById('chart-bars');
      const axesG = document.getElementById('chart-axes');
      const legendDiv = document.getElementById('chart-legend');

      gridG.innerHTML = '';
      barsG.innerHTML = '';
      axesG.innerHTML = '';
      legendDiv.innerHTML = '';

      if (!series || series.length === 0) {
        barsG.innerHTML = '<text x="500" y="110" text-anchor="middle" fill="currentColor" opacity="0.4" font-size="14">Нет данных за период</text>';
        return;
      }

      // Collect distinct tenants
      const tenantTotals = new Map();
      series.forEach(pt => {
        Object.entries(pt.byTenant || {}).forEach(([tenant, stat]) => {
          tenantTotals.set(tenant, (tenantTotals.get(tenant) || 0) + stat.requests);
        });
      });
      const tenants = Array.from(tenantTotals.keys());

      // Render legend
      tenants.forEach((tenant, idx) => {
        const color = getTenantColor(tenant, idx);
        const item = document.createElement('div');
        item.className = 'legend-item' + (state.hiddenTenants.has(tenant) ? ' dimmed' : '');
        item.innerHTML = \`<span class="legend-color" style="background: \${color};"></span><span>\${tenant} (\${tenantTotals.get(tenant)})</span>\`;
        item.onclick = () => {
          if (state.hiddenTenants.has(tenant)) {
            state.hiddenTenants.delete(tenant);
          } else {
            state.hiddenTenants.add(tenant);
          }
          renderTimelineChart(series);
        };
        legendDiv.appendChild(item);
      });

      // The server picks the bucket (hour, or day for ranges over 3 days) — label from the data.
      const bucketLabel = document.getElementById('chart-bucket-label');
      if (bucketLabel && series.length >= 2) {
        const step = new Date(series[1].t).getTime() - new Date(series[0].t).getTime();
        bucketLabel.textContent = step >= 86400000 ? 'шаг: день' : 'шаг: час';
      }

      // Find max bucket total
      let maxVal = 0;
      series.forEach(pt => {
        let bucketTotal = 0;
        Object.entries(pt.byTenant || {}).forEach(([t, s]) => {
          if (!state.hiddenTenants.has(t)) {
            bucketTotal += s.requests;
          }
        });
        if (bucketTotal > maxVal) maxVal = bucketTotal;
      });
      if (maxVal === 0) maxVal = 1;

      const chartW = 920;
      const chartH = 170;
      const offsetX = 50;
      const offsetY = 20;

      // Draw horizontal grid lines
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const yVal = Math.round((maxVal / ticks) * i);
        const yPos = offsetY + chartH - (i / ticks) * chartH;
        gridG.innerHTML += \`<line x1="\${offsetX}" y1="\${yPos}" x2="\${offsetX + chartW}" y2="\${yPos}" stroke="currentColor" opacity="0.08" stroke-dasharray="3,3" />\`;
        gridG.innerHTML += \`<text x="\${offsetX - 8}" y="\${yPos + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.5">\${yVal}</text>\`;
      }

      // Draw stacked bars
      const numBars = series.length;
      const barSlot = chartW / numBars;
      const barW = Math.max(2, Math.min(barSlot * 0.75, 28));

      const tooltip = document.getElementById('chart-tooltip');

      series.forEach((pt, bIdx) => {
        const xCenter = offsetX + bIdx * barSlot + barSlot / 2;
        const xPos = xCenter - barW / 2;

        let curY = offsetY + chartH;

        // Sort tenants consistently
        const tEntries = Object.entries(pt.byTenant || {}).filter(([t]) => !state.hiddenTenants.has(t));
        let bucketTotal = 0;
        tEntries.forEach(([_, s]) => bucketTotal += s.requests);

        tEntries.forEach(([tenant, s], tIdx) => {
          const segH = (s.requests / maxVal) * chartH;
          curY -= segH;
          const color = getTenantColor(tenant, tIdx);

          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(xPos));
          rect.setAttribute('y', String(curY));
          rect.setAttribute('width', String(barW));
          rect.setAttribute('height', String(Math.max(1, segH)));
          rect.setAttribute('fill', color);
          rect.setAttribute('rx', '1');
          rect.style.cursor = 'pointer';

          // Hover interaction
          rect.onmouseenter = (e) => {
            let tooltipHtml = \`<strong>\${formatDateLocal(pt.t)}</strong><br>Всего: \${bucketTotal}<hr style="border:none; border-top:1px solid var(--border); margin:4px 0;">\`;
            tEntries.forEach(([t, st]) => {
              tooltipHtml += \`<div style="display:flex; justify-content:space-between; gap:10px;"><span>\${t}:</span><strong>\${st.requests}</strong></div>\`;
            });
            tooltip.innerHTML = tooltipHtml;
            tooltip.style.display = 'block';
            tooltip.style.left = (e.pageX + 10) + 'px';
            tooltip.style.top = (e.pageY - 40) + 'px';
          };
          rect.onmouseleave = () => {
            tooltip.style.display = 'none';
          };

          barsG.appendChild(rect);
        });

        // Time labels on X axis
        const step = Math.max(1, Math.floor(numBars / 6));
        if (bIdx % step === 0 || bIdx === numBars - 1) {
          const d = new Date(pt.t);
          const timeLabel = \`\${d.getDate()}.\${d.getMonth()+1} \${String(d.getHours()).padStart(2, '0')}:00\`;
          axesG.innerHTML += \`<text x="\${xCenter}" y="\${offsetY + chartH + 18}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.5">\${timeLabel}</text>\`;
        }
      });
    }

    function renderSubCharts(data) {
      // Tiers
      const tiersContainer = document.getElementById('tiers-chart');
      const tiers = Object.entries(data.byTier || {}).sort((a,b) => b[1] - a[1]);
      if (tiers.length === 0) {
        tiersContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Нет данных</div>';
      } else {
        const maxTier = Math.max(...tiers.map(t => t[1])) || 1;
        tiersContainer.innerHTML = tiers.map(([tier, count]) => \`
          <div class="bar-row">
            <div class="bar-label" title="\${tier}">\${tier}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width: \${Math.round((count / maxTier) * 100)}%;"></div>
            </div>
            <div class="bar-val">\${count}</div>
          </div>
        \`).join('');
      }

      // Backends
      const backendsContainer = document.getElementById('backends-chart');
      const backends = Object.entries(data.byBackend || {}).sort((a,b) => b[1] - a[1]);
      if (backends.length === 0) {
        backendsContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Нет данных</div>';
      } else {
        const maxBackend = Math.max(...backends.map(b => b[1])) || 1;
        backendsContainer.innerHTML = backends.map(([backend, count]) => \`
          <div class="bar-row">
            <div class="bar-label" title="\${backend}">\${backend}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width: \${Math.round((count / maxBackend) * 100)}%; background: #10b981;"></div>
            </div>
            <div class="bar-val">\${count}</div>
          </div>
        \`).join('');
      }

      // Statuses & Errors
      const statusContainer = document.getElementById('status-chart');
      const s = data.byStatus || { '2xx': 0, '4xx': 0, '5xx': 0, errorCodes: {} };
      const totalS = (s['2xx'] || 0) + (s['4xx'] || 0) + (s['5xx'] || 0) || 1;

      const p2 = Math.round(((s['2xx'] || 0) / totalS) * 100);
      const p4 = Math.round(((s['4xx'] || 0) / totalS) * 100);
      const p5 = Math.round(((s['5xx'] || 0) / totalS) * 100);

      const errCodes = Object.entries(s.errorCodes || {}).sort((a,b) => b[1] - a[1]);
      const errCodesHtml = errCodes.length > 0
        ? errCodes.map(([code, c]) => \`<span class="badge badge-danger" style="margin: 2px;">\${code}: \${c}</span>\`).join(' ')
        : '<span style="color: var(--text-muted); font-size: 11px;">Нет ошибок</span>';

      statusContainer.innerHTML = \`
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <span class="badge badge-success">2xx: \${s['2xx'] || 0} (\${p2}%)</span>
          <span class="badge badge-warning">4xx: \${s['4xx'] || 0} (\${p4}%)</span>
          <span class="badge badge-danger">5xx: \${s['5xx'] || 0} (\${p5}%)</span>
        </div>
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px;">ТОП КОДОВ ОШИБОК:</div>
        <div>\${errCodesHtml}</div>
      \`;
    }

    async function loadRequests(reset = false) {
      if (reset) {
        state.nextBefore = null;
        document.getElementById('requests-table-body').innerHTML =
          '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Загрузка запросов...</td></tr>';
      }

      const dates = getRangeDates();
      const p = new URLSearchParams({
        from: dates.from,
        to: dates.to,
        limit: '100'
      });
      if (state.nextBefore) p.set('before', state.nextBefore);
      if (state.tenant) p.set('tenant', state.tenant);
      if (state.app) p.set('app', state.app);
      if (state.agent) p.set('agent', state.agent);
      if (state.session) p.set('session', state.session);
      if (state.tier) p.set('tier', state.tier);
      if (state.backend) p.set('backend', state.backend);
      if (state.status) p.set('status', state.status);
      if (state.errorCode) p.set('errorCode', state.errorCode);

      try {
        const data = await apiFetch('/admin/api/requests?' + p.toString());
        state.nextBefore = data.nextBefore;
        renderRequestsTable(data.items, reset);

        const btnMore = document.getElementById('btn-load-more');
        if (state.nextBefore) {
          btnMore.style.display = 'inline-block';
        } else {
          btnMore.style.display = 'none';
        }
      } catch (err) {
        console.error('Requests fetch error:', err);
      }
    }

    function renderRequestsTable(items, reset) {
      const tbody = document.getElementById('requests-table-body');
      if (reset) tbody.innerHTML = '';

      if ((!items || items.length === 0) && reset) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Запросы не найдены</td></tr>';
        return;
      }

      for (const rec of items) {
        const row = document.createElement('tr');
        row.className = 'clickable';

        const statusClass = rec.status >= 200 && rec.status < 300 ? 'badge-success'
          : (rec.status >= 400 && rec.status < 500 ? 'badge-warning' : 'badge-danger');

        const sessionShort = rec.session ? (rec.session.length > 10 ? rec.session.slice(0, 10) + '…' : rec.session) : '—';
        const latencyStr = rec.ttfbMs
          ? \`\${formatMs(rec.latencyMs)} <span style="font-size:10px; color:var(--text-muted);">(ttfb \${rec.ttfbMs}мс)</span>\`
          : formatMs(rec.latencyMs);

        // Flags
        const flags = [];
        if (rec.stream) flags.push('<span class="badge badge-neutral">stream</span>');
        if (rec.hasTools) flags.push('<span class="badge badge-neutral">tools</span>');
        if (rec.hasImages) flags.push('<span class="badge badge-neutral">images</span>');
        if (rec.overlay) flags.push('<span class="badge badge-neutral">overlay</span>');
        if (rec.failoverCount) flags.push(\`<span class="badge badge-warning">failover: \${rec.failoverCount}</span>\`);
        if (rec.budgetExceeded) flags.push('<span class="badge badge-danger">budget</span>');
        if (rec.loopRule) flags.push(\`<span class="badge badge-danger">loop: \${rec.loopRule}</span>\`);
        if (rec.missingMetadata) flags.push('<span class="badge badge-warning">no-meta</span>');

        const previewText = rec.preview ? (rec.preview.length > 30 ? rec.preview.slice(0, 30) + '…' : rec.preview) : '';

        row.innerHTML = \`
          <td>\${formatDateLocal(rec.ts)}</td>
          <td><strong>\${rec.tenant}</strong></td>
          <td>\${rec.app || '—'} / \${rec.agent || '—'}</td>
          <td title="\${rec.session || ''}">\${sessionShort}</td>
          <td>\${rec.tier || '—'} \${rec.backend ? '→ ' + rec.backend : ''}</td>
          <td><span class="badge \${statusClass}">\${rec.status} \${rec.errorCode || ''}</span></td>
          <td>\${rec.promptTokens ?? '—'} / \${rec.completionTokens ?? '—'}</td>
          <td>\${latencyStr}</td>
          <td>\${flags.join(' ') || '—'}</td>
          <td title="\${rec.preview || ''}">\${previewText || '—'}</td>
        \`;

        // Expand raw JSON on click
        let expanded = false;
        let detailRow = null;

        row.onclick = () => {
          expanded = !expanded;
          if (expanded) {
            detailRow = document.createElement('tr');
            detailRow.className = 'expanded-row';
            detailRow.innerHTML = \`<td colspan="10"><pre class="json-code"><code>\${JSON.stringify(rec, null, 2)}</code></pre></td>\`;
            row.after(detailRow);
          } else if (detailRow) {
            detailRow.remove();
            detailRow = null;
          }
        };

        tbody.appendChild(row);
      }
    }

    function initListeners() {
      // Range presets
      document.querySelectorAll('#range-presets button').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('#range-presets button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          state.range = btn.dataset.range;
          if (state.range === 'custom') {
            document.getElementById('custom-inputs').classList.add('show');
          } else {
            document.getElementById('custom-inputs').classList.remove('show');
            updateUrlParams();
            loadSummary();
            loadRequests(true);
          }
        };
      });

      document.getElementById('btn-apply-custom').onclick = () => {
        state.from = document.getElementById('custom-from').value;
        state.to = document.getElementById('custom-to').value;
        updateUrlParams();
        loadSummary();
        loadRequests(true);
      };

      // Top client dropdown
      document.getElementById('client-filter-top').onchange = (e) => {
        state.tenant = e.target.value;
        document.getElementById('req-filter-tenant').value = state.tenant;
        updateUrlParams();
        loadSummary();
        loadRequests(true);
      };

      // Requests filter inputs
      const applyFilters = () => {
        state.tenant = document.getElementById('req-filter-tenant').value;
        document.getElementById('client-filter-top').value = state.tenant;
        state.app = document.getElementById('req-filter-app').value;
        state.agent = document.getElementById('req-filter-agent').value;
        state.session = document.getElementById('req-filter-session').value;
        state.tier = document.getElementById('req-filter-tier').value;
        state.backend = document.getElementById('req-filter-backend').value;
        state.status = document.getElementById('req-filter-status').value;
        state.errorCode = document.getElementById('req-filter-error').value;
        updateUrlParams();
        loadSummary();
        loadRequests(true);
      };

      document.getElementById('req-filter-tenant').onchange = applyFilters;
      document.getElementById('req-filter-tier').onchange = applyFilters;
      document.getElementById('req-filter-status').onchange = applyFilters;

      let debounceTimer = null;
      ['req-filter-app', 'req-filter-agent', 'req-filter-session', 'req-filter-backend', 'req-filter-error'].forEach(id => {
        document.getElementById(id).oninput = () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(applyFilters, 350);
        };
      });

      document.getElementById('btn-reset-filters').onclick = () => {
        state.tenant = '';
        state.app = '';
        state.agent = '';
        state.session = '';
        state.tier = '';
        state.backend = '';
        state.status = '';
        state.errorCode = '';
        document.getElementById('client-filter-top').value = '';
        document.getElementById('req-filter-tenant').value = '';
        document.getElementById('req-filter-app').value = '';
        document.getElementById('req-filter-agent').value = '';
        document.getElementById('req-filter-session').value = '';
        document.getElementById('req-filter-tier').value = '';
        document.getElementById('req-filter-backend').value = '';
        document.getElementById('req-filter-status').value = '';
        document.getElementById('req-filter-error').value = '';
        updateUrlParams();
        loadSummary();
        loadRequests(true);
      };

      // Load more requests
      document.getElementById('btn-load-more').onclick = () => {
        loadRequests(false);
      };

      // Drawer close
      document.getElementById('drawer-close-btn').onclick = closeDrawer;
      document.getElementById('drawer-overlay').onclick = () => {
        closeDrawer();
        closeTenantDrawer();
      };
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeDrawer();
          closeTenantDrawer();
        }
      });

      // Auto-refresh
      const autoRefreshCheckbox = document.getElementById('auto-refresh');
      const liveDot = document.getElementById('live-indicator');
      autoRefreshCheckbox.onchange = (e) => {
        state.isAutoRefreshing = e.target.checked;
        liveDot.style.animationPlayState = state.isAutoRefreshing ? 'running' : 'paused';
        liveDot.style.opacity = state.isAutoRefreshing ? '1' : '0.2';
      };

      setInterval(() => {
        if (state.isAutoRefreshing) {
          loadBudget();
          loadClients();
          loadSummary();
          loadRequests(true);
          const viewTen = document.getElementById('view-tenants');
          if (viewTen && viewTen.style.display !== 'none') {
            loadTenantsTable();
          }
        }
      }, 30000);
    }

    // Tenant Management Logic
    let tenantsData = [];
    let currentEditingTenantId = null;

    function switchMainTab(tab) {
      const btnMon = document.getElementById('btn-tab-monitoring');
      const btnTen = document.getElementById('btn-tab-tenants');
      const btnNot = document.getElementById('btn-tab-notifications');
      const btnCat = document.getElementById('btn-tab-catalog');
      const btnWat = document.getElementById('btn-tab-watch');
      const viewMon = document.getElementById('view-monitoring');
      const viewTen = document.getElementById('view-tenants');
      const viewNot = document.getElementById('view-notifications');
      const viewCat = document.getElementById('view-catalog');
      const viewWat = document.getElementById('view-watch');

      if (tab === 'tenants') {
        btnTen.classList.add('btn-primary');
        btnMon.classList.remove('btn-primary');
        if (btnNot) btnNot.classList.remove('btn-primary');
        if (btnCat) btnCat.classList.remove('btn-primary');
        if (btnWat) btnWat.classList.remove('btn-primary');
        viewMon.style.display = 'none';
        viewTen.style.display = 'block';
        if (viewNot) viewNot.style.display = 'none';
        if (viewCat) viewCat.style.display = 'none';
        if (viewWat) viewWat.style.display = 'none';
        window.location.hash = 'tenants';
        loadTenantsTable();
      } else if (tab === 'notifications') {
        if (btnNot) btnNot.classList.add('btn-primary');
        btnMon.classList.remove('btn-primary');
        btnTen.classList.remove('btn-primary');
        if (btnCat) btnCat.classList.remove('btn-primary');
        if (btnWat) btnWat.classList.remove('btn-primary');
        viewMon.style.display = 'none';
        viewTen.style.display = 'none';
        if (viewNot) viewNot.style.display = 'block';
        if (viewCat) viewCat.style.display = 'none';
        if (viewWat) viewWat.style.display = 'none';
        window.location.hash = 'notifications';
        loadNotificationsView();
      } else if (tab === 'catalog') {
        if (btnCat) btnCat.classList.add('btn-primary');
        btnMon.classList.remove('btn-primary');
        btnTen.classList.remove('btn-primary');
        if (btnNot) btnNot.classList.remove('btn-primary');
        if (btnWat) btnWat.classList.remove('btn-primary');
        viewMon.style.display = 'none';
        viewTen.style.display = 'none';
        if (viewNot) viewNot.style.display = 'none';
        if (viewCat) viewCat.style.display = 'block';
        if (viewWat) viewWat.style.display = 'none';
        window.location.hash = 'catalog';
        loadCatalogView();
      } else if (tab === 'watch') {
        if (btnWat) btnWat.classList.add('btn-primary');
        btnMon.classList.remove('btn-primary');
        btnTen.classList.remove('btn-primary');
        if (btnNot) btnNot.classList.remove('btn-primary');
        if (btnCat) btnCat.classList.remove('btn-primary');
        viewMon.style.display = 'none';
        viewTen.style.display = 'none';
        if (viewNot) viewNot.style.display = 'none';
        if (viewCat) viewCat.style.display = 'none';
        if (viewWat) viewWat.style.display = 'block';
        window.location.hash = 'watch';
        loadWatchReportsList();
      } else {
        btnMon.classList.add('btn-primary');
        btnTen.classList.remove('btn-primary');
        if (btnNot) btnNot.classList.remove('btn-primary');
        if (btnCat) btnCat.classList.remove('btn-primary');
        if (btnWat) btnWat.classList.remove('btn-primary');
        viewMon.style.display = 'block';
        viewTen.style.display = 'none';
        if (viewNot) viewNot.style.display = 'none';
        if (viewCat) viewCat.style.display = 'none';
        if (viewWat) viewWat.style.display = 'none';
        window.location.hash = 'monitoring';
      }
    }

    async function loadTenantsTable() {
      const tbody = document.getElementById('tenants-table-body');
      try {
        const res = await fetch('/admin/api/tenants');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json();
        tenantsData = data.tenants || [];

        if (tenantsData.length === 0) {
          tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Нет зарегистрированных клиентов</td></tr>';
          return;
        }

        tbody.innerHTML = tenantsData.map((t) => {
          const id = t.id || (t.record && t.record.id) || '-';
          const name = (t.record && t.record.name) || (id === '*' ? 'Шаблон по умолчанию' : '—');
          const status = t.record ? t.record.status : 'не в базе';
          let statusBadge = status === 'active'
            ? '<span class="badge badge-success">active</span>'
            : (status === 'disabled' ? '<span class="badge badge-danger">disabled</span>' : '<span class="badge badge-neutral">не в базе</span>');
          if (t.record && t.record.mode === 'byok') {
            statusBadge += ' <span class="badge badge-warning">BYOK</span>';
          }

          const r = t.effective.rate || {};
          const rpmStr = r.rpm ? r.rpm : '∞';
          const concStr = r.concurrent ? r.concurrent : '∞';
          const dayStr = r.dayRequests ? r.dayRequests : '∞';

          const l = t.effective.loop || {};
          const loopStr = (l.maxReq || 40) + ' req / ' + (l.blockSec || 600) + 's (' + (l.mode || 'enforce') + ')';

          const m = t.effective.minimax || {};
          const mmDay = m.day ? (m.day / 1e6).toFixed(1) + 'M' : '∞';
          const mmHour = m.hour ? (m.hour / 1e6).toFixed(1) + 'M' : '∞';
          const mmStr = mmDay + ' / ' + mmHour;

          const u = t.usage || {};
          const uReq = u.dayRequests || 0;
          const uMm = u.minimax && u.minimax.dayUsed ? (u.minimax.dayUsed / 1e6).toFixed(2) + 'M tok' : '0 tok';
          const todayUsageStr = uReq + ' запр. · ' + uMm;

          // Tenant ids from x-tenant-id impersonation are arbitrary text: escape,
          // and pass the id via data-* instead of an inline JS string.
          return '<tr class="clickable" data-tenant-id="' + escTenant(id) + '" onclick="openTenantDrawer(this.dataset.tenantId)">' +
            '<td><strong>' + escTenant(id) + '</strong></td>' +
            '<td>' + escTenant(name) + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td>' + rpmStr + '</td>' +
            '<td>' + concStr + '</td>' +
            '<td>' + dayStr + '</td>' +
            '<td>' + loopStr + '</td>' +
            '<td>' + mmStr + '</td>' +
            '<td>' + todayUsageStr + '</td>' +
            '<td><button type="button" class="btn" style="padding: 2px 8px; font-size: 11px;" onclick="event.stopPropagation(); openTenantDrawer(this.parentNode.parentNode.dataset.tenantId)">Редактировать</button></td>' +
          '</tr>';
        }).join('');
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--danger);">Ошибка загрузки клиентов: ' + err.message + '</td></tr>';
      }
    }

    function escTenant(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function openTenantDrawer(id) {
      currentEditingTenantId = id;
      const drawer = document.getElementById('tenant-edit-drawer');
      const overlay = document.getElementById('drawer-overlay');
      const errBox = document.getElementById('tenant-form-error');
      const tokenBox = document.getElementById('tenant-token-display-box');
      errBox.style.display = 'none';
      tokenBox.style.display = 'none';

      const idInput = document.getElementById('tenant-input-id');
      const nameInput = document.getElementById('tenant-input-name');
      const statusSelect = document.getElementById('tenant-input-status');
      const notesInput = document.getElementById('tenant-input-notes');

      const modeSelect = document.getElementById('tenant-input-mode');
      const allowSharedEmbCheck = document.getElementById('tenant-input-allow-shared-embeddings');
      const overlaySelect = document.getElementById('tenant-input-overlay');
      const thinkingWithToolsSelect = document.getElementById('tenant-input-thinking-with-tools');
      const poolsJsonInput = document.getElementById('tenant-input-pools-json');
      const ollamaKeyInput = document.getElementById('tenant-input-ollama-key');
      const ollamaBadge = document.getElementById('tenant-ollama-key-badge');
      const ollamaDetails = document.getElementById('tenant-ollama-key-details');
      const btnDeleteKey = document.getElementById('btn-delete-ollama-key');
      const ollamaMsg = document.getElementById('tenant-ollama-key-msg');
      const openaiKeyInput = document.getElementById('tenant-input-openai-key');
      const openaiBadge = document.getElementById('tenant-openai-key-badge');
      const openaiDetails = document.getElementById('tenant-openai-key-details');
      const btnDeleteOpenaiKey = document.getElementById('btn-delete-openai-key');
      const openaiMsg = document.getElementById('tenant-openai-key-msg');
      const providerOrderSelect = document.getElementById('tenant-input-provider-order');
      const poolsTbody = document.getElementById('tenant-pools-table-body');

      const rateRpmInput = document.getElementById('tenant-input-rate-rpm');
      const rateConcInput = document.getElementById('tenant-input-rate-concurrent');
      const rateDayInput = document.getElementById('tenant-input-rate-day');

      const loopModeSelect = document.getElementById('tenant-input-loop-mode');
      const loopMaxReq = document.getElementById('tenant-input-loop-maxReq');
      const loopReqWin = document.getElementById('tenant-input-loop-reqWindowSec');
      const loopMaxTok = document.getElementById('tenant-input-loop-maxTokens');
      const loopTokWin = document.getElementById('tenant-input-loop-tokenWindowSec');
      const loopMaxRep = document.getElementById('tenant-input-loop-maxRepeat');
      const loopBlock = document.getElementById('tenant-input-loop-blockSec');

      const mmDay = document.getElementById('tenant-input-minimax-day');
      const mmHour = document.getElementById('tenant-input-minimax-hour');
      const mmUserDay = document.getElementById('tenant-input-minimax-user-day');
      const mmUserHour = document.getElementById('tenant-input-minimax-user-hour');
      const mmDayShare = document.getElementById('tenant-input-minimax-dayShare');
      const mmHourShare = document.getElementById('tenant-input-minimax-hourShare');

      const notifyEmail = document.getElementById('tenant-input-notify-email');
      const notifyTg = document.getElementById('tenant-input-notify-telegram');
      const notifyLang = document.getElementById('tenant-input-notify-lang');
      const agentsJson = document.getElementById('tenant-input-agents-json');

      const btnRotate = document.getElementById('btn-rotate-token');
      const btnUnblock = document.getElementById('btn-unblock-tenant');
      const btnDelete = document.getElementById('btn-delete-tenant');

      if (!id) {
        document.getElementById('tenant-drawer-title').textContent = 'Новый клиент';
        idInput.disabled = false;
        idInput.value = '';
        nameInput.value = '';
        statusSelect.value = 'active';
        notesInput.value = '';

        if (modeSelect) modeSelect.value = 'shared';
        if (allowSharedEmbCheck) allowSharedEmbCheck.checked = false;
        if (overlaySelect) overlaySelect.value = 'auto';
        if (thinkingWithToolsSelect) thinkingWithToolsSelect.value = 'model-default';
        if (poolsJsonInput) poolsJsonInput.value = '';
        if (ollamaKeyInput) ollamaKeyInput.value = '';
        if (ollamaBadge) {
          ollamaBadge.className = 'badge badge-neutral';
          ollamaBadge.textContent = 'Не настроен';
        }
        if (ollamaDetails) ollamaDetails.textContent = '';
        if (btnDeleteKey) btnDeleteKey.style.display = 'none';
        if (ollamaMsg) ollamaMsg.style.display = 'none';

        if (openaiKeyInput) openaiKeyInput.value = '';
        if (openaiBadge) {
          openaiBadge.className = 'badge badge-neutral';
          openaiBadge.textContent = 'Не настроен';
        }
        if (openaiDetails) openaiDetails.textContent = '';
        if (btnDeleteOpenaiKey) btnDeleteOpenaiKey.style.display = 'none';
        if (openaiMsg) openaiMsg.style.display = 'none';
        if (providerOrderSelect) providerOrderSelect.value = 'ollama-cloud,openai';

        if (poolsTbody) poolsTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Сохраните клиента для просмотра моделей</td></tr>';

        rateRpmInput.value = '';
        rateConcInput.value = '';
        rateDayInput.value = '';

        loopModeSelect.value = '';
        loopMaxReq.value = '';
        loopReqWin.value = '';
        loopMaxTok.value = '';
        loopTokWin.value = '';
        loopMaxRep.value = '';
        loopBlock.value = '';

        mmDay.value = '';
        mmHour.value = '';
        mmUserDay.value = '';
        mmUserHour.value = '';
        mmDayShare.value = '';
        mmHourShare.value = '';

        notifyEmail.value = '';
        notifyTg.value = '';
        notifyLang.value = '';
        agentsJson.value = '';

        btnRotate.style.display = 'none';
        btnUnblock.style.display = 'none';
        btnDelete.style.display = 'none';
      } else {
        document.getElementById('tenant-drawer-title').textContent = 'Клиент: ' + id;
        idInput.disabled = true;
        idInput.value = id;

        btnRotate.style.display = 'inline-block';
        btnUnblock.style.display = 'inline-block';
        btnDelete.style.display = 'inline-block';

        const item = tenantsData.find((t) => t.id === id);
        const rec = item?.record;
        nameInput.value = rec?.name || '';
        statusSelect.value = rec?.status || 'active';
        notesInput.value = rec?.notes || '';

        if (modeSelect) modeSelect.value = rec?.mode || 'shared';
        if (allowSharedEmbCheck) allowSharedEmbCheck.checked = !!rec?.allowSharedEmbeddings;
        if (overlaySelect) overlaySelect.value = rec?.overlay || 'auto';
        if (thinkingWithToolsSelect) thinkingWithToolsSelect.value = rec?.thinkingWithTools || 'model-default';
        if (poolsJsonInput) poolsJsonInput.value = rec?.pools ? JSON.stringify(rec.pools, null, 2) : '';
        if (ollamaKeyInput) ollamaKeyInput.value = '';
        if (ollamaMsg) ollamaMsg.style.display = 'none';

        const k = rec?.upstreamKeys && rec.upstreamKeys['ollama-cloud'];
        if (k) {
          if (btnDeleteKey) btnDeleteKey.style.display = 'inline-block';
          if (ollamaBadge) {
            const st = k.status || 'unknown';
            if (st === 'ok') {
              ollamaBadge.className = 'badge badge-success';
              ollamaBadge.textContent = 'Подключен';
            } else if (st === 'invalid') {
              ollamaBadge.className = 'badge badge-danger';
              ollamaBadge.textContent = 'Недействителен';
            } else if (st === 'exhausted') {
              ollamaBadge.className = 'badge badge-warning';
              ollamaBadge.textContent = 'Исчерпан';
            } else {
              ollamaBadge.className = 'badge badge-neutral';
              ollamaBadge.textContent = st;
            }
          }
          if (ollamaDetails) {
            let det = k.hint ? ('Хинт: ' + k.hint) : '';
            if (k.exhaustedUntil) det += ' (до ' + k.exhaustedUntil.replace('T', ' ').slice(0, 19) + ')';
            if (k.lastError) det += ' — ' + k.lastError;
            ollamaDetails.textContent = det;
          }
        } else {
          if (btnDeleteKey) btnDeleteKey.style.display = 'none';
          if (ollamaBadge) {
            ollamaBadge.className = 'badge badge-neutral';
            ollamaBadge.textContent = 'Не настроен';
          }
          if (ollamaDetails) ollamaDetails.textContent = '';
        }

        if (openaiKeyInput) openaiKeyInput.value = '';
        if (openaiMsg) openaiMsg.style.display = 'none';

        const ko = rec?.upstreamKeys && rec.upstreamKeys['openai'];
        if (ko) {
          if (btnDeleteOpenaiKey) btnDeleteOpenaiKey.style.display = 'inline-block';
          if (openaiBadge) {
            const st = ko.status || 'unknown';
            if (st === 'ok') {
              openaiBadge.className = 'badge badge-success';
              openaiBadge.textContent = 'Подключен';
            } else if (st === 'invalid') {
              openaiBadge.className = 'badge badge-danger';
              openaiBadge.textContent = 'Недействителен';
            } else if (st === 'exhausted') {
              openaiBadge.className = 'badge badge-warning';
              openaiBadge.textContent = 'Исчерпан';
            } else {
              openaiBadge.className = 'badge badge-neutral';
              openaiBadge.textContent = st;
            }
          }
          if (openaiDetails) {
            let det = ko.hint ? ('Хинт: ' + ko.hint) : '';
            if (ko.exhaustedUntil) det += ' (до ' + ko.exhaustedUntil.replace('T', ' ').slice(0, 19) + ')';
            if (ko.lastError) det += ' — ' + ko.lastError;
            openaiDetails.textContent = det;
          }
        } else {
          if (btnDeleteOpenaiKey) btnDeleteOpenaiKey.style.display = 'none';
          if (openaiBadge) {
            openaiBadge.className = 'badge badge-neutral';
            openaiBadge.textContent = 'Не настроен';
          }
          if (openaiDetails) openaiDetails.textContent = '';
        }

        if (providerOrderSelect) {
          const po = rec?.providerOrder;
          if (Array.isArray(po) && po.length > 0) {
            providerOrderSelect.value = po.join(',');
          } else {
            providerOrderSelect.value = 'ollama-cloud,openai';
          }
        }

        loadTenantPools(id);

        const rl = rec?.limits?.rate;
        rateRpmInput.value = rl?.rpm !== undefined ? rl.rpm : '';
        rateConcInput.value = rl?.concurrent !== undefined ? rl.concurrent : '';
        rateDayInput.value = rl?.dayRequests !== undefined ? rl.dayRequests : '';

        const ll = rec?.limits?.loop;
        loopModeSelect.value = ll?.mode || '';
        loopMaxReq.value = ll?.maxReq !== undefined ? ll.maxReq : '';
        loopReqWin.value = ll?.reqWindowSec !== undefined ? ll.reqWindowSec : '';
        loopMaxTok.value = ll?.maxTokens !== undefined ? ll.maxTokens : '';
        loopTokWin.value = ll?.tokenWindowSec !== undefined ? ll.tokenWindowSec : '';
        loopMaxRep.value = ll?.maxRepeat !== undefined ? ll.maxRepeat : '';
        loopBlock.value = ll?.blockSec !== undefined ? ll.blockSec : '';

        const ml = rec?.limits?.minimax;
        mmDay.value = ml?.day !== undefined ? ml.day : '';
        mmHour.value = ml?.hour !== undefined ? ml.hour : '';
        mmUserDay.value = ml?.user?.day !== undefined ? ml.user.day : '';
        mmUserHour.value = ml?.user?.hour !== undefined ? ml.user.hour : '';
        mmDayShare.value = ml?.quotaMax?.dayShare !== undefined ? ml.quotaMax.dayShare : '';
        mmHourShare.value = ml?.quotaMax?.hourShare !== undefined ? ml.quotaMax.hourShare : '';

        notifyEmail.value = rec?.notify?.email ? rec.notify.email.join(', ') : '';
        notifyTg.value = rec?.notify?.telegram ? rec.notify.telegram.join(', ') : '';
        notifyLang.value = rec?.notify?.lang || '';

        agentsJson.value = rec?.limits?.agents ? JSON.stringify(rec.limits.agents, null, 2) : '';
      }

      overlay.classList.add('open');
      drawer.classList.add('open');
    }

    function closeTenantDrawer() {
      const drawer = document.getElementById('tenant-edit-drawer');
      const overlay = document.getElementById('drawer-overlay');
      drawer.classList.remove('open');
      overlay.classList.remove('open');
    }

    async function saveTenantForm() {
      const errBox = document.getElementById('tenant-form-error');
      errBox.style.display = 'none';

      const id = document.getElementById('tenant-input-id').value.trim();
      if (!id) {
        errBox.textContent = 'Укажите ID клиента';
        errBox.style.display = 'block';
        return;
      }

      const body = {
        name: document.getElementById('tenant-input-name').value.trim() || undefined,
        status: document.getElementById('tenant-input-status').value,
        notes: document.getElementById('tenant-input-notes').value.trim() || undefined,
      };

      const modeSelect = document.getElementById('tenant-input-mode');
      if (modeSelect) body.mode = modeSelect.value;
      const allowSharedEmbCheck = document.getElementById('tenant-input-allow-shared-embeddings');
      if (allowSharedEmbCheck) body.allowSharedEmbeddings = allowSharedEmbCheck.checked;
      const overlaySelect = document.getElementById('tenant-input-overlay');
      if (overlaySelect && overlaySelect.value && overlaySelect.value !== 'auto') {
        body.overlay = overlaySelect.value;
      }
      const thinkingWithToolsSelect = document.getElementById('tenant-input-thinking-with-tools');
      if (thinkingWithToolsSelect && thinkingWithToolsSelect.value && thinkingWithToolsSelect.value !== 'model-default') {
        body.thinkingWithTools = thinkingWithToolsSelect.value;
      }
      const orderVal = document.getElementById('tenant-input-provider-order')?.value;
      if (orderVal) {
        body.providerOrder = orderVal.split(',').map((s) => s.trim()).filter(Boolean);
      }

      const poolsRaw = document.getElementById('tenant-input-pools-json').value.trim();
      if (poolsRaw) {
        try {
          body.pools = JSON.parse(poolsRaw);
        } catch (e) {
          errBox.textContent = 'Ошибка в JSON "Переопределить пулы": ' + e.message;
          errBox.style.display = 'block';
          return;
        }
      }

      // Rate limits
      const rateRpm = document.getElementById('tenant-input-rate-rpm').value;
      const rateConc = document.getElementById('tenant-input-rate-concurrent').value;
      const rateDay = document.getElementById('tenant-input-rate-day').value;
      const rate = {};
      if (rateRpm !== '') rate.rpm = Number(rateRpm);
      if (rateConc !== '') rate.concurrent = Number(rateConc);
      if (rateDay !== '') rate.dayRequests = Number(rateDay);

      // Loop limits
      const loopMode = document.getElementById('tenant-input-loop-mode').value;
      const loopMaxReq = document.getElementById('tenant-input-loop-maxReq').value;
      const loopReqWin = document.getElementById('tenant-input-loop-reqWindowSec').value;
      const loopMaxTok = document.getElementById('tenant-input-loop-maxTokens').value;
      const loopTokWin = document.getElementById('tenant-input-loop-tokenWindowSec').value;
      const loopMaxRep = document.getElementById('tenant-input-loop-maxRepeat').value;
      const loopBlock = document.getElementById('tenant-input-loop-blockSec').value;
      const loop = {};
      if (loopMode !== '') loop.mode = loopMode;
      if (loopMaxReq !== '') loop.maxReq = Number(loopMaxReq);
      if (loopReqWin !== '') loop.reqWindowSec = Number(loopReqWin);
      if (loopMaxTok !== '') loop.maxTokens = Number(loopMaxTok);
      if (loopTokWin !== '') loop.tokenWindowSec = Number(loopTokWin);
      if (loopMaxRep !== '') loop.maxRepeat = Number(loopMaxRep);
      if (loopBlock !== '') loop.blockSec = Number(loopBlock);

      // MiniMax limits
      const mmDay = document.getElementById('tenant-input-minimax-day').value;
      const mmHour = document.getElementById('tenant-input-minimax-hour').value;
      const mmUserDay = document.getElementById('tenant-input-minimax-user-day').value;
      const mmUserHour = document.getElementById('tenant-input-minimax-user-hour').value;
      const mmDayShare = document.getElementById('tenant-input-minimax-dayShare').value;
      const mmHourShare = document.getElementById('tenant-input-minimax-hourShare').value;
      const minimax = {};
      if (mmDay !== '') minimax.day = Number(mmDay);
      if (mmHour !== '') minimax.hour = Number(mmHour);
      if (mmUserDay !== '' || mmUserHour !== '') {
        minimax.user = {};
        if (mmUserDay !== '') minimax.user.day = Number(mmUserDay);
        if (mmUserHour !== '') minimax.user.hour = Number(mmUserHour);
      }
      if (mmDayShare !== '' || mmHourShare !== '') {
        minimax.quotaMax = {};
        if (mmDayShare !== '') minimax.quotaMax.dayShare = Number(mmDayShare);
        if (mmHourShare !== '') minimax.quotaMax.hourShare = Number(mmHourShare);
      }

      // Agents JSON
      let agents;
      const agentsRaw = document.getElementById('tenant-input-agents-json').value.trim();
      if (agentsRaw) {
        try {
          agents = JSON.parse(agentsRaw);
        } catch (e) {
          errBox.textContent = 'Ошибка в JSON "limits.agents": ' + e.message;
          errBox.style.display = 'block';
          return;
        }
      }

      const limits = {};
      if (Object.keys(rate).length > 0) limits.rate = rate;
      if (Object.keys(loop).length > 0) limits.loop = loop;
      if (Object.keys(minimax).length > 0) limits.minimax = minimax;
      if (agents) limits.agents = agents;
      if (Object.keys(limits).length > 0) body.limits = limits;

      // Notify
      const emailRaw = document.getElementById('tenant-input-notify-email').value.trim();
      const tgRaw = document.getElementById('tenant-input-notify-telegram').value.trim();
      const langRaw = document.getElementById('tenant-input-notify-lang').value;
      const notify = {};
      if (emailRaw) notify.email = emailRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (tgRaw) notify.telegram = tgRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (langRaw) notify.lang = langRaw;
      if (Object.keys(notify).length > 0) body.notify = notify;

      try {
        const res = await fetch('/admin/api/tenants/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = data.error?.errors ? data.error.errors.join('\\n') : (data.error?.message || 'Ошибка сохранения');
          errBox.textContent = msg;
          errBox.style.display = 'block';
          return;
        }

        closeTenantDrawer();
        await loadTenantsTable();
      } catch (err) {
        errBox.textContent = 'Сетевая ошибка: ' + err.message;
        errBox.style.display = 'block';
      }
    }

    async function mintCurrentTenantToken(rotate) {
      const id = document.getElementById('tenant-input-id').value.trim();
      if (!id) return;

      if (rotate) {
        if (!confirm('Перевыпуск токена сделает недействительными все ранее выпущенные токены этого клиента. Продолжить?')) {
          return;
        }
      }

      const tokenBox = document.getElementById('tenant-token-display-box');
      const tokenInput = document.getElementById('minted-token-val');
      const errBox = document.getElementById('tenant-form-error');
      errBox.style.display = 'none';

      try {
        const res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rotate }),
        });
        const data = await res.json();
        if (!res.ok) {
          errBox.textContent = data.error?.message || 'Ошибка выпуска токена';
          errBox.style.display = 'block';
          return;
        }

        tokenInput.value = data.token;
        tokenBox.style.display = 'block';
        await loadTenantsTable();
      } catch (err) {
        errBox.textContent = 'Ошибка выпуска токена: ' + err.message;
        errBox.style.display = 'block';
      }
    }

    function copyMintedToken() {
      const tokenInput = document.getElementById('minted-token-val');
      tokenInput.select();
      navigator.clipboard.writeText(tokenInput.value).then(() => {
        const btn = document.getElementById('btn-copy-minted-token');
        const orig = btn.textContent;
        btn.textContent = 'Скопировано!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    }

    async function unblockCurrentTenant() {
      const id = document.getElementById('tenant-input-id').value.trim();
      if (!id) return;
      try {
        const res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/unblock', {
          method: 'POST',
        });
        const data = await res.json();
        alert('Блокировок сессий Loop Guard снято: ' + (data.cleared ?? 0));
      } catch (err) {
        alert('Ошибка при снятии блокировок: ' + err.message);
      }
    }

    async function deleteCurrentTenant() {
      const id = document.getElementById('tenant-input-id').value.trim();
      if (!id) return;
      if (!confirm('Удалить клиента "' + id + '" из реестра?')) return;

      try {
        let res = await fetch('/admin/api/tenants/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.status === 409) {
          const data = await res.json();
          if (confirm(data.error?.message + '\\nУдалить принудительно?')) {
            res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '?force=1', { method: 'DELETE' });
          } else {
            return;
          }
        }
        if (!res.ok) {
          const data = await res.json();
          alert(data.error?.message || 'Ошибка удаления');
          return;
        }
        closeTenantDrawer();
        await loadTenantsTable();
      } catch (err) {
        alert('Ошибка удаления: ' + err.message);
      }
    }

    async function loadTenantPools(tenantId) {
      const id = tenantId || currentEditingTenantId;
      const tbody = document.getElementById('tenant-pools-table-body');
      if (!tbody) return;
      if (!id) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Сохраните клиента для просмотра моделей</td></tr>';
        return;
      }

      try {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Загрузка моделей...</td></tr>';
        const res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/pools');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--danger);">' + escTenant(err.error?.message || ('Ошибка: ' + res.status)) + '</td></tr>';
          return;
        }
        const data = await res.json();
        const poolItems = Array.isArray(data.pools)
          ? data.pools
          : Object.entries(data.pools || {}).map(function(p) { return { route: p[0], entries: p[1] }; });
        if (poolItems.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Нет маршрутов или моделей</td></tr>';
          return;
        }

        let rowsHtml = '';
        for (const item of poolItems) {
          const route = item.route;
          const entries = item.entries || [];
          if (entries.length === 0) {
            rowsHtml += '<tr>' +
              '<td><code>' + escTenant(route) + '</code></td>' +
              '<td colspan="4" style="color: var(--text-muted); font-style: italic;">(пул пуст)</td>' +
              '</tr>';
          } else {
            for (const e of entries) {
              const ruleStr = e.fromRule ? ('правило: ' + escTenant(e.fromRule)) : 'ручной';
              const admStatus = e.admission?.status || '—';
              const admBadge = admStatus === 'admitted'
                ? '<span class="badge badge-success">admitted</span>'
                : (admStatus === 'rejected' ? '<span class="badge badge-danger">rejected</span>' : '<span class="badge badge-neutral">' + escTenant(admStatus) + '</span>');
              const coolStr = e.cooling ? '<span class="badge badge-warning">охлаждается</span>' : '<span style="color: var(--text-muted);">нет</span>';

              rowsHtml += '<tr>' +
                '<td><code>' + escTenant(route) + '</code></td>' +
                '<td><strong>' + escTenant(e.model) + '</strong></td>' +
                '<td style="font-size: 10px; color: var(--text-muted);">' + ruleStr + '</td>' +
                '<td>' + admBadge + '</td>' +
                '<td>' + coolStr + '</td>' +
                '</tr>';
            }
          }
        }
        tbody.innerHTML = rowsHtml;
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--danger);">Ошибка загрузки: ' + escTenant(e.message) + '</td></tr>';
      }
    }

    async function handleSaveOllamaKey() {
      const id = currentEditingTenantId;
      const msg = document.getElementById('tenant-ollama-key-msg');
      if (!id) {
        if (msg) {
          msg.textContent = 'Сначала сохраните клиента';
          msg.style.color = 'var(--danger)';
          msg.style.display = 'block';
        }
        return;
      }
      const keyInput = document.getElementById('tenant-input-ollama-key');
      const key = keyInput ? keyInput.value.trim() : '';
      if (!key) {
        if (msg) {
          msg.textContent = 'Введите ключ Ollama Cloud';
          msg.style.color = 'var(--danger)';
          msg.style.display = 'block';
        }
        return;
      }

      if (msg) {
        msg.textContent = 'Проверка ключа через Ollama API...';
        msg.style.color = 'var(--text-muted)';
        msg.style.display = 'block';
      }

      try {
        const res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/keys/ollama-cloud', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (!res.ok) {
          if (msg) {
            msg.textContent = data.error?.message || 'Ошибка проверки ключа';
            msg.style.color = 'var(--danger)';
          }
          return;
        }

        if (msg) {
          msg.textContent = 'Ключ проверен и сохранен! Доступно моделей: ' + (data.models ?? 0);
          msg.style.color = 'var(--primary)';
        }
        if (keyInput) keyInput.value = '';

        await loadTenantsTable();
        const item = tenantsData.find((t) => t.id === id);
        const rec = item?.record;
        const k = rec?.upstreamKeys && rec.upstreamKeys['ollama-cloud'];
        const ollamaBadge = document.getElementById('tenant-ollama-key-badge');
        const ollamaDetails = document.getElementById('tenant-ollama-key-details');
        const btnDeleteKey = document.getElementById('btn-delete-ollama-key');
        if (ollamaBadge) {
          ollamaBadge.className = 'badge badge-success';
          ollamaBadge.textContent = 'Подключен';
        }
        if (ollamaDetails) {
          ollamaDetails.textContent = k?.hint ? ('Хинт: ' + k.hint) : '';
        }
        if (btnDeleteKey) btnDeleteKey.style.display = 'inline-block';

        loadTenantPools(id);
      } catch (e) {
        if (msg) {
          msg.textContent = 'Сетевая ошибка: ' + e.message;
          msg.style.color = 'var(--danger)';
        }
      }
    }

    async function handleDeleteOllamaKey() {
      const id = currentEditingTenantId;
      if (!id) return;
      if (!confirm('Удалить ключ Ollama для клиента "' + id + '"?')) return;

      try {
        let res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/keys/ollama-cloud', {
          method: 'DELETE'
        });
        if (res.status === 409) {
          const data = await res.json();
          if (confirm(data.error?.message + '\\nОтключить клиента (disabled) и удалить ключ?')) {
            res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/keys/ollama-cloud?force=1', {
              method: 'DELETE'
            });
          } else {
            return;
          }
        }

        if (!res.ok) {
          const data = await res.json();
          alert(data.error?.message || 'Ошибка удаления ключа');
          return;
        }

        await loadTenantsTable();
        const ollamaBadge = document.getElementById('tenant-ollama-key-badge');
        const ollamaDetails = document.getElementById('tenant-ollama-key-details');
        const btnDeleteKey = document.getElementById('btn-delete-ollama-key');
        const msg = document.getElementById('tenant-ollama-key-msg');
        if (ollamaBadge) {
          ollamaBadge.className = 'badge badge-neutral';
          ollamaBadge.textContent = 'Не настроен';
        }
        if (ollamaDetails) ollamaDetails.textContent = '';
        if (btnDeleteKey) btnDeleteKey.style.display = 'none';
        if (msg) msg.style.display = 'none';

        loadTenantPools(id);
      } catch (e) {
        alert('Ошибка удаления ключа: ' + e.message);
      }
    }

    async function handleSaveOpenaiKey() {
      const id = currentEditingTenantId;
      const msg = document.getElementById('tenant-openai-key-msg');
      if (!id) {
        if (msg) {
          msg.textContent = 'Сначала сохраните клиента';
          msg.style.color = 'var(--danger)';
          msg.style.display = 'block';
        }
        return;
      }
      const keyInput = document.getElementById('tenant-input-openai-key');
      const key = keyInput ? keyInput.value.trim() : '';
      if (!key) {
        if (msg) {
          msg.textContent = 'Введите ключ OpenAI';
          msg.style.color = 'var(--danger)';
          msg.style.display = 'block';
        }
        return;
      }

      if (msg) {
        msg.textContent = 'Проверка ключа через OpenAI API...';
        msg.style.color = 'var(--text-muted)';
        msg.style.display = 'block';
      }

      try {
        const res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/keys/openai', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (!res.ok) {
          if (msg) {
            msg.textContent = data.error?.message || 'Ошибка проверки ключа';
            msg.style.color = 'var(--danger)';
          }
          return;
        }

        if (msg) {
          msg.textContent = 'Ключ проверен и сохранен! Доступно моделей: ' + (data.models ?? 0);
          msg.style.color = 'var(--primary)';
        }
        if (keyInput) keyInput.value = '';

        await loadTenantsTable();
        const item = tenantsData.find((t) => t.id === id);
        const rec = item?.record;
        const k = rec?.upstreamKeys && rec.upstreamKeys['openai'];
        const openaiBadge = document.getElementById('tenant-openai-key-badge');
        const openaiDetails = document.getElementById('tenant-openai-key-details');
        const btnDeleteKey = document.getElementById('btn-delete-openai-key');
        if (openaiBadge) {
          openaiBadge.className = 'badge badge-success';
          openaiBadge.textContent = 'Подключен';
        }
        if (openaiDetails) {
          openaiDetails.textContent = k?.hint ? ('Хинт: ' + k.hint) : '';
        }
        if (btnDeleteKey) btnDeleteKey.style.display = 'inline-block';

        loadTenantPools(id);
      } catch (e) {
        if (msg) {
          msg.textContent = 'Сетевая ошибка: ' + e.message;
          msg.style.color = 'var(--danger)';
        }
      }
    }

    async function handleDeleteOpenaiKey() {
      const id = currentEditingTenantId;
      if (!id) return;
      if (!confirm('Удалить ключ OpenAI для клиента "' + id + '"?')) return;

      try {
        let res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/keys/openai', {
          method: 'DELETE'
        });
        if (res.status === 409) {
          const data = await res.json();
          if (confirm(data.error?.message + '\\nОтключить клиента (disabled) и удалить ключ?')) {
            res = await fetch('/admin/api/tenants/' + encodeURIComponent(id) + '/keys/openai?force=1', {
              method: 'DELETE'
            });
          } else {
            return;
          }
        }

        if (!res.ok) {
          const data = await res.json();
          alert(data.error?.message || 'Ошибка удаления ключа');
          return;
        }

        await loadTenantsTable();
        const openaiBadge = document.getElementById('tenant-openai-key-badge');
        const openaiDetails = document.getElementById('tenant-openai-key-details');
        const btnDeleteKey = document.getElementById('btn-delete-openai-key');
        const msg = document.getElementById('tenant-openai-key-msg');
        if (openaiBadge) {
          openaiBadge.className = 'badge badge-neutral';
          openaiBadge.textContent = 'Не настроен';
        }
        if (openaiDetails) openaiDetails.textContent = '';
        if (btnDeleteKey) btnDeleteKey.style.display = 'none';
        if (msg) msg.style.display = 'none';

        loadTenantPools(id);
      } catch (e) {
        alert('Ошибка удаления ключа: ' + e.message);
      }
    }

    async function loadNotificationsView() {
      const tbody = document.getElementById('notifications-table-body');
      const badgeEmail = document.getElementById('notify-status-email');
      const badgeTg = document.getElementById('notify-status-telegram');
      const recEmail = document.getElementById('notify-recipients-email');
      const recTg = document.getElementById('notify-recipients-telegram');

      try {
        const res = await fetch('/admin/api/notifications?limit=50');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json();

        if (badgeEmail) {
          const isCfg = data.transports && data.transports.email === 'configured';
          badgeEmail.className = 'badge ' + (isCfg ? 'badge-success' : 'badge-neutral');
          badgeEmail.textContent = isCfg ? 'настроен' : 'не настроен';
        }
        if (recEmail) {
          const emails = (data.admin && data.admin.email && data.admin.email.length > 0) ? data.admin.email.join(', ') : 'не указаны';
          recEmail.textContent = emails;
        }

        if (badgeTg) {
          const isCfg = data.transports && data.transports.telegram === 'configured';
          badgeTg.className = 'badge ' + (isCfg ? 'badge-success' : 'badge-neutral');
          badgeTg.textContent = isCfg ? 'настроен' : 'не настроен';
        }
        if (recTg) {
          const tgChats = (data.admin && data.admin.telegram && data.admin.telegram.length > 0) ? data.admin.telegram.join(', ') : 'не указаны';
          recTg.textContent = tgChats;
        }

        const deliveries = data.deliveries || data.notifications || [];
        if (tbody) {
          if (deliveries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Нет записей о доставке</td></tr>';
            return;
          }

          tbody.innerHTML = deliveries.map(function(d) {
            const timeStr = d.ts ? d.ts.replace('T', ' ').slice(0, 19) : '—';
            const tid = d.tenantId ? escTenant(d.tenantId) : '—';
            const typeStr = escTenant(d.type || '—');
            const chStr = escTenant(d.channel || '—');
            const toStr = escTenant(d.to || '—');
            const statusBadge = d.ok
              ? '<span class="badge badge-success">OK</span>'
              : '<span class="badge badge-danger">Ошибка</span>';
            const errStr = d.error ? escTenant(d.error) : '—';

            return '<tr>' +
              '<td style="white-space: nowrap; font-size: 11px; font-family: monospace;">' + escTenant(timeStr) + '</td>' +
              '<td><strong>' + tid + '</strong></td>' +
              '<td><code>' + typeStr + '</code></td>' +
              '<td>' + chStr + '</td>' +
              '<td style="font-family: monospace;">' + toStr + '</td>' +
              '<td>' + statusBadge + '</td>' +
              '<td style="font-size: 12px; color: var(--text-muted); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + errStr + '">' + errStr + '</td>' +
            '</tr>';
          }).join('');
        }
      } catch (err) {
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--danger);">Ошибка загрузки: ' + escTenant(err.message) + '</td></tr>';
        }
      }
    }

    async function handleSendTestNotification() {
      const btn = document.getElementById('btn-send-test-notify');
      const resultDiv = document.getElementById('notify-test-result');
      if (btn) btn.disabled = true;
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = 'rgba(255, 255, 255, 0.05)';
        resultDiv.style.border = '1px solid var(--border)';
        resultDiv.style.color = 'var(--text-muted)';
        resultDiv.textContent = 'Отправка тестового уведомления...';
      }

      try {
        const res = await fetch('/admin/api/notify-test', { method: 'POST' });
        const data = await res.json().catch(function() { return {}; });
        if (!res.ok || data.ok === false) {
          const msg = data.error || ('HTTP ' + res.status);
          if (resultDiv) {
            resultDiv.style.background = 'rgba(239, 68, 68, 0.12)';
            resultDiv.style.border = '1px solid var(--danger)';
            resultDiv.style.color = 'var(--danger)';
            resultDiv.textContent = 'Ошибка отправки: ' + msg;
          }
        } else {
          if (resultDiv) {
            resultDiv.style.background = 'rgba(16, 185, 129, 0.12)';
            resultDiv.style.border = '1px solid #10b981';
            resultDiv.style.color = '#10b981';
            resultDiv.textContent = 'Тестовое уведомление успешно отправлено!';
          }
        }
      } catch (err) {
        if (resultDiv) {
          resultDiv.style.background = 'rgba(239, 68, 68, 0.12)';
          resultDiv.style.border = '1px solid var(--danger)';
          resultDiv.style.color = 'var(--danger)';
          resultDiv.textContent = 'Ошибка отправки: ' + err.message;
        }
      } finally {
        if (btn) btn.disabled = false;
        loadNotificationsView();
      }
    }

    async function loadCatalogView() {
      const rulesTbody = document.getElementById('catalog-rules-table-body');
      const catContainer = document.getElementById('catalogs-container');
      try {
        const res = await fetch('/admin/api/catalog');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json();
        const rules = data.rules || [];
        const catalogs = data.catalogs || [];

        if (rules.length === 0) {
          rulesTbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Нет настроенных правил</td></tr>';
        } else {
          rulesTbody.innerHTML = rules.map((r) => {
            const preferStr = (r.prefer || []).join(', ');
            const needStr = r.need && r.need.length ? ' · need: ' + r.need.join(', ') : '';
            const minCtxStr = r.minContext ? ' · minContext: ' + r.minContext : '';
            const resolvedBadges = (r.resolved && r.resolved.length > 0)
              ? r.resolved.map((m) => '<span class="badge badge-success">' + escTenant(m) + '</span>').join(' ')
              : '<span class="badge badge-danger">нет подходящих моделей</span>';

            return '<tr>' +
              '<td><strong>' + escTenant(r.route) + '</strong></td>' +
              '<td><strong>' + escTenant(r.ruleId) + '</strong><br><small style="color: var(--text-muted);">prefer: [' + escTenant(preferStr) + ']' + escTenant(needStr) + escTenant(minCtxStr) + '</small></td>' +
              '<td>' + resolvedBadges + '</td>' +
            '</tr>';
          }).join('');
        }

        if (catalogs.length === 0) {
          catContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Каталоги не найдены</div>';
          return;
        }

        catContainer.innerHTML = catalogs.map((cat) => {
          const catId = cat.id || (cat.provider + '-' + cat.fp);
          const modelsObj = cat.models || {};
          const modelEntries = Object.entries(modelsObj);
          const dateStr = cat.fetchedAt ? new Date(cat.fetchedAt).toLocaleString('ru') : '—';
          const headerHtml = '<div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">' +
            '<span>Провайдер: <strong>' + escTenant(cat.provider) + '</strong> (' + escTenant(cat.baseUrl) + ') · FP: <code>' + escTenant(cat.fp) + '</code></span>' +
            '<span style="font-size: 11px; color: var(--text-muted);">Обновлен: ' + escTenant(dateStr) + '</span>' +
          '</div>';

          let rowsHtml = '';
          if (modelEntries.length === 0) {
            rowsHtml = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Моделей в каталоге нет</td></tr>';
          } else {
            rowsHtml = modelEntries.map(([mId, m]) => {
              const capsStr = (m.capabilities && m.capabilities.length) ? m.capabilities.join(', ') : '—';
              const ctxStr = m.contextLength ? Number(m.contextLength).toLocaleString('ru') : '—';
              const firstSeenStr = m.firstSeen ? new Date(m.firstSeen).toLocaleDateString('ru') : (m.created ? new Date(m.created * 1000).toLocaleDateString('ru') : '—');

              let admissionBadge = '—';
              if (m.admission) {
                if (m.admission.status === 'admitted') {
                  admissionBadge = '<span class="badge badge-success">admitted</span>';
                } else if (m.admission.status === 'pending') {
                  admissionBadge = '<span class="badge badge-warning">pending</span>';
                } else if (m.admission.status === 'rejected') {
                  const reasonText = m.admission.reason || '';
                  admissionBadge = '<span class="badge badge-danger" title="' + escTenant(reasonText) + '">rejected</span>';
                }
              }

              const missingStr = m.missingSince ? '<span class="badge badge-danger">' + new Date(m.missingSince).toLocaleDateString('ru') + '</span>' : '—';

              let manualBadge = '—';
              if (m.manual === 'admit') {
                manualBadge = '<span class="badge badge-success">Допуск</span>';
              } else if (m.manual === 'block') {
                manualBadge = '<span class="badge badge-danger">Блок</span>';
              }

              const actionsHtml = '<button type="button" class="btn" style="padding: 2px 6px; font-size: 11px; margin-right: 4px;" data-cat="' + escTenant(catId) + '" data-model="' + escTenant(mId) + '" data-action="admit" onclick="handleModelAction(this)">Допуск</button>' +
                '<button type="button" class="btn" style="padding: 2px 6px; font-size: 11px; margin-right: 4px;" data-cat="' + escTenant(catId) + '" data-model="' + escTenant(mId) + '" data-action="block" onclick="handleModelAction(this)">Блок</button>' +
                '<button type="button" class="btn" style="padding: 2px 6px; font-size: 11px;" data-cat="' + escTenant(catId) + '" data-model="' + escTenant(mId) + '" data-action="reset" onclick="handleModelAction(this)">Сброс</button>';

              return '<tr>' +
                '<td><strong>' + escTenant(mId) + '</strong></td>' +
                '<td>' + escTenant(capsStr) + '</td>' +
                '<td>' + escTenant(ctxStr) + '</td>' +
                '<td>' + escTenant(firstSeenStr) + '</td>' +
                '<td>' + admissionBadge + '</td>' +
                '<td>' + missingStr + '</td>' +
                '<td>' + manualBadge + '</td>' +
                '<td>' + actionsHtml + '</td>' +
              '</tr>';
            }).join('');
          }

          return '<div class="card" style="margin-bottom: 24px;">' +
            headerHtml +
            '<div class="table-scroll">' +
              '<table class="table" style="width: 100%; border-collapse: collapse;">' +
                '<thead>' +
                  '<tr>' +
                    '<th>Модель</th>' +
                    '<th>Возможности</th>' +
                    '<th>Контекст</th>' +
                    '<th>Дата появления</th>' +
                    '<th>Статус допуска</th>' +
                    '<th>Пропала с</th>' +
                    '<th>Ручное решение</th>' +
                    '<th>Действия</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody>' + rowsHtml + '</tbody>' +
              '</table>' +
            '</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        rulesTbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--danger);">Ошибка загрузки правил: ' + escTenant(err.message || err) + '</td></tr>';
        catContainer.innerHTML = '<div style="color: var(--danger); font-size: 13px;">Ошибка загрузки каталогов: ' + escTenant(err.message || err) + '</div>';
      }
    }

    async function handleModelAction(btn) {
      const cat = btn.dataset.cat;
      const model = btn.dataset.model;
      const action = btn.dataset.action;
      try {
        const res = await fetch('/admin/api/catalog/' + encodeURIComponent(cat) + '/models/' + encodeURIComponent(model) + '/' + action, {
          method: 'POST',
        });
        if (!res.ok) {
          alert('Ошибка при выполнении действия (' + res.status + ')');
          return;
        }
        loadCatalogView();
      } catch (err) {
        alert('Ошибка сети: ' + (err.message || err));
      }
    }

    async function handleRefreshCatalog() {
      const btn = document.getElementById('btn-refresh-catalog');
      const msg = document.getElementById('catalog-refresh-message');
      btn.disabled = true;
      btn.innerText = 'Обновление...';
      msg.style.display = 'none';

      try {
        const res = await fetch('/admin/api/catalog/refresh', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        msg.style.display = 'block';
        msg.style.color = 'var(--success, #22c55e)';
        msg.innerText = 'Каталоги успешно обновлены (' + (data.refreshed ? data.refreshed.length : 0) + ' шт.)';
        loadCatalogView();
      } catch (err) {
        msg.style.display = 'block';
        msg.style.color = 'var(--danger, #ef4444)';
        msg.innerText = 'Ошибка обновления: ' + (err.message || err);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Обновить каталоги';
      }
    }

    let currentSelectedWatchReport = null;

    function getWatchLevelBadge(level) {
      if (level === 'crit') return '<span class="badge badge-danger">CRIT</span>';
      if (level === 'warn') return '<span class="badge badge-warning">WARN</span>';
      return '<span class="badge badge-success">OK</span>';
    }

    async function loadWatchReportsList() {
      const tbody = document.getElementById('watch-reports-table-body');
      if (!tbody) return;
      try {
        const res = await fetch('/admin/api/watch');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json();
        const reports = data.reports || [];

        if (reports.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Нет отчётов вотчера</td></tr>';
          return;
        }

        tbody.innerHTML = reports.map(function(r) {
          const isSelected = currentSelectedWatchReport === r.name;
          const bgStyle = isSelected ? 'background: rgba(255, 255, 255, 0.05);' : '';
          return '<tr style="cursor: pointer; ' + bgStyle + '" data-name="' + escTenant(r.name) + '" onclick="showWatchReportDetails(this.dataset.name)">' +
            '<td style="font-family: monospace; font-size: 12px;">' + escTenant(r.date || r.name.replace('.json', '')) + '</td>' +
            '<td>' + getWatchLevelBadge(r.level) + '</td>' +
            '<td>' + (r.signalsCount || 0) + '</td>' +
          '</tr>';
        }).join('');

        if (!currentSelectedWatchReport && reports.length > 0) {
          showWatchReportDetails(reports[0].name);
        }
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--danger);">Ошибка: ' + escTenant(err.message) + '</td></tr>';
      }
    }

    async function showWatchReportDetails(name) {
      currentSelectedWatchReport = name;
      const titleEl = document.getElementById('watch-report-title');
      const badgeEl = document.getElementById('watch-report-level-badge');
      const contentEl = document.getElementById('watch-report-content');
      if (!contentEl) return;

      contentEl.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Загрузка отчёта...</div>';

      try {
        const res = await fetch('/admin/api/watch/' + encodeURIComponent(name));
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json();
        const report = data.report;
        if (!report) throw new Error('Некорректный формат отчёта');

        if (titleEl) {
          const winStr = report.window ? (report.window.from === report.window.to ? report.window.from : report.window.from + ' — ' + report.window.to) : name;
          titleEl.textContent = 'Отчёт: ' + winStr;
        }
        if (badgeEl) {
          badgeEl.outerHTML = '<span id="watch-report-level-badge">' + getWatchLevelBadge(report.level) + '</span>';
        }

        let signalsHtml = '';
        if (!report.signals || report.signals.length === 0) {
          signalsHtml = '<div style="background: rgba(34, 197, 94, 0.1); border: 1px solid var(--success, #22c55e); color: var(--success, #22c55e); border-radius: 8px; padding: 12px 14px; margin-bottom: 20px; font-size: 13px;">' +
            '<strong>Все проверки пройдены:</strong> Сигналов нет, состояние системы в норме.' +
          '</div>';
        } else {
          signalsHtml = '<div style="margin-bottom: 20px;">' +
            '<h3 style="font-size: 14px; margin: 0 0 10px 0;">Сигналы (' + report.signals.length + ')</h3>' +
            '<div style="display: flex; flex-direction: column; gap: 10px;">' +
            report.signals.map(function(s) {
              const borderCol = s.level === 'crit' ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)';
              const bgCol = s.level === 'crit' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)';
              return '<div style="border-left: 3px solid ' + borderCol + '; background: ' + bgCol + '; padding: 10px 12px; border-radius: 0 6px 6px 0;">' +
                '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">' +
                  getWatchLevelBadge(s.level) +
                  '<strong style="font-size: 13px;">' + escTenant(s.title) + '</strong>' +
                '</div>' +
                '<div style="font-size: 12px; color: var(--text); line-height: 1.4; white-space: pre-wrap;">' + escTenant(s.details) + '</div>' +
              '</div>';
            }).join('') +
            '</div>' +
          '</div>';
        }

        const m = report.metrics || {};
        const cacheShareStr = m.cache && m.cache.share != null ? (m.cache.share * 100).toFixed(1) + '%' : '—';
        const cacheBaselineStr = m.cache && m.cache.baselineShare != null ? (m.cache.baselineShare * 100).toFixed(1) + '%' : '—';
        const weeklyPctStr = m.quota && m.quota.weeklyRemainingPct != null ? m.quota.weeklyRemainingPct + '%' : '—';
        const intervalLowStr = m.quota ? String(m.quota.intervalLowCount || 0) : '0';
        const gateHitsStr = m.quota ? String(m.quota.providerQuotaHits || 0) : '0';
        const calibStr = m.calibration && m.calibration.tokensPerPct != null ? Math.round(m.calibration.tokensPerPct).toLocaleString('ru-RU') + ' т/1%' : '—';
        const errRateStr = m.errors ? (m.errors.errorRate * 100).toFixed(2) + '%' : '0%';
        const fallbackRateStr = m.errors ? (m.errors.fallbackRate * 100).toFixed(2) + '%' : '0%';
        const loopBlocksStr = m.errors ? String(m.errors.loopDetectedCount || 0) : '0';
        const notifySentStr = m.notifications ? String(m.notifications.sent || 0) : '0';
        const notifyFailedStr = m.notifications ? String(m.notifications.failed || 0) : '0';

        let topTenantsHtml = '<div style="color: var(--text-muted); font-size: 12px;">Нет данных о трафике MiniMax</div>';
        if (m.cache && m.cache.tenants && m.cache.tenants.length > 0) {
          topTenantsHtml = '<table class="table" style="width: 100%; font-size: 12px; margin-top: 6px;">' +
            '<thead><tr><th>Клиент</th><th>Промпт токены</th><th>Кэш токены</th><th>Доля кэша</th></tr></thead>' +
            '<tbody>' +
            m.cache.tenants.slice(0, 10).map(function(t) {
              const pct = (t.share * 100).toFixed(1) + '%';
              return '<tr>' +
                '<td><strong>' + escTenant(t.tenant) + '</strong></td>' +
                '<td>' + Number(t.promptTokens || 0).toLocaleString('ru-RU') + '</td>' +
                '<td>' + Number(t.cachedTokens || 0).toLocaleString('ru-RU') + '</td>' +
                '<td>' + pct + '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';
        }

        const metricsHtml = '<div>' +
          '<h3 style="font-size: 14px; margin: 0 0 12px 0;">Ключевые метрики окна</h3>' +
          '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px;">' +
            '<div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">' +
              '<div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;">Кэш MiniMax</div>' +
              '<div style="font-size: 18px; font-weight: 700;">' + cacheShareStr + '</div>' +
              '<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Базовый 7д: ' + cacheBaselineStr + '</div>' +
            '</div>' +
            '<div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">' +
              '<div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;">Квота MiniMax</div>' +
              '<div style="font-size: 18px; font-weight: 700;">' + weeklyPctStr + '</div>' +
              '<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Низких окон: ' + intervalLowStr + ' | Gate hits: ' + gateHitsStr + '</div>' +
            '</div>' +
            '<div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">' +
              '<div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;">Калибровка квоты</div>' +
              '<div style="font-size: 18px; font-weight: 700;">' + calibStr + '</div>' +
              '<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Окон: ' + (m.calibration ? m.calibration.intervalsSampled : 0) + ' (Δ ' + (m.calibration ? m.calibration.deltaPctSum : 0) + '%)</div>' +
            '</div>' +
            '<div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">' +
              '<div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;">Ошибки и фолбэки</div>' +
              '<div style="font-size: 18px; font-weight: 700;">' + errRateStr + '</div>' +
              '<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Фолбэк: ' + fallbackRateStr + ' | Loop: ' + loopBlocksStr + '</div>' +
            '</div>' +
            '<div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">' +
              '<div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;">Уведомления</div>' +
              '<div style="font-size: 18px; font-weight: 700;">' + notifySentStr + ' / ' + notifyFailedStr + '</div>' +
              '<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Отправлено / Ошибок</div>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top: 14px;">' +
            '<h4 style="font-size: 13px; margin: 0 0 6px 0;">Топ клиенты по трафику MiniMax:</h4>' +
            topTenantsHtml +
          '</div>' +
        '</div>';

        contentEl.innerHTML = signalsHtml + metricsHtml;
      } catch (err) {
        contentEl.innerHTML = '<div style="color: var(--danger);">Ошибка загрузки деталей: ' + escTenant(err.message) + '</div>';
      }
    }

    async function handleRunWatch(notify) {
      const btnRun = document.getElementById('btn-watch-run');
      const btnRunNotify = document.getElementById('btn-watch-run-notify');
      const msgEl = document.getElementById('watch-run-message');
      if (btnRun) btnRun.disabled = true;
      if (btnRunNotify) btnRunNotify.disabled = true;
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.background = 'rgba(255, 255, 255, 0.05)';
        msgEl.style.border = '1px solid var(--border)';
        msgEl.style.color = 'var(--text)';
        msgEl.textContent = 'Запуск ночного вотчера (расчёт за последние 24 часа)...';
      }

      try {
        const res = await fetch('/admin/api/watch/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notify: !!notify })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const report = data.report;
        if (msgEl) {
          const sigCount = report.signals ? report.signals.length : 0;
          let text = 'Проверка завершена. Уровень: ' + (report.level || 'ok').toUpperCase() + ', сигналов: ' + sigCount + '.';
          if (notify) {
            text += sigCount > 0 ? ' Письмо отправлено администратору.' : ' Сигналов нет, отправка письма пропущена.';
          }
          msgEl.style.background = report.level === 'crit' ? 'rgba(239, 68, 68, 0.15)' : (report.level === 'warn' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(34, 197, 94, 0.15)');
          msgEl.style.color = report.level === 'crit' ? 'var(--danger)' : (report.level === 'warn' ? 'var(--warning)' : 'var(--success)');
          msgEl.textContent = text;
        }
        await loadWatchReportsList();
      } catch (err) {
        if (msgEl) {
          msgEl.style.background = 'rgba(239, 68, 68, 0.15)';
          msgEl.style.color = 'var(--danger)';
          msgEl.textContent = 'Ошибка выполнения вотчера: ' + err.message;
        }
      } finally {
        if (btnRun) btnRun.disabled = false;
        if (btnRunNotify) btnRunNotify.disabled = false;
      }
    }

    // Initialize
    window.addEventListener('DOMContentLoaded', () => {
      parseUrlParams();
      initListeners();
      if (window.location.hash === '#tenants') {
        switchMainTab('tenants');
      } else if (window.location.hash === '#notifications') {
        switchMainTab('notifications');
      } else if (window.location.hash === '#catalog') {
        switchMainTab('catalog');
      } else if (window.location.hash === '#watch') {
        switchMainTab('watch');
      } else {
        loadBudget();
        loadClients();
        loadSummary();
        loadRequests(true);
      }
    });
  </script>
</body>
</html>`;
}
