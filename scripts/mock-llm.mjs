import http from "node:http";

const PORT = 3999;

function sseChunks(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: c }] })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

http
  .createServer((req, res) => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const payload = JSON.parse(body);
      const respond = (message) => {
        if (payload.stream) {
          const chunks = [];
          if (message.tool_calls) {
            chunks.push({ tool_calls: message.tool_calls.map((t, index) => ({ index, ...t })) });
          }
          if (message.content) chunks.push({ content: message.content });
          sseChunks(res, chunks);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message }] }));
        }
      };
      const isCopywriter = payload.messages.some(
        (m) => m.role === "system" && String(m.content).includes("文案师")
      );
      const hasToolResult = payload.messages.some((m) => m.role === "tool");
      if (isCopywriter) {
        respond({ content: '{"body":"该给身体的水库补货啦 💧","tip":"喝水这件事，你比昨天做得更好"}' });
      } else if (!hasToolResult && payload.tools) {
        respond({
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "record_checkin", arguments: '{"theme":"water"}' } },
          ],
        });
      } else {
        respond({ content: "好的，已帮你打卡喝水 ✅" });
      }
    });
  })
  .listen(PORT, () => console.log(`mock llm on :${PORT}`));
