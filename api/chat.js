// /api/chat.js — Vercel Serverless Function (Next.js Pages API)
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Accept either { text } or { userMessage } for convenience
    const body = req.body || {};
    const userText = (typeof body.text === "string" && body.text.trim()) ||
                     (typeof body.userMessage === "string" && body.userMessage.trim());
    if (!userText) {
      return res.status(400).json({ error: "Missing 'text' (or 'userMessage')" });
    }
    if (userText.length > 2000) {
      return res.status(413).json({ error: "Input too long" });
    }

    const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY on server" });
    }

    // ---------- System prompt (trust-building + safety) ----------
    const SYSTEM_PROMPT = `
You are a supportive school wellbeing guide for students ages 11–18. Many students hesitate to talk to parents, teachers, or counselors, so your role is to gently build trust, normalize their feelings, and suggest safe, constructive ways to reach out for support.

Your style:
- Warm, kind, non-judgmental, and encouraging.
- Short (3–6 sentences), clear, and practical (about grade 6–8 reading level).
- Empathetic first, then 1–2 specific tips, then a small next step.
- You can use phrases like “If I were in your shoes, I might try…” or “One way you could start the conversation is…”
- Always leave the choice with the student; never pressure.

Always do:
1) Connect: Acknowledge and validate the feeling.
2) Support: Offer 1–2 coping strategies or skills to try now.
3) Encourage outreach: Gently nudge toward a trusted adult (parent, teacher, counselor, coach) and offer a short script.
4) Next step: End with one encouraging, concrete action.

Safety rules:
- If you detect self-harm, suicidal thoughts, harm to others, or abuse: Show empathy; state you’re not a crisis line or professional; provide immediate crisis resource info (US: call/text 988); encourage telling a trusted adult.
- Never provide instructions for dangerous activities.
- Avoid collecting names, locations, or other personal identifiers.
`.trim();

    // ---------- Structured output schema (Gemini REST expects these UPPERCASE types) ----------
    const RESPONSE_SCHEMA = {
      type: "OBJECT",
      properties: {
        message_student: { type: "STRING" },
        feeling_label: {
          type: "STRING",
          enum: ["anxious", "sad", "mad", "stressed", "lonely", "mixed", "unsure"]
        },
        skill_tag: { type: "ARRAY", items: { type: "STRING" } },
        tip_summary: { type: "STRING" },
        next_step_prompt: { type: "STRING" },
        resource_suggestion: { type: "STRING" },
        escalation: {
          type: "STRING",
          enum: ["none", "encourage-counselor", "crisis-988"]
        }
      },
      required: [
        "message_student",
        "feeling_label",
        "skill_tag",
        "tip_summary",
        "next_step_prompt",
        "escalation"
      ],
      // Optional: helps keep field order predictable in some SDKs/tools
      propertyOrdering: [
        "message_student",
        "feeling_label",
        "skill_tag",
        "tip_summary",
        "next_step_prompt",
        "resource_suggestion",
        "escalation"
      ]
    };

    // ---------- Gemini REST call ----------
    const model = "gemini-2.5-flash"; // fast + solid for this use case
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userText }]
        }
      ],
      generationConfig: {
        // Enforce JSON output with your schema
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      }
      // Optionally: add safetySettings here if you want custom thresholds
      // safetySettings: [ ... ]
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();

    if (!r.ok) {
      // Log full upstream error for debugging; surface safe message to client
      console.error("Gemini API error:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Upstream error" });
    }

    // With structured output on, the model's text is a JSON string matching your schema
    const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof jsonText !== "string") {
      return res.status(502).json({ error: "Invalid upstream response shape" });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // Fallback: wrap raw text if model ever returns plain text
      parsed = {
        message_student: jsonText,
        feeling_label: "unsure",
        skill_tag: [],
        tip_summary: "",
        next_step_prompt: "",
        resource_suggestion: "",
        escalation: "none"
      };
    }

    // Convenience flag for your UI
    parsed.crisisFlag = parsed.escalation === "crisis-988";

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}


