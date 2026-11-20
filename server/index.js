import { createApp } from "./app.js";

const app = await createApp();
const host = process.env.DECK_HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3030);
app.server.listen(port, host, () => {
  console.log(`Codex Deck listening on http://${host}:${port}`);
  if (!process.env.DECK_TOKEN)
    console.log(
      `One-time access token (set DECK_TOKEN to keep it across restarts): ${app.token}`,
    );
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      process.exitCode = 0;
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    }
  });
