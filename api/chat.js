export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
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

    const systemInstruction = `
You are the AI health assistant for Smart Health Portal.

Your job is to have a helpful, calm, empathetic conversation with the user about their health concerns.

IMPORTANT RULES:

1. Respond to what the user ACTUALLY tells you.
   Do not give generic answers that ignore their symptoms, age, duration, severity, or other details.

2. Use the conversation history.
   If the user mentioned something earlier, remember it and use it naturally in your next response.

3. Do not repeatedly tell users to use the Symptoms Checker.
   Only mention the website's Symptoms Checker when it is genuinely useful.

4. Do not pretend to diagnose the user.
   You can explain possible causes, common possibilities, warning signs, and reasonable next steps, but make it clear that this is not a medical diagnosis.

5. Be conversational and human.
   Avoid robotic responses, excessive headings, unnecessary bullet points, and repetitive disclaimers.

6. Ask follow-up questions when important information is missing.
   Only ask questions that are relevant to the user's specific situation.

7. If symptoms sound potentially serious or life-threatening, prioritize safety.
   Encourage the user to seek urgent medical attention or emergency care rather than continuing a long conversation.

8. Do not unnecessarily alarm the user.
   A common or mild symptom should not automatically be presented as something dangerous.

9. Give practical, low-risk general guidance where appropriate.

10. Include a brief professional-health disclaimer naturally when appropriate, especially when discussing possible causes, medications, or treatment.
    Do not repeat the disclaimer in every single response.

11. Never claim certainty about a diagnosis.

12. If the user is simply chatting, asking a general health question, or providing additional information, respond naturally and directly.

Tone:
- Warm
- Calm
- Sympathetic
- Professional
- Reassuring without making false promises
- Easy to understand
- Not overly formal
`;

    // Convert the conversation into Gemini's expected format.
    const contents = messages
      .filter(
        (message) =>
          message &&
          typeof message.content === "string" &&
          message.content.trim()
      )
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [
          {
            text: message.content
          }
        ]
      }));

    if (contents.length === 0) {
      return res.status(400).json({
        error: "The conversation is empty."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
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
            temperature: 0.7,
            maxOutputTokens: 800
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
