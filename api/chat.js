export const maxDuration = 60;

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { messages, message, history } = body || {};

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
      return new Response(JSON.stringify({ error: "No conversation messages were provided." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Gemini API key is not configured on the server." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
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
      return new Response(JSON.stringify({ error: "The conversation is empty." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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

    const geminiResponse = await fetch(
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
      }
    );

    if (!geminiResponse.ok || !geminiResponse.body) {
      const errText = await geminiResponse.text().catch(() => "");
      console.error("Gemini API error:", geminiResponse.status, errText);
      return new Response(
        JSON.stringify({ error: "Gemini was unable to generate a response.", detail: errText }),
        {
          status: geminiResponse.status || 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = geminiResponse.body.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
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
              const text =
                parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
              if (text) controller.enqueue(encoder.encode(text));
            } catch {
              // partial JSON chunk, wait for more data
            }
          }
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error?.message || error);
    return new Response(
      JSON.stringify({
        error: "Something went wrong while connecting to the AI assistant.",
        detail: error?.message || String(error),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
