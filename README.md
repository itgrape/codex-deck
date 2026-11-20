# Codex Deck

一个轻量、自托管的 Codex Web 控制台。在原生 `codex app-server` 外增加工作目录、IM、Skills、MCP、定时任务和配置管理。使用单个 Node.js 服务、静态前端和本地文件存储，无需数据库、Redis 或独立前端构建。

## 已实现

| 模块       | 能力                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Codex 会话 | 原生 thread / turn、历史恢复、流式输出、工具结果、停止执行、命令与文件审批                                            |
| 协议入口   | WebSocket 双向透传原生 JSON-RPC；未知事件保留；通用原生请求 / JSON 响应面板                                           |
| 工作目录   | 登记已有目录、创建目录、切换项目、移除登记；不删除项目文件                                                            |
| IM         | cc-connect 配置模板与 TOML 编辑、进程启停、日志、随服务自动启动                                                       |
| Skills     | 全局 SKILL.md 创建、编辑、移除；上传完整 Skills ZIP；原生发现项目级 Skills                                            |
| MCP        | 原生 `mcp_servers` 管理，支持 stdio / HTTP 与扩展配置字段                                                             |
| 定时任务   | 五字段 cron、IANA 时区、手动执行、取消当前执行、暂停 / 启用、编辑、任务级环境变量、执行历史、超时、重叠保护、并发上限 |
| 配置       | 原生 TOML 校验、备份、基于 revision 的冲突检测                                                                        |
| 部署       | 非 root Docker 镜像、持久卷、健康检查、Docker Hub 多架构发布 workflow                                                 |

这是面向**可信单用户**的第一版。Web 界面和工具执行权限等同于服务所在用户；目录管理限制不代替操作系统或 Codex 沙箱。内置 web search、shell、文件操作、MCP 等能力由 Codex 原生运行时提供，Deck 不注册替代工具、不改写模型工具调用，也不覆盖交互会话的原生审批与沙箱配置。

## 本地启动

