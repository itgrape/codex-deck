import { imChannels, createImConfig } from "/im-config.js";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (value, timeZone) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone })
    : "—";
const labels = {
  overview: "概览",
  chat: "Codex 会话",
  workspaces: "工作目录",
  im: "IM 通信",
  skills: "Skills",
  mcp: "MCP 服务",
  jobs: "定时任务",
  config: "配置管理",
};
const state = {
  page: "overview",
  workspaces: [],
  status: {},
  jobs: [],
  skills: [],
  config: null,
  ws: null,
  requests: new Map(),
  sequence: 0,
  ready: false,
  workspaceId: "",
  threads: [],
  threadId: "",
  turnId: "",
  messages: [],
  approvals: new Map(),
  events: [],
  busy: false,
};
let toastTimer,
  pageSequence = 0;
async function api(path, method = "GET", value) {
  const binary = value instanceof Blob;
  const response = await fetch(`/api${path}`, {
    method,
    headers:
      value === undefined
        ? {}
        : { "Content-Type": binary ? "application/zip" : "application/json" },
    body:
      value === undefined ? undefined : binary ? value : JSON.stringify(value),
  });
  const data = await response.json();
  if (response.status === 401 && path !== "/session") showLogin();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 4500);
}
function showLogin() {
  $("#login").hidden = false;
  $("#shell").hidden = true;
  disconnect();
}
function heading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function empty(title, description, action = "") {
  return `<div class="empty"><div class="empty-icon">▱</div><h3>${title}</h3><p>${description}</p>${action}</div>`;
}
function badge(text, color = "") {
  return `<span class="badge ${color}">${escape(text)}</span>`;
}
function modal(title, content, onSubmit, wide = false) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = content;
  $("#modal").classList.toggle("wide", wide);
  const form = $("form", $("#modal-body"));
  if (form && onSubmit)
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = $("button[type=submit]", form);
      button.disabled = true;
      try {
        await onSubmit(new FormData(form), form);
        $("#modal").close();
      } catch (e) {
        let error = $(".dialog-error", form);
        if (!error) {
          error = document.createElement("div");
          error.className = "dialog-error";
          form.append(error);
        }
        error.textContent = e.message;
      } finally {
        button.disabled = false;
      }
    });
  $("#modal").showModal();
}
const actions = (label = "保存") =>
  `<div class="form-actions"><button type="button" data-close>取消</button><button type="submit" class="primary">${label}</button></div>`;
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) $("#modal").close();
  if (e.target.closest("[data-add-env]"))
    $("#job-env").insertAdjacentHTML("beforeend", environmentRow());
  if (e.target.closest("[data-remove-env]"))
    e.target.closest(".env-row").remove();
});
$("#menu").onclick = () => $(".sidebar").classList.toggle("open");
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = $("button", e.target);
  button.disabled = true;
  try {
    await api("/session", "POST", {
      token: new FormData(e.target).get("token"),
    });
    e.target.reset();
    $("#login-error").textContent = "";
    await boot();
  } catch (e) {
    $("#login-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
function closeAccountMenu() {
  $("#account-popover").hidden = true;
  $("#account-toggle").setAttribute("aria-expanded", "false");
}
$("#account-toggle").onclick = () => {
  const open = $("#account-popover").hidden;
  $("#account-popover").hidden = !open;
  $("#account-toggle").setAttribute("aria-expanded", String(open));
};
document.addEventListener("click", (event) => {
  if (!event.target.closest(".account-menu")) closeAccountMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#account-popover").hidden) {
    closeAccountMenu();
    $("#account-toggle").focus();
  }
});
$("#logout").onclick = async () => {
  try {
    await api("/session", "DELETE");
    closeAccountMenu();
    showLogin();
  } catch (error) {
    toast(error.message);
  }
};
async function boot() {
  try {
    [state.status, state.workspaces] = await Promise.all([
      api("/status"),
      api("/workspaces"),
    ]);
    $("#login").hidden = true;
    $("#shell").hidden = false;
    if (!state.workspaceId) state.workspaceId = state.workspaces[0]?.id || "";
    await navigate();
  } catch (e) {
    if ($("#login").hidden) toast(e.message);
  }
}
window.addEventListener("hashchange", () =>
  navigate().catch((e) => toast(e.message)),
);
async function navigate() {
  if ($("#shell").hidden) return;
  state.page =
    location.hash.slice(1) in labels ? location.hash.slice(1) : "overview";
  $(".sidebar").classList.remove("open");
  for (const a of $$("nav a"))
    a.classList.toggle("active", a.dataset.page === state.page);
  $("#crumb").textContent = labels[state.page];
  const sequence = ++pageSequence;
  $("#content").innerHTML = '<div class="loading">正在加载…</div>';
  // Ignore stale navigation renders after rapid tab changes.
  const html = await {
    overview,
    workspaces,
    skills,
    mcp,
    jobs,
    config,
    im,
    chat,
  }[state.page]();
  if (sequence !== pageSequence) return;
  $("#content").innerHTML = html;
  bindPage();
}
async function overview() {
  [state.status, state.workspaces, state.jobs] = await Promise.all([
    api("/status"),
    api("/workspaces"),
    api("/jobs"),
  ]);
  const runs = await api("/runs");
  const stats = [
    ["工作目录", state.workspaces.length, "你的项目，都在这里", "▱"],
    ["Codex 连接", state.status.connections, "原生 App Server 连接", "◷"],
    [
      "定时任务",
      state.jobs.length,
      `${state.status.runningJobs} 个任务正在执行`,
      "◴",
    ],
    [
      "IM 桥接",
      state.status.bridge.running ? "运行中" : "未启动",
      "连接你常用的消息平台",
      "↔",
    ],
  ];
  return (
    heading(
      "一切就绪，开始工作。",
      "管理你的项目、能力与连接，专注手头的创造。",
      '<button class="primary" data-action="new-conversation">＋ 新建会话</button>',
    ) +
    `<section class="welcome"><div><h2>你的 Codex 工作台。</h2><p>从项目开发到日常自动化，在一个地方有序完成。<br>熟悉的原生能力，随时连接的工作方式。</p><div class="welcome-actions"><button class="primary" data-action="new-conversation">开始一个新任务</button><a class="button-link" href="#workspaces">管理工作目录</a></div></div><div class="deck-illustration" aria-hidden="true"><span></span><span></span><span>›_</span></div></section>
    <div class="stats">${stats.map(([title, number, meta, glyph], i) => `<article class="stat"><div class="stat-top"><span class="stat-label">${title}</span><span class="stat-glyph stat-glyph-${i}">${glyph}</span></div><strong class="stat-number">${escape(number)}</strong><span class="stat-meta">${meta}</span></article>`).join("")}</div>
    <div class="overview-columns"><div><section class="workspace-section"><div class="section-heading"><h2>工作目录 ${badge(state.workspaces.length)}</h2><a href="#workspaces">全部目录</a></div>${
      state.workspaces.length
        ? `<div class="workspace-cards">${state.workspaces
            .slice(0, 4)
            .map((w) => workspaceCard(w))
            .join("")}</div>`
        : `<div class="panel">${empty("从你的第一个项目开始", "登记已有目录，或为下一个想法创建新的空间。", '<button data-action="new-workspace">添加工作目录</button>')}</div>`
    }</section><section class="panel"><div class="panel-head"><h2>最近执行</h2><a href="#jobs"><small>全部任务</small></a></div>${runs.length ? runs.slice(0, 4).map(runRow).join("") : empty("还没有任务记录", "把重复工作交给定时任务，执行结果会保存在这里。")}</section></div><aside><section class="panel"><div class="panel-head"><h2>快速配置</h2><span class="subtle-icon">✧</span></div><div class="quick-links"><a href="#skills"><span class="quick-icon">✳</span><span><strong>扩展你的能力</strong><small>上传技能包，定义你的工作方法</small></span></a><a href="#im"><span class="quick-icon mint">↔</span><span><strong>让消息触达你</strong><small>连接 QQ、微信、飞书等渠道</small></span></a><a href="#jobs"><span class="quick-icon peach">◴</span><span><strong>把重复交给自动化</strong><small>创建你的下一个定时任务</small></span></a></div></section><section class="panel"><div class="panel-head"><h2>运行环境</h2></div><div class="environment-summary"><div><span>Codex 连接</span>${badge(state.status.connections ? "已连接" : "未连接", state.status.connections ? "green" : "")}</div><div><span>IM 桥接</span>${badge(state.status.bridge.running ? "运行中" : "未启动", state.status.bridge.running ? "green" : "")}</div><div><span>工作台版本</span><code>v${escape(state.status.version)}</code></div><a href="#config">管理运行配置</a></div></section></aside></div>`
  );
}
function workspaceCard(workspace, removable = false) {
  return `<article class="workspace-card"><div class="workspace-card-top"><span class="folder-symbol">▱</span><div><h3>${escape(workspace.name)}</h3><div class="path" title="${escape(workspace.path)}">${escape(workspace.path)}</div></div></div><p class="workspace-card-meta">${workspace.createdAt ? `添加于 ${date(workspace.createdAt)}` : "本地工作目录"}</p><div class="workspace-card-actions"><button data-chat="${workspace.id}">打开会话</button>${removable ? `<button class="text-button danger" data-delete-workspace="${workspace.id}">移除登记</button>` : '<span class="workspace-label">工作目录</span>'}</div></article>`;
}
function workspaceRow(w, compact = false) {
  return `<div class="row"><div class="row-icon">▱</div><div class="row-main"><div class="row-title">${escape(w.name)}</div><div class="path">${escape(w.path)}</div></div><div class="row-actions"><button data-chat="${w.id}">打开会话</button>${compact ? "" : `<button class="text-button danger" data-delete-workspace="${w.id}">移除</button>`}</div></div>`;
}
async function workspaces() {
  state.workspaces = await api("/workspaces");
  return (
    heading(
      "工作目录",
      "将项目留在你自己的文件系统中，让 Codex 就地工作。",
      '<button class="primary" data-action="new-workspace">＋ 添加工作目录</button>',
    ) +
    `<div class="note">工作区根目录：<code>${escape(state.status.workspaceRoot)}</code>。Docker 部署时请将项目挂载到此目录。</div><section class="panel"><div class="panel-head"><h2>已登记目录</h2>${badge(`${state.workspaces.length} 个工作区`)}</div>${state.workspaces.length ? `<div class="workspace-cards directory-cards">${state.workspaces.map((w) => workspaceCard(w, true)).join("")}</div>` : empty("添加第一个项目", "支持登记已有目录，也可以创建一个新目录。")}</section>`
  );
}
function newWorkspace() {
  modal(
    "添加工作目录",
    `<form><label>工作区名称<input name="name" required placeholder="例如：我的项目" maxlength="80"></label><label>目录路径<input name="path" required placeholder="相对于工作区根目录，例如 my-project"></label><p class="form-help">目录必须位于 ${escape(state.status.workspaceRoot)} 内。</p><label class="check-label"><input name="create" type="checkbox">目录不存在时自动创建</label>${actions("添加工作目录")}</form>`,
    async (data) => {
      const w = await api("/workspaces", "POST", {
        name: data.get("name"),
        path: data.get("path"),
        create: data.has("create"),
      });
      state.workspaces.push(w);
      if (!state.workspaceId) state.workspaceId = w.id;
      toast("工作目录已添加");
      await navigate();
    },
  );
}
async function skills() {
  state.skills = await api("/skills");
  return (
    heading(
      "Skills",
      "把常用方法写成技能，在 Codex 中通过 $技能名 调用。",
      '<div class="row-actions"><button data-action="new-skill">新建技能</button><button class="primary" data-action="upload-skill">上传 ZIP</button></div>',
    ) +
    `<div class="note">管理全局技能目录 <code>${escape(state.status.skillsDir)}</code> 中的技能包。支持上传包含 SKILL.md、脚本与参考文件的 ZIP；项目内技能仍由 Codex 自动发现。保存后重新连接会话以加载。</div><section class="panel"><div class="panel-head"><h2>全局技能</h2>${badge(`${state.skills.length} 个技能`)}</div>${state.skills.length ? state.skills.map((s) => `<div class="row"><div class="row-icon">✳</div><div class="row-main"><div class="row-title">${escape(s.name)}</div><div class="path">${escape(s.content.match(/^description:\s*(.*)/m)?.[1] || "SKILL.md")}</div></div><div class="row-actions"><button data-skill="${escape(s.name)}">编辑</button><button class="danger text-button" data-delete-skill="${escape(s.name)}">移除</button></div></div>`).join("") : empty("为 Codex 添加你的工作方法", "标准 Markdown 文件，无需额外 SDK。")}</section>`
  );
}
function editSkill(name) {
  const skill = state.skills.find((s) => s.name === name);
  modal(
    skill ? "编辑技能" : "新建技能",
    `<form><label>技能目录名<input name="name" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" value="${escape(skill?.name || "")}" ${skill ? "readonly" : ""} placeholder="code-review"></label><label>SKILL.md<textarea class="editor" name="content" required spellcheck="false">${escape(skill?.content || "---\nname: code-review\ndescription: Review code changes and identify actionable issues.\n---\n\n# Code review\n\nRead the diff, check correctness, and report actionable findings.\n")}</textarea></label>${actions()}</form>`,
    async (data) => {
      await api(`/skills/${encodeURIComponent(data.get("name"))}`, "PUT", {
        content: data.get("content"),
        revision: skill?.revision || null,
      });
      toast("技能已保存");
      await navigate();
    },
    true,
  );
}
function uploadSkill() {
  modal(
    "上传 Skills ZIP",
    `<form><label>技能包<input type="file" name="archive" accept=".zip,application/zip" required></label><p class="form-help">支持 SKILL.md 或 Skills.md，及 script / scripts、reference / references 等完整目录。压缩包上限 16 MiB，解压后最多 64 MiB。</p><label>技能名（可选）<input name="name" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" placeholder="默认读取包内 name"></label><label class="check-label"><input type="checkbox" name="replace">替换同名技能包，并保留上一版本备份</label>${actions("上传并安装")}</form>`,
    async (data) => {
      const file = data.get("archive");
      if (!file?.size || file.size > 16 * 1024 * 1024)
        throw new Error("请选择不超过 16 MiB 的 ZIP 文件");
      const query = new URLSearchParams();
      if (data.get("name").trim()) query.set("name", data.get("name").trim());
      if (data.has("replace")) query.set("replace", "true");
      const result = await api(`/skills/import?${query}`, "POST", file);
      toast(`已安装 ${result.name}，共 ${result.files} 个文件`);
      await navigate();
    },
  );
}
async function mcp() {
  state.mcp = await api("/mcp");
  return (
    heading("MCP 服务", "连接外部工具与数据源，调用由原生 Codex 处理。") +
    '<div class="note">这里编辑原生 config.toml 的 mcp_servers。支持 stdio（command / args / env）及 HTTP（url / bearer_token_env_var）。保存会备份原配置并重新序列化 TOML，原注释保存在 .bak 文件中；其他配置项保留。重新连接会话后生效。</div>' +
    `<section class="panel"><div class="panel-head"><h2>服务器配置</h2>${badge(`${Object.keys(state.mcp.servers).length} 个服务`, "blue")}</div><div class="editor-wrap"><label>mcp_servers · JSON<textarea id="mcp-editor" class="editor" spellcheck="false">${escape(JSON.stringify(state.mcp.servers, null, 2))}</textarea></label><details><summary>查看配置示例</summary><pre>${escape(JSON.stringify({ filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspaces"], enabled: true }, remote: { url: "https://example.com/mcp", bearer_token_env_var: "MCP_TOKEN" } }, null, 2))}</pre></details><div class="editor-actions"><button data-action="reload">重新加载</button><button class="primary" data-action="save-mcp">保存配置</button></div></div></section>`
  );
}
async function config() {
  [state.config, state.general] = await Promise.all([
    api("/config/codex"),
    api("/config/general"),
  ]);
  return (
    heading("配置管理", "通用运行设置和原生 Codex 配置，在这里集中管理。") +
    `<div class="settings-layout"><div>${generalEditor(state.general.settings)}</div><aside class="settings-native"><div class="section-caption"><h2>Codex 配置</h2><p>模型、供应商、MCP 与原生工具策略。保存后重新连接会话以加载。</p></div>${configEditor(state.config, "原生配置 · config.toml")}</aside></div>`
  );
}
function generalEditor(settings) {
  return `<form id="general-form"><section class="panel"><div class="panel-head"><h2>网络代理</h2></div><div class="panel-body"><label>代理模式<select name="proxyMode"><option value="inherit" ${settings.proxyMode === "inherit" ? "selected" : ""}>继承服务环境</option><option value="custom" ${settings.proxyMode === "custom" ? "selected" : ""}>使用自定义代理</option><option value="disabled" ${settings.proxyMode === "disabled" ? "selected" : ""}>禁用代理</option></select></label><div id="proxy-fields"><div class="form-row"><label>HTTP 代理<input name="httpProxy" autocomplete="off" value="${escape(settings.httpProxy)}" placeholder="http://127.0.0.1:7890"></label><label>HTTPS 代理<input name="httpsProxy" autocomplete="off" value="${escape(settings.httpsProxy)}" placeholder="http://127.0.0.1:7890"></label></div><label>通用代理<input name="allProxy" autocomplete="off" value="${escape(settings.allProxy)}" placeholder="socks5://127.0.0.1:7891"></label><label>不经过代理的地址<input name="noProxy" value="${escape(settings.noProxy)}" placeholder="localhost,127.0.0.1,::1"></label><p class="form-help">用逗号分隔主机名、域名或地址。Docker 内访问宿主机代理可使用 host.docker.internal。</p></div><p class="note">设置通过标准代理环境变量传给 Codex、cc-connect 及其启动的工具。保存后，新会话和新任务使用新配置；正在运行的会话需重新连接，IM 桥接需重新启动。</p></div></section><section class="panel"><div class="panel-head"><h2>任务默认设置</h2></div><div class="panel-body"><div class="form-row"><label>默认时区<input name="defaultTimezone" required value="${escape(settings.defaultTimezone)}" placeholder="Asia/Shanghai"></label><label>任务最大并发<input name="jobConcurrency" required type="number" min="1" max="16" value="${settings.jobConcurrency}"></label></div><p class="form-help">默认时区用于新建任务。降低并发不会中断已经运行的任务。</p></div></section><div class="editor-actions"><button type="button" data-action="reload">重新加载</button><button type="submit" class="primary">保存通用配置</button></div></form>`;
}
function configEditor(file, title = "config.toml") {
  return `<section class="panel"><div class="panel-head"><h2>${escape(title)}</h2>${badge("TOML", "blue")}</div><div class="editor-wrap"><textarea aria-label="配置内容" id="config-editor" class="editor" spellcheck="false">${escape(file.content)}</textarea><div class="editor-actions"><span class="path">${escape(file.path)}</span><button data-action="reload">重新加载</button><button class="primary" data-action="save-config">保存配置</button></div></div></section>`;
}
async function im() {
  [state.bridge, state.config, state.workspaces] = await Promise.all([
    api("/bridge"),
    api("/config/cc-connect"),
    api("/workspaces"),
  ]);
  return (
    heading(
      "IM 通信",
      "把项目接到你常用的消息平台，随时保持连接。",
      `<div class="row-actions">${state.bridge.enabled && !state.bridge.running ? '<button data-action="stop-bridge">关闭随服务启动</button>' : ""}<button data-action="${state.bridge.running ? "stop" : "start"}-bridge" class="${state.bridge.running ? "" : "primary"}">${state.bridge.running ? "停止桥接" : "启动桥接"}</button></div>`,
    ) +
    `<div class="stats"><div class="stat"><span class="stat-label">桥接状态</span><span class="stat-number">${state.bridge.running ? "运行中" : "未启动"}</span><span class="stat-meta">${state.bridge.enabled ? "已启用随服务启动" : "手动启动后自动持久化"}</span></div><div class="stat"><span class="stat-label">集成方式</span><span class="stat-number">原生 CLI</span><span class="stat-meta">原生 app server，共享配置与技能</span></div></div>
    ${state.bridge.lastError ? `<div class="note">${escape(state.bridge.lastError)}</div>` : ""}<div class="note">填写平台凭据与 allow_from 用户白名单后启动。IM 会话由 cc-connect 独立管理。模板默认使用原生 app_server 后端；审批与平台交互由 cc-connect 处理。</div>
    <section class="channel-grid">${imChannels.map((channel) => `<button class="channel-card" data-channel="${channel.id}"><span class="channel-icon ${channel.id}">${channel.icon}</span><span><strong>${channel.name}</strong><small>${escape(channel.description)}</small></span><span class="channel-add" aria-hidden="true">+</span></button>`).join("")}</section><div class="toolbar"><button data-action="im-template">生成渠道配置</button><span class="spacer"></span><a href="https://github.com/chenhg5/cc-connect" target="_blank" rel="noreferrer"><small>cc-connect 配置文档</small></a></div>${configEditor(state.config)}
    <section class="panel"><div class="panel-head"><h2>进程日志</h2><button data-action="reload">刷新</button></div><div class="panel-body"><pre>${escape(state.bridge.logs.map((l) => `${date(l.time)} ${l.message}`).join("\n") || "桥接启动后在这里显示日志。")}</pre></div></section>`
  );
}
function imTemplate(selected = "feishu") {
  if (!state.workspaces.length) return toast("请先添加工作目录");
  modal(
    "添加消息渠道",
    `<form><label>工作目录<select name="workspaceId">${workspaceOptions()}</select></label><label>消息平台<select name="platform" id="im-platform">${imChannels.map((channel) => `<option value="${channel.id}" ${channel.id === selected ? "selected" : ""}>${channel.name}</option>`).join("")}</select></label><p class="form-help" id="im-channel-help">${escape(imChannels.find((c) => c.id === selected)?.description || "")}</p><p class="note">生成结果将替换编辑器草稿，保存后写入配置文件。填写对应平台凭据与用户白名单后再启动桥接。</p>${actions("生成配置")}</form>`,
    async (data) => {
      const workspace = state.workspaces.find(
        (w) => w.id === data.get("workspaceId"),
      );
      $("#config-editor").value = createImConfig({
        workspace,
        codexHome: state.status.codexHome,
        stateDir: state.config.path.replace(/\/config.toml$/, "/state"),
        platform: data.get("platform"),
      });
    },
  );
  $("#im-platform").onchange = (event) => {
    $("#im-channel-help").textContent =
      imChannels.find((c) => c.id === event.target.value)?.description || "";
  };
}
function workspaceOptions(selected = "") {
  return state.workspaces
    .map(
      (w) =>
        `<option value="${w.id}" ${selected === w.id ? "selected" : ""}>${escape(w.name)}</option>`,
    )
    .join("");
}
async function jobs() {
  [state.jobs, state.workspaces, state.runs, state.general] = await Promise.all(
    [api("/jobs"), api("/workspaces"), api("/runs"), api("/config/general")],
  );
  return (
    heading(
      "定时任务",
      "把重复工作交给 Codex，按你的时区准时执行。",
      '<button class="primary" data-action="new-job">＋ 创建任务</button>',
    ) +
    '<div class="note">任务通过原生 app server 执行，默认只读沙箱。无人值守任务不批准交互请求；需要审批或输入时记录失败。服务停机期间不会补跑错过的任务。</div>' +
    `<section class="panel"><div class="panel-head"><h2>任务计划</h2><button data-action="reload">刷新状态</button></div>${state.jobs.length ? state.jobs.map((j) => `<div class="row"><div class="row-icon">◴</div><div class="row-main"><div class="row-title">${escape(j.name)} ${badge(j.running ? "执行中" : j.enabled ? "已启用" : "已暂停", j.running ? "blue" : j.enabled ? "green" : "")}</div><div class="path">${escape(j.cron)} · ${escape(j.timezone)} · 下次 ${date(j.nextRun, j.timezone)}</div></div><div class="row-actions">${j.running ? `<button class="danger" data-cancel-job="${j.id}">停止执行</button>` : `<button data-run-job="${j.id}">立即执行</button>`}<button data-edit-job="${j.id}">编辑</button><button data-toggle-job="${j.id}">${j.enabled ? "暂停" : "启用"}</button><button class="danger text-button" data-delete-job="${j.id}">删除</button></div></div>`).join("") : empty("让重复工作自动发生", "例如每天早上检查项目变化，或每周整理工作摘要。")}</section>
    <section class="panel"><div class="panel-head"><h2>执行记录</h2><small>保留最近 200 次</small></div>${state.runs.length ? state.runs.map(runRow).join("") : empty("还没有执行记录", "任务执行后将在这里显示状态与结果。")}</section>`
  );
}
function runRow(r) {
  const statuses = {
    running: ["执行中", "blue"],
    completed: ["已完成", "green"],
    failed: ["失败", "red"],
    interrupted: ["已中断", "amber"],
    cancelled: ["已取消", "amber"],
  };
  const [label, color] = statuses[r.status] || [r.status, ""];
  return `<div class="row"><div class="row-main"><div class="row-title">${escape(r.name)} ${badge(label, color)}</div><div class="path">${date(r.startedAt)}${r.finishedAt ? ` · 结束 ${date(r.finishedAt)}` : ""}</div><details><summary>查看结果</summary><pre class="run-result">${escape([r.error, r.output, r.threadId ? `\nThread: ${r.threadId}` : ""].filter(Boolean).join("\n") || "执行中，完成后保存输出…")}</pre></details></div></div>`;
}
function environmentRow(key = "", value = "") {
  return `<div class="env-row"><label>变量名<input name="envKey" autocomplete="off" spellcheck="false" placeholder="API_ENDPOINT" value="${escape(key)}" maxlength="128"></label><label>变量值<textarea name="envValue" rows="1" autocomplete="off" spellcheck="false" placeholder="https://example.com">${escape(value)}</textarea></label><button type="button" class="icon-button" data-remove-env aria-label="移除环境变量">×</button></div>`;
}
function readTaskEnvironment(data) {
  const keys = data.getAll("envKey"),
    values = data.getAll("envValue");
  const env = {};
  keys.forEach((raw, index) => {
    const key = raw.trim(),
      value = values[index] || "";
    if (!key && !value) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      throw new Error(
        "环境变量名需以字母或下划线开头，仅包含字母、数字和下划线",
      );
    if (Object.hasOwn(env, key)) throw new Error(`环境变量名重复：${key}`);
    Object.defineProperty(env, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return env;
}
function editJob(id) {
  if (!state.workspaces.length) return toast("请先添加工作目录");
  const j = state.jobs.find((j) => j.id === id);
  modal(
    j ? "编辑定时任务" : "创建定时任务",
    `<form><label>任务名称<input name="name" required value="${escape(j?.name || "")}" placeholder="每日项目检查"></label><label>工作目录<select name="workspaceId">${workspaceOptions(j?.workspaceId)}</select></label><div class="form-row"><label>Cron · 五字段<input name="cron" required value="${escape(j?.cron || "0 9 * * *")}"></label><label>时区<input name="timezone" required value="${escape(j?.timezone || state.general?.settings.defaultTimezone || "Asia/Shanghai")}"></label></div><label>交给 Codex 的任务<textarea name="prompt" required placeholder="检查最近一天的代码变更，整理值得关注的事项。">${escape(j?.prompt || "")}</textarea></label><div class="form-row"><label>沙箱<select name="sandbox"><option value="read-only">只读</option><option value="workspace-write" ${j?.sandbox === "workspace-write" ? "selected" : ""}>允许修改工作区</option></select></label><label>超时（分钟）<input type="number" min="1" max="120" name="timeoutMinutes" value="${j?.timeoutMinutes || 15}" required></label></div><div class="env-heading"><label>自定义环境变量</label><button type="button" data-add-env>＋ 添加变量</button></div><div id="job-env">${
      Object.entries(j?.env || {})
        .map(([key, value]) => environmentRow(key, value))
        .join("") || environmentRow()
    }</div><p class="form-help">仅用于该任务的新进程；同名变量覆盖通用环境，值按原文传递。</p><label class="check-label"><input type="checkbox" name="enabled" ${j?.enabled !== false ? "checked" : ""}>启用计划</label>${actions()}</form>`,
    async (data) => {
      await api(`/jobs${j ? `/${j.id}` : ""}`, j ? "PUT" : "POST", {
        name: data.get("name"),
        workspaceId: data.get("workspaceId"),
        cron: data.get("cron"),
        timezone: data.get("timezone"),
        prompt: data.get("prompt"),
        sandbox: data.get("sandbox"),
        timeoutMinutes: Number(data.get("timeoutMinutes")),
        enabled: data.has("enabled"),
        env: readTaskEnvironment(data),
      });
      toast("任务已保存");
      await navigate();
    },
  );
}
function connectionStatus() {
  $("#connection").className = `badge ${state.ready ? "green" : ""}`;
  $("#connection").textContent = state.ready ? "Codex 已连接" : "未连接会话";
  $("#native-state").textContent = state.ready
    ? "App Server 已连接"
    : "App Server 未连接";
  $("#native-state").classList.toggle("online", state.ready);
}
function disconnect() {
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  state.ready = false;
  state.busy = false;
  state.turnId = "";
  state.approvals.clear();
  for (const r of state.requests.values()) {
    clearTimeout(r.timer);
    r.reject(new Error("连接已关闭"));
  }
  state.requests.clear();
  connectionStatus();
}
function rpc(method, params = {}) {
  if (!state.ready) return Promise.reject(new Error("请先连接 Codex"));
  const id = ++state.sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.requests.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, 60_000);
    state.requests.set(id, { resolve, reject, timer });
    state.ws.send(JSON.stringify({ id, method, params }));
  });
}
async function connect() {
  if (!state.workspaceId) return toast("请先添加或选择工作目录");
  disconnect();
  state.threadId = "";
  state.messages = [];
  state.threads = [];
  state.events = [];
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc?workspace=${encodeURIComponent(state.workspaceId)}`,
  );
  state.ws = ws;
  ws.onclose = () => {
    if (state.ws === ws) {
      disconnect();
      toast("Codex 连接已关闭，可重新连接并恢复会话");
      renderChat();
    }
  };
  ws.onerror = () => toast("无法连接 Codex，请检查原生 CLI 是否已安装");
  ws.onmessage = async (event) => {
    if (state.ws !== ws) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const waiting = state.requests.get(message.id);
    if (!message.method && waiting) {
      clearTimeout(waiting.timer);
      state.requests.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
      return;
    }
    const p = message.params || {};
    if (message.method === "deck/ready") {
      state.ready = true;
      connectionStatus();
      toast("已连接原生 Codex app server");
      try {
        await refreshThreads();
      } catch (e) {
        toast(e.message);
      }
    } else if (message.method === "deck/error") toast(p.message);
    else if (message.method && message.id !== undefined)
      state.approvals.set(message.id, message);
    else if (message.method === "serverRequest/resolved")
      state.approvals.delete(p.requestId);
    else if (message.method === "item/agentMessage/delta") {
      let item = state.messages.find((m) => m.id === p.itemId);
      if (!item) {
        item = { id: p.itemId, role: "assistant", text: "" };
        state.messages.push(item);
      }
      item.text += p.delta || "";
    } else if (message.method === "item/completed") {
      const item = p.item;
      if (item?.type === "agentMessage") {
        let existing = state.messages.find((m) => m.id === item.id);
        if (existing) existing.text = item.text;
        else
          state.messages.push({
            id: item.id,
            role: "assistant",
            text: item.text,
          });
      } else if (item && item.type !== "userMessage")
        state.messages.push({
          id: item.id,
          role: "tool",
          text: JSON.stringify(item, null, 2),
          title: item.type,
        });
    } else if (message.method === "turn/started") {
      state.turnId = p.turn?.id;
      state.busy = true;
    } else if (message.method === "turn/completed") {
      state.busy = false;
      state.turnId = "";
      state.approvals.clear();
      if (p.turn?.error)
        state.messages.push({ role: "system", text: p.turn.error.message });
      refreshThreads().catch(() => {});
    } else if (message.method === "error")
      state.messages.push({
        role: "system",
        text: p.error?.message || JSON.stringify(p),
      });
    if (
      message.method &&
      !["item/agentMessage/delta", "deck/ready"].includes(message.method)
    ) {
      state.events.push(message);
      state.events = state.events.slice(-150);
    }
    renderChat();
  };
  renderChat();
}
async function refreshThreads() {
  const w = state.workspaces.find((w) => w.id === state.workspaceId);
  const result = await rpc("thread/list", {
    cwd: w.path,
    limit: 50,
    sortKey: "updated_at",
  });
  state.threads = result.data || [];
  renderThreadList();
}
async function chat() {
  state.workspaces = await api("/workspaces");
  if (!state.workspaces.some((w) => w.id === state.workspaceId)) {
    disconnect();
    state.threadId = "";
    state.messages = [];
    state.threads = [];
    state.workspaceId = state.workspaces[0]?.id || "";
  }
  return (
    heading("Codex 会话", "在你的工作目录中思考、构建与执行。") +
    `<div class="toolbar"><select id="chat-workspace" aria-label="选择工作目录">${workspaceOptions(state.workspaceId)}</select><button data-action="connect">${state.ready ? "重新连接" : "连接 Codex"}</button><span class="spacer"></span><button data-action="new-thread">＋ 新会话</button></div>
    <div class="chat-layout"><aside class="panel chat-history"><div class="panel-head"><h2>会话</h2><button class="text-button" data-action="refresh-threads">刷新</button></div><div id="thread-list"></div></aside><section class="panel chat-panel"><div id="messages" class="messages" aria-live="polite"></div><form id="chat-form" class="chat-form"><textarea id="prompt" aria-label="发送给 Codex 的消息" placeholder="描述你想完成的工作…" required></textarea><div class="editor-actions"><span class="chat-meta">Enter 换行 · Ctrl / ⌘ + Enter 发送</span><button type="button" data-action="interrupt" id="interrupt">停止</button><button class="primary" id="send-message" type="submit">发送消息</button></div></form></section></div>
    <details class="raw-rpc"><summary>原生协议 · 请求与事件</summary><div class="note">可调用稳定版原生 JSON-RPC 方法。握手由 Deck 完成，浏览器端使用数字 request id。工具事件在这里原样展示。</div><form id="rpc-form"><label>JSON-RPC 请求<textarea id="rpc-input" class="editor" spellcheck="false">${escape(JSON.stringify({ method: "model/list", params: {} }, null, 2))}</textarea></label><button type="submit">发送请求</button></form><pre id="rpc-result" class="run-result"></pre><details><summary>最近 150 条事件</summary><pre id="rpc-events" class="run-result"></pre></details></details>`
  );
}
function renderThreadList() {
  if (!$("#thread-list")) return;
  $("#thread-list").innerHTML = state.threads.length
    ? state.threads
        .map(
          (t) =>
            `<button class="thread-button ${state.threadId === t.id ? "active" : ""}" data-thread="${escape(t.id)}" title="${escape(t.preview || t.id)}">${escape(t.name || t.preview || t.id)}</button>`,
        )
        .join("")
    : `<div class="empty"><small>${state.ready ? "还没有历史会话" : "连接后显示历史会话"}</small></div>`;
}
function renderChat() {
  if (state.page !== "chat" || !$("#messages")) return;
  const messages = $("#messages");
  const bottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  messages.innerHTML =
    state.messages
      .map((m) =>
        m.role === "tool"
          ? `<details><summary>${escape(m.title)} · 工具结果</summary><pre class="run-result">${escape(m.text)}</pre></details>`
          : `<div class="message ${m.role}"><span class="message-label">${m.role === "user" ? "YOU" : m.role === "assistant" ? "CODEX" : "SYSTEM"}</span><div class="message-text">${escape(m.text)}</div></div>`,
      )
      .join("") +
    [...state.approvals.values()].map(approvalHtml).join("") +
    (state.busy
      ? '<div class="stream-info"><span class="status-pulse"></span>Codex 正在工作…</div>'
      : "") +
    (!state.messages.length && !state.approvals.size
      ? empty(
          state.ready ? "今天要构建什么？" : "连接你的 Codex",
          state.ready
            ? "发送一条消息开始，或从左侧恢复历史会话。"
            : "选择工作目录，再点击「连接 Codex」。",
        )
      : "");
  if (bottom) messages.scrollTop = messages.scrollHeight;
  $("#send-message").disabled = !state.ready || state.busy;
  $("#interrupt").disabled = !state.busy;
  $('[data-action="connect"]').textContent = state.ready
    ? "重新连接"
    : "连接 Codex";
  $("#rpc-events").textContent = state.events
    .map((e) => JSON.stringify(e))
    .join("\n");
  renderThreadList();
}
function approvalHtml(message) {
  const type = message.method;
  const key = escape(JSON.stringify(message.id));
  const known = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(type);
  return `<div class="approval"><h3>Codex 需要你的确认</h3><small>${escape(type)}</small><pre>${escape(JSON.stringify(message.params, null, 2))}</pre>${known ? `<div class="row-actions"><button data-approval="${key}" data-decision="accept">允许本次</button><button data-approval="${key}" data-decision="decline">拒绝</button><button data-approval="${key}" data-decision="cancel">取消</button></div>` : `<label>响应结果 · JSON<textarea data-response="${key}" spellcheck="false" placeholder="填写该原生方法要求的响应 JSON">${escape(JSON.stringify(responseTemplate(type, message.params), null, 2))}</textarea></label><button data-approval="${key}">发送响应</button>`}</div>`;
}
function responseTemplate(method, params) {
  if (method === "item/tool/requestUserInput")
    return {
      answers: Object.fromEntries(
        (params.questions || []).map((q) => [q.id, { answers: [""] }]),
      ),
    };
  if (method === "item/permissions/requestApproval")
    return { permissions: {}, scope: "turn" };
  if (method === "mcpServer/elicitation/request")
    return { action: "decline", content: null };
  if (method === "execCommandApproval" || method === "applyPatchApproval")
    return { decision: "denied" };
  return {};
}
async function resumeThread(id) {
  if (state.busy) return toast("请先等待当前任务完成或停止执行");
  const { thread } = await rpc("thread/resume", { threadId: id });
  state.threadId = thread.id;
  state.messages = [];
  state.approvals.clear();
  for (const turn of thread.turns || [])
    for (const item of turn.items || []) {
      if (item.type === "userMessage")
        state.messages.push({
          id: item.id,
          role: "user",
          text: (item.content || []).map((i) => i.text || "").join("\n"),
        });
      else if (item.type === "agentMessage")
        state.messages.push({
          id: item.id,
          role: "assistant",
          text: item.text,
        });
      else
        state.messages.push({
          id: item.id,
          role: "tool",
          title: item.type,
          text: JSON.stringify(item, null, 2),
        });
    }
  const runningTurn = thread.turns?.find((t) => t.status === "inProgress");
  state.busy = Boolean(runningTurn);
  state.turnId = runningTurn?.id || "";
  renderChat();
}
async function sendPrompt(e) {
  e.preventDefault();
  const input = $("#prompt");
  const prompt = input.value.trim();
  if (!prompt || state.busy) return;
  if (!state.ready) return toast("请先连接 Codex");
  state.busy = true;
  renderChat();
  try {
    if (!state.threadId) {
      const { thread } = await rpc("thread/start", {});
      state.threadId = thread.id;
    }
    state.messages.push({ role: "user", text: prompt });
    input.value = "";
    renderChat();
    const { turn } = await rpc("turn/start", {
      threadId: state.threadId,
      input: [{ type: "text", text: prompt }],
    });
    state.turnId = turn.id;
  } catch (e) {
    state.busy = false;
    toast(e.message);
  }
  renderChat();
}
function bindPage() {
  if (state.page === "config") {
    const form = $("#general-form");
    const updateProxyFields = () => {
      for (const input of $$("#proxy-fields input"))
        input.disabled = form.elements.proxyMode.value !== "custom";
    };
    form.elements.proxyMode.onchange = updateProxyFields;
    updateProxyFields();
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = $("button[type=submit]", form);
      button.disabled = true;
      try {
        const settings = Object.fromEntries(
          [
            "proxyMode",
            "httpProxy",
            "httpsProxy",
            "allProxy",
            "noProxy",
            "defaultTimezone",
          ].map((name) => [name, form.elements[name].value]),
        );
        settings.jobConcurrency = Number(form.elements.jobConcurrency.value);
        state.general = await api("/config/general", "PUT", {
          settings,
          revision: state.general.revision,
        });
        toast("通用配置已保存");
      } catch (e) {
        toast(e.message);
      } finally {
        button.disabled = false;
      }
    };
  }

  if (state.page === "chat") {
    renderChat();
    $("#chat-workspace").onchange = (e) => {
      if (state.busy && !confirm("切换目录会断开当前执行，确定继续？")) {
        e.target.value = state.workspaceId;
        return;
      }
      disconnect();
      state.workspaceId = e.target.value;
      state.threadId = "";
      state.messages = [];
      state.threads = [];
      renderChat();
    };
    $("#chat-form").onsubmit = sendPrompt;
    $("#prompt").onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        $("#chat-form").requestSubmit();
      }
    };
    $("#rpc-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const request = JSON.parse($("#rpc-input").value);
        const result = await rpc(request.method, request.params);
        $("#rpc-result").textContent = JSON.stringify(result, null, 2);
      } catch (e) {
        $("#rpc-result").textContent = e.message;
      }
    };
  }
}
// Delegate dynamic controls so streaming updates do not lose listeners.
$("#content").addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.action) {
      const a = target.dataset.action;
      if (a === "new-conversation") {
        if (state.busy) return toast("请先等待当前执行结束或停止执行");
        state.threadId = "";
        state.messages = [];
        state.approvals.clear();
        if (location.hash === "#chat") {
          renderChat();
          $("#prompt").focus();
        } else location.hash = "chat";
        return;
      }
      if (a === "new-workspace") return newWorkspace();
      if (a === "new-skill") return editSkill();
      if (a === "upload-skill") return uploadSkill();
      if (a === "new-job") return editJob();
      if (a === "reload") return await navigate();
      if (a === "save-config") {
        const kind = state.page === "im" ? "cc-connect" : "codex";
        state.config = await api(`/config/${kind}`, "PUT", {
          content: $("#config-editor").value,
          revision: state.config.revision,
        });
        toast("配置已保存，新连接或重启桥接后生效");
        return;
      }
      if (a === "save-mcp") {
        state.mcp = await api("/mcp", "PUT", {
          servers: JSON.parse($("#mcp-editor").value),
          revision: state.mcp.revision,
        });
        toast("MCP 配置已保存，重新连接会话后生效");
        return;
      }
      if (a === "im-template") return imTemplate();
      if (a === "start-bridge" || a === "stop-bridge") {
        await api(`/bridge/${a.split("-")[0]}`, "POST");
        toast(a === "start-bridge" ? "已启动 cc-connect" : "已停止 cc-connect");
        return await navigate();
      }
      if (a === "connect") {
        if (state.busy && !confirm("重新连接会中断当前执行，确定继续？"))
          return;
        return await connect();
      }
      if (a === "refresh-threads") return await refreshThreads();
      if (a === "new-thread") {
        if (state.busy) return toast("请先等待当前任务完成或停止执行");
        state.threadId = "";
        state.messages = [];
        state.approvals.clear();
        renderChat();
        $("#prompt").focus();
        return;
      }
      if (a === "interrupt") {
        await rpc("turn/interrupt", {
          threadId: state.threadId,
          turnId: state.turnId,
        });
        return;
      }
    }
    if (target.dataset.chat) {
      if (state.busy && !confirm("切换目录会中断当前执行，确定继续？")) return;
      if (state.workspaceId !== target.dataset.chat) {
        disconnect();
        state.messages = [];
        state.threads = [];
        state.threadId = "";
      }
      state.workspaceId = target.dataset.chat;
      location.hash = "chat";
      return;
    }
    if (target.dataset.deleteWorkspace) {
      if (target.dataset.deleteWorkspace === state.workspaceId && state.busy)
        return toast("请先等待当前任务完成或停止执行，再移除工作区");
      if (!confirm("移除工作区登记？项目文件会保留。")) return;
      await api(`/workspaces/${target.dataset.deleteWorkspace}`, "DELETE");
      if (target.dataset.deleteWorkspace === state.workspaceId) {
        disconnect();
        state.workspaceId = "";
        state.threadId = "";
        state.messages = [];
        state.threads = [];
      }
      toast("已移除登记");
      return await navigate();
    }
    if (target.dataset.channel) return imTemplate(target.dataset.channel);
    if (target.dataset.skill) return editSkill(target.dataset.skill);
    if (target.dataset.deleteSkill) {
      if (!confirm("移除该技能的 SKILL.md？脚本与参考文件会保留。")) return;
      await api(
        `/skills/${encodeURIComponent(target.dataset.deleteSkill)}`,
        "DELETE",
      );
      return await navigate();
    }
    if (target.dataset.editJob) return editJob(target.dataset.editJob);
    if (target.dataset.toggleJob) {
      const job = state.jobs.find((j) => j.id === target.dataset.toggleJob);
      await api(`/jobs/${job.id}`, "PUT", { ...job, enabled: !job.enabled });
      return await navigate();
    }
    if (target.dataset.runJob) {
      await api(`/jobs/${target.dataset.runJob}/run`, "POST");
      toast("任务已开始执行");
      return await navigate();
    }
    if (target.dataset.cancelJob) {
      await api(`/jobs/${target.dataset.cancelJob}/cancel`, "POST");
      toast("当前执行已取消，任务计划保留");
      return await navigate();
    }
    if (target.dataset.deleteJob) {
      if (!confirm("删除这个定时任务？执行记录会保留。")) return;
      await api(`/jobs/${target.dataset.deleteJob}`, "DELETE");
      return await navigate();
    }
    if (target.dataset.thread) return await resumeThread(target.dataset.thread);
    if (target.dataset.approval) {
      const id = JSON.parse(target.dataset.approval);
      const text = $$("textarea[data-response]").find(
        (el) => el.dataset.response === target.dataset.approval,
      )?.value;
      const result = target.dataset.decision
        ? { decision: target.dataset.decision }
        : JSON.parse(text);
      if (!state.ready) throw new Error("连接已关闭");
      state.ws.send(JSON.stringify({ id, result }));
      state.approvals.delete(id);
      renderChat();
    }
  } catch (e) {
    toast(e.message);
  }
});
boot();
