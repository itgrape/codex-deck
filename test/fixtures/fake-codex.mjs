import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let threadSequence = 0;
let threadId = "";
let prompt = "";
let approvalPending = false;
const complete = () => {
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId,
      itemId: "message-1",
      delta:
        prompt === "environment"
          ? JSON.stringify({
              BUILD_MODE: process.env.BUILD_MODE,
              TASK_VALUE: process.env.TASK_VALUE,
              HTTP_PROXY: process.env.HTTP_PROXY,
              http_proxy: process.env.http_proxy,
            })
          : "mock native output",
    },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: "turn-1", status: "completed" } },
  });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    return send({ id: m.id, result: { userAgent: "fixture" } });
  if (m.method === "initialized") return;
  if (m.method === "thread/start") {
    threadId = `thread-${++threadSequence}`;
    return send({ id: m.id, result: { thread: { id: threadId } } });
  }
  if (m.method === "thread/list")
    return send({ id: m.id, result: { data: [], nextCursor: null } });
  if (m.method === "turn/start") {
    prompt = m.params.input[0].text;
    send({
      id: m.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    if (prompt === "hang") return;
    if (prompt === "approval") {
      approvalPending = true;
      return send({
        id: 888,
        method: "item/commandExecution/requestApproval",
        params: { command: "git status", threadId, turnId: "turn-1" },
      });
    }
    return setTimeout(complete, 10);
  }
  if (approvalPending && m.id === 888) {
    approvalPending = false;
    return complete();
  }
  if (m.method === "fixture/environment")
    return send({
      id: m.id,
      result: Object.fromEntries(
        [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
          "no_proxy",
        ]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
    });
  if (m.method === "fixture/echo") return send({ id: m.id, result: m.params });
  if (m.method === "fixture/exit") return process.exit(2);
  if (m.method === "fixture/error")
    return send({ id: m.id, error: { code: -1, message: "native error" } });
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