需要 Node.js 22+、[Codex CLI](https://developers.openai.com/codex/cli/)；IM 功能另需 [cc-connect](https://github.com/chenhg5/cc-connect)。

```bash
npm ci
npm start
```

打开 <http://127.0.0.1:3030>，用启动日志里的临时访问令牌登录。生产环境请通过 `DECK_TOKEN` 设置至少 24 字符的固定随机令牌；未设置时每次重启生成新令牌，已有登录失效。令牌仅用于换取 12 小时 HttpOnly / SameSite=Strict 会话 Cookie，不写入浏览器 localStorage。

默认数据位于 `.data/`，使用独立的 Codex home，不会自动读取、复制或修改桌面端登录信息：

```text
.data/
├── settings.json               # 通用配置与网络代理
├── state.json                  # 工作区、任务、最近 200 次执行记录、IM 启用状态
├── codex/                      # 原生 Codex home：config.toml、登录、线程等
├── home/.agents/skills/         # 全局技能
├── cc-connect/config.toml      # IM 配置
└── workspaces/                 # 项目根目录
```

先使用相同的环境完成原生 Codex 登录：

```bash
mkdir -p .data/codex .data/home
HOME="$PWD/.data/home" CODEX_HOME="$PWD/.data/codex" codex login --device-auth
```

也可以使用原生 API Key 登录方式，密钥通过 stdin 传递：

```bash
printenv OPENAI_API_KEY | HOME="$PWD/.data/home" CODEX_HOME="$PWD/.data/codex" codex login --with-api-key
```

自定义供应商、模型和 `web_search` 等在「配置 → Codex 配置」中按原生格式设置。保存后重新连接会话。请按自身账号可用模型配置，项目不硬编码模型名。

## Docker 部署

```bash
cp .env.example .env
openssl rand -hex 24
# 将生成的随机值填入 .env 的 DECK_TOKEN，并设置 WORKSPACE_DIR、DOCKERHUB_USERNAME。
mkdir -p .data/workspaces
docker compose up -d --build
```

服务默认只映射到本机 `127.0.0.1:3030`。使用其他端口时，同步修改 `PORT` 和 `DECK_ORIGIN`；通过反向代理访问时将 `DECK_ORIGIN` 改成浏览器实际使用的完整 origin（例如 `https://deck.example.com`，末尾不带斜杠），代理需支持 WebSocket Upgrade。HTTPS origin 会启用 Secure Cookie。

首次启动后登录 Codex：

```bash
docker compose exec codex-deck codex login --device-auth
# 或由宿主机通过 stdin 传入 API key：
printenv OPENAI_API_KEY | docker compose exec -T codex-deck codex login --with-api-key
```

`deck-data` 持久卷保存配置、Codex 登录 / 线程、技能和任务状态。项目通过 `WORKSPACE_DIR:/workspaces` 绑定挂载；Web 表单中使用容器路径或相对路径，例如 `my-project`，而非宿主机路径。镜像以 UID/GID 1000 的 `node` 用户执行，Linux 上项目目录需对该用户可读写。

使用已发布镜像时：

```bash
docker compose pull
docker compose up -d --no-build
```

镜像固定 Codex CLI `0.170.0`、cc-connect `1.5.2`，支持构建参数 `CODEX_VERSION` / `CC_CONNECT_VERSION`。构建会验证 CLI 版本；如果 npm 跳过了下载失败的可选平台依赖，会显式补齐官方平台包并校验 SHA-512。版本升级后应重新运行 CI 和原生协议 smoke test。镜像包含 git、bash、ssh client 和 ripgrep；项目特定的 Python、编译器、浏览器等请通过自定义 Dockerfile 扩展。

Compose 仅为 Codex Deck 服务加载 [容器沙箱策略](docker/codex-seccomp.json)，允许原生 Codex 的 bubblewrap 创建嵌套 namespace，并对该服务设置 `apparmor=unconfined` 以兼容 AppArmor 主机，同时启用 `no-new-privileges`；不修改 Docker 全局默认策略，不添加 capabilities，继续以非 root 用户运行。该配置已在本机容器验证原生命令执行、只读写入拒绝和工作区写入。CI 同时检查宿主机与容器中的原生执行。策略来源、作用范围及 `docker run` 参数见 [docker/README.md](docker/README.md)。

### 自动发布到 Docker Hub

GitHub 仓库设置：

- Repository variable：`DOCKERHUB_USERNAME`
- Repository secret：`DOCKERHUB_TOKEN`（有目标 Docker Hub 仓库写权限的 access token）
- Workflow 使用 `dockerhub` environment，可在 GitHub 中为该 environment 配置所需的发布限制。

创建并推送版本标签后自动测试、构建并上传：

```bash
git tag v0.1.0
git push origin v0.1.0
```

输出 `DOCKERHUB_USERNAME/codex-deck:0.1.0`、`:0.1`、`:latest` 和 SHA 标签。预发布版本不更新 `latest`。同时发布 `linux/amd64` / `linux/arm64`；也可以手动运行 **Publish Docker image**，指定 `edge` 等标签。普通 PR / main push 的 CI 只测试和构建，不上传镜像。镜像构建上下文排除 `.data`、`.env`、`.git`，不会打包登录凭据或本地配置。

## IM 通信

1. 添加工作目录。
2. 在「IM 通信」生成 QQ 官方 Bot / QQ OneBot / 微信个人 Bot / 企业微信 Bot / 飞书 Bot / Telegram / Discord 模板，也可按 cc-connect 官方格式添加其他平台和多个 `[[projects]]`。
3. 填写平台凭据（推荐 `${ENV_VAR}` 引用环境变量）和 `allow_from` 用户白名单。
4. 保存配置，启动桥接。配置修改后停止并重新启动 cc-connect。

IM 模板显式设置 `backend = "app_server"` 和 `app_server_url = "stdio://"`。镜像固定的 cc-connect `1.5.2` 已在 [Codex 适配器源码](https://github.com/chenhg5/cc-connect/blob/v1.5.2/agent/codex/codex.go) 实现该后端，尽管对应配置示例没有完整列出这些参数。IM、Web 和定时任务都通过原生 app server 执行。IM 与 Web 共享 Codex home / 技能 / 项目文件，但会话由各自客户端管理，不承诺实时同步同一会话。已有 cc-connect 配置未指定 backend 时仍遵循其默认 exec 行为；IM 模式、审批和平台行为由 cc-connect 负责。

桥接启用状态会持久化，服务重启时尝试恢复；启动失败时保留错误信息，由用户修复后启动，不循环重启进程。管理页显示有界、尽力脱敏的最近进程日志，只有管理员可读取。桥接不会暴露额外的宿主机端口；需要 webhook 的平台可自行增加对应端口映射。

## Skills ZIP 上传

在 Skills 页面点击「上传 ZIP」，选择一个完整技能包。支持 `SKILL.md`（兼容 `Skills.md` 大小写及复数写法）位于包根目录或单一外层目录，脚本、参考资料和其他资源会一起保留。显式指定新技能名时会同步更新主文件中的 `name`。不会自动执行上传的脚本。

同名包默认拒绝覆盖；勾选替换后保留上一版完整目录至 `$DECK_DATA_DIR/skill-backups/<name>`。该备份不参与原生技能发现。上传上限 16 MiB，解压总大小 64 MiB，单文件 16 MiB，最多 1000 个条目；拒绝路径穿越、链接、特殊文件、加密 ZIP 和 CRC 校验失败的内容。上传完成后重新连接 Codex 以加载。

## 通用配置

「配置管理」同页展示通用配置与原生 Codex 配置；cc-connect 的配置统一在「IM 通信」管理。通用配置保存到数据目录的 `settings.json`，提供代理模式、HTTP / HTTPS / SOCKS 通用代理、不走代理的地址、默认任务时区和任务并发上限。

代理模式支持继承服务环境、自定义、禁用。自定义代理会覆盖标准代理环境变量的大小写形式；禁用模式移除这些变量。配置会用于新启动的 Codex 会话、定时任务与 cc-connect 进程；已有会话需要重新连接，已有 IM 进程需要重新启动。具体工具遵循自身对这些环境变量的支持。Docker 内连接宿主机代理请使用容器可访问的地址（Docker Desktop / OrbStack 通常为 `host.docker.internal`）。

默认时区只影响新建任务，已有计划保持自己的时区。并发上限保存后立即用于后续执行判断，不中断已运行任务；保存的值优先于 `DECK_JOB_CONCURRENCY` 初始默认值。通用配置支持 revision 冲突检测，文件权限为 0600。

## 定时任务语义

- 每次执行创建原生 Codex 线程，线程 ID 和最终文本保存在记录中。
- 创建和编辑任务均可填写自定义环境变量。仅传给该次任务的进程，同名变量覆盖通用环境；代理变量的大小写别名同步处理。HOME 和 CODEX_HOME 由工作台管理。变量按原文传递，支持空值、多行内容和等号，不进行 shell 展开。
- 默认 `read-only`，可选 `workspace-write`；不提供绕过沙箱的任务选项。
- 无人值守运行使用 `approvalPolicy: "never"`；遇到原生交互请求直接失败，不自动批准权限。
- 同一任务不能重叠执行；全局默认最多 2 个任务并发。达到并发上限的计划触发会跳过，并写服务日志。
- 默认超时 15 分钟，可设 1–120 分钟。可以单独停止当前执行并保留后续计划；停止服务会终止自有子进程并记录中断。
- 服务重启将残留的 `running` 记录标为 `interrupted`；停机期间不补跑历史触发。
- 最终状态与文本在任务结束时落盘；运行中输出保存在内存。UI 手动刷新状态；不承诺任务中间输出的崩溃恢复。
- 仅运行一个服务实例访问同一数据目录；文件存储和 cron 为单实例设计。

## 原生协议与会话

每个浏览器 WebSocket 对应独立原生 `codex app-server --listen stdio://` 子进程。Deck 只完成 `initialize → initialized` 握手；随后原生请求、通知和审批响应保持原始结构双向传输。[官方 app server 协议文档](https://developers.openai.com/codex/app-server/)。

会话页提供命令 / 文件审批按钮；其他交互（问题、MCP elicitation、权限请求等）保留原始载荷并支持填写该方法要求的 JSON 响应。原生协议面板可发送额外方法，例如 `model/list`、`account/read`、`skills/list`。默认使用稳定协议面，未启用 `experimentalApi`；未实现所有原生功能的专用交互组件。

页面内切换管理菜单保持连接。刷新页面、关闭浏览器连接、切换工作区或主动重连会停止该连接的 app server 及其正在执行的工具；原生已保存线程可以恢复。需要脱离浏览器持续执行的工作请使用定时任务或 IM。线程列表目前显示当前工作目录最近 50 条记录，前端为纯文本渲染，工具结果与 diffs 以可展开 JSON 展示。

工作区是管理分组，不是租户隔离边界。认证用户可以调用包括配置和工具操作在内的所有原生 RPC；这些能力与 Codex 配置可能访问工作区之外的资源。不要向不可信用户分发 Deck 管理令牌。

## 配置项

| 环境变量               | 默认值                       | 含义                                  |
| ---------------------- | ---------------------------- | ------------------------------------- |
| `DECK_HOST`            | `127.0.0.1`                  | 监听地址；镜像内为 `0.0.0.0`          |
| `PORT`                 | `3030`                       | 服务端口                              |
| `DECK_TOKEN`           | 启动时随机生成               | 管理访问令牌，至少 24 字符            |
| `DECK_ORIGIN`          | 请求 Host 对应的 HTTP origin | 浏览器实际访问 origin，反代时显式配置 |
| `DECK_DATA_DIR`        | `.data`                      | 管理数据目录                          |
| `DECK_HOME`            | `$DECK_DATA_DIR/home`        | 子进程 HOME，包含全局 Skills          |
| `CODEX_HOME`           | `$DECK_DATA_DIR/codex`       | 原生 Codex home                       |
| `DECK_WORKSPACE_ROOT`  | `$DECK_DATA_DIR/workspaces`  | 允许登记的项目根目录                  |
| `CODEX_BIN`            | `codex`                      | Codex 可执行文件                      |
| `CC_CONNECT_BIN`       | `cc-connect`                 | cc-connect 可执行文件                 |
| `DECK_JOB_CONCURRENCY` | `2`                          | 定时任务最大并发，1–16                |

`.env` 由 Docker Compose 自动读取；直接 `npm start` 时请通过 shell 导出环境变量，或用 `node --env-file=.env server/index.js`（其中 Compose 专用变量不会改变 Node 服务配置）。

## 开发与验证

```bash
npm run dev
npm run check
npm test
npm run smoke:native # 需要 Codex CLI 和 git，无需模型凭据
docker build -t codex-deck:local .
```

测试使用可控的原生协议子进程替身，覆盖认证、Origin 防护、持久化、路径穿越与符号链接、配置冲突、JSON-RPC / 流式事件 / 审批往返、任务执行、交互失败和退出清理。不调用模型、不消耗 API 额度。真实 Codex 的模型推理和实际 IM 平台需要配置对应凭据后验证。

项目为 ESM JavaScript，无编译步骤；前端不依赖框架，运行依赖为 `ws`、`smol-toml`、`croner`、`zod`、`yauzl`、`buffer-crc32`。架构细节见 [docs/architecture.md](docs/architecture.md)。

## 参考

- [Codex app server](https://developers.openai.com/codex/app-server/)：原生协议。
- [cc-connect v1.5.2 配置](https://github.com/chenhg5/cc-connect/blob/v1.5.2/config.example.toml)：镜像固定 IM 集成版本。

MIT License.
