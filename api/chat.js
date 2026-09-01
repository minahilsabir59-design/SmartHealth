export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { messages, message, history } = req.body || {};

    const conversationMessages =
      Array.isArray(messages) && messages.length > 0
        ? messages
        : [
            ...(Array.isArray(history) ? history : []),
            ...(typeof message === "string" && message.trim()
              ? [{ role: "user", content: message }]
              : []),
          ];

    if (!Array.isArray(conversationMessages) || conversationMessages.length === 0) {
      res.status(400).json({ error: "No conversation messages were provided." });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing.");
      res.status(500).json({ error: "Gemini API key is not configured on the server." });
      return;
    }

    const recentMessages = conversationMessages
      .filter(
        (item) =>
          item &&
          typeof item.content === "string" &&
          item.content.trim() &&
          (item.role === "user" || item.role === "assistant" || item.role === "model")
      )
      .slice(-8);

    const contents = recentMessages.map((item) => ({
      role: item.role === "assistant" ? "model" : item.role,
      parts: [{ text: item.content.trim() }],
    }));

    if (contents.length === 0) {
      res.status(400).json({ error: "The conversation is empty." });
      return;
    }

    const systemInstruction = `
You are the AI health assistant for Smart Health Portal.

Give helpful, calm, accurate, easy-to-understand health guidance.

Rules:
- Answer the user's actual question and use relevant conversation context.
- Do not diagnose or claim certainty.
- Explain likely possibilities only when useful.
- Ask a relevant follow-up question when important information is missing.
- Give practical, low-risk general guidance when appropriate.
- If symptoms could indicate an emergency, clearly recommend urgent medical care.
- Do not unnecessarily alarm the user.
- Do not repeatedly mention the Symptoms Checker unless it is genuinely useful.
- Do not repeat disclaimers unnecessarily.
- Be warm, natural, and conversational.
- Avoid unnecessary headings and long lists.
- Be concise but complete. Do not leave an answer unfinished.
- If the user is simply chatting, respond naturally.

Never present general information as a medical diagnosis.
`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    let geminiResponse;
    try {
      geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents,
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 1000,
            },
          }),
          signal: controller.signal,
        }
      );
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      const isAbort = fetchErr?.name === "AbortError";
      console.error("Gemini fetch failed:", isAbort ? "TIMED OUT after 20s" : fetchErr?.message || fetchErr);
      res.status(504).json({
        error: isAbort ? "Gemini did not respond within 20 seconds." : "Could not reach Gemini.",
        detail: String(fetchErr?.message || fetchErr),
      });
      return;
    }
    clearTimeout(timeoutId);

    if (!geminiResponse.ok || !geminiResponse.body) {
      const errText = await geminiResponse.text().catch(() => "");
      console.error("Gemini API error:", geminiResponse.status, errText);
      res.status(geminiResponse.status || 500).json({
        error: "Gemini was unable to generate a response.",
        detail: errText,
      });
      return;
    }

    // Stream the reply back as plain text chunks, written directly to
    // the Node response object as they arrive from Gemini.
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    });

    const reader = geminiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentAny = false;

    while (true) {
      let result;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("stream stalled")), 20000)),
        ]);
      } catch (stallErr) {
        console.error("Gemini stream stalled mid-response:", stallErr.message);
        break;
      }

      const { done, value } = result;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const text = parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
          if (text) {
            res.write(text);
            sentAny = true;
          }
        } catch {
          // partial JSON chunk, wait for more data
        }
      }
    }

    if (!sentAny) {
      res.write("Sorry, I could not get a response. Please try again.");
    }
    res.end();
  } catch (error) {
    console.error("Chat API error:", error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Something went wrong while connecting to the AI assistant.",
        detail: error?.message || String(error),
      });
    } else {
      res.end();
    }
  }
}
