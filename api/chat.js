export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { messages, message, history } = req.body || {};

    // Support both formats used by the frontend
    const conversationMessages =
      Array.isArray(messages) && messages.length > 0
        ? messages
        : [
            ...(Array.isArray(history) ? history : []),
            ...(typeof message === "string" && message.trim()
              ? [{ role: "user", content: message }]
              : [])
          ];

    if (
      !Array.isArray(conversationMessages) ||
      conversationMessages.length === 0
    ) {
      return res.status(400).json({
        error: "No conversation messages were provided."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing.");

      return res.status(500).json({
        error: "Gemini API key is not configured on the server."
      });
    }

    /*
     * Keep only the most recent conversation messages.
     * This prevents the request from becoming slower as the
     * conversation gets longer while still preserving context.
     */
    const recentMessages = conversationMessages
      .filter(
        (item) =>
          item &&
          typeof item.content === "string" &&
          item.content.trim() &&
          (item.role === "user" || item.role === "assistant" || item.role === "model")
      )
      .slice(-12);

    const contents = recentMessages.map((item) => ({
      role: item.role === "assistant" ? "model" : item.role,
      parts: [
        {
          text: item.content.trim()
        }
      ]
    }));

    if (contents.length === 0) {
      return res.status(400).json({
        error: "The conversation is empty."
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
- Prefer a clear answer in a few short paragraphs or brief bullet points when helpful.
- If the user is simply chatting, respond naturally.

Never present general information as a medical diagnosis.
`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: systemInstruction
              }
            ]
          },
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 1000
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Gemini was unable to generate a response."
      });
    }

    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();

    if (!reply) {
      return res.status(500).json({
        error: "Gemini returned an empty response."
      });
    }

    return res.status(200).json({
      reply
    });
  } catch (error) {
    console.error("Chat API error:", error);

    return res.status(500).json({
      error: "Something went wrong while connecting to the AI assistant."
    });
  }
}
