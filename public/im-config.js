export const imChannels = [
  {
    id: "feishu",
    name: "飞书 Bot",
    icon: "飞",
    description: "飞书应用机器人，使用长连接接收消息。",
    options: {
      app_id: "YOUR_FEISHU_APP_ID",
      app_secret: "${FEISHU_APP_SECRET}",
    },
  },
  {
    id: "qqbot",
    name: "QQ 官方 Bot",
    icon: "QQ",
    description: "QQ 开放平台机器人，使用 AppID 和 AppSecret。",
    options: {
      app_id: "YOUR_QQ_APP_ID",
      app_secret: "${QQ_BOT_APP_SECRET}",
      sandbox: false,
    },
  },
  {
    id: "qq",
    name: "QQ · OneBot",
    icon: "Q",
    description: "连接 NapCat / OneBot 正向 WebSocket。",
    options: {
      ws_url: "${QQ_WS_URL}",
      token: "${QQ_ACCESS_TOKEN}",
      http_url: "${QQ_HTTP_URL}",
    },
  },
  {
    id: "weixin",
    name: "微信个人 Bot",
    icon: "微",
    description:
      "使用 ilink Bot Token，可先通过 cc-connect weixin setup 绑定。",
    options: {
      token: "${WEIXIN_BOT_TOKEN}",
      base_url: "https://ilinkai.weixin.qq.com",
      account_id: "default",
    },
  },
  {
    id: "wecom",
    name: "企业微信 Bot",
    icon: "企",
    description: "企业微信智能机器人，使用 WebSocket 长连接。",
    options: {
      mode: "websocket",
      bot_id: "YOUR_WECOM_BOT_ID",
      bot_secret: "${WECOM_BOT_SECRET}",
    },
  },
  {
    id: "telegram",
    name: "Telegram",
    icon: "T",
    description: "通过 Bot Token 连接 Telegram 消息。",
    options: { token: "${TELEGRAM_BOT_TOKEN}" },
  },
  {
    id: "discord",
    name: "Discord",
    icon: "D",
    description: "连接 Discord Bot 与服务器频道。",
    options: { token: "${DISCORD_BOT_TOKEN}" },
  },
];
export function createImConfig({ workspace, codexHome, stateDir, platform }) {
  const channel = imChannels.find((item) => item.id === platform);
  if (!channel) throw new Error("不支持的消息平台");
  const literal = (value) => JSON.stringify(value);
  const fields = { ...channel.options, allow_from: "YOUR_USER_ID" };
  return `language = "zh"\ndata_dir = ${literal(stateDir)}\n\n[[projects]]\nname = ${literal(workspace.name)}\n\n[projects.agent]\ntype = "codex"\n\n[projects.agent.options]\nwork_dir = ${literal(workspace.path)}\ncodex_home = ${literal(codexHome)}\nbackend = "app_server"\napp_server_url = "stdio://"\nmode = "suggest"\n\n[[projects.platforms]]\ntype = ${literal(platform)}\n\n[projects.platforms.options]\n${Object.entries(
    fields,
  )
    .map(([key, value]) => `${key} = ${literal(value)}`)
    .join("\n")}\n`;
}
