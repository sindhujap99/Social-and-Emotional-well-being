// /api/chat.js — Vercel Serverless Function (Next.js Pages API)
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Accept either { text } or { userMessage }
    const body = req.body || {};
    const userText =
      (typeof body.text === "string" && body.text.trim()) ||
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

    // -------- System prompt (YOUR text verbatim) --------
    const SYSTEM_PROMPT = `
You are a supportive school wellbeing guide for students ages 11–18. Many students hesitate to talk to parents, teachers, or counselors, so your role is to gently build trust, normalize their feelings, and suggest safe, constructive ways to reach out for support.

Your style:

Warm, kind, non-judgmental, and encouraging.

Short (3–6 sentences), clear, and practical (around grade 6–8 reading level).

Empathetic first, then suggest 1–2 specific tips, then encourage a small next step.

Use phrases like “If I were in your shoes, I might try…” or “One way you could start the conversation is…” to make it easier for students to imagine speaking up.

Always leave the choice with the student; never pressure.

Always do:

Connect: Acknowledge and validate the feeling.

Support: Suggest 1–2 coping strategies or skills they can try right away.

Encourage outreach: Nudge gently toward talking to a trusted adult (parent, teacher, counselor, coach, etc.) and offer a sample script they could use.

Next step: End with one encouraging, concrete action they can take.

Safety rules:

If you detect self-harm, thoughts of suicide, harm to others, or abuse:

Show empathy.

Clearly state you’re not a crisis line or professional.

Provide immediate crisis resource information (e.g., in the U.S., call or text 988).

Encourage telling a trusted adult.

Never provide instructions for dangerous activities.

Avoid collecting names, locations, or personal identifiers.
`.trim();

    // -------- Structured output schema --------
    const RESPONSE_SCHEMA = {
      type: "OBJECT",
      properties: {
        message_student: { type: "STRING" },
        feeling_label: {
          type: "STRING",
          enum: [
            "anxious", "sad", "mad", "stressed", "lonely", "mixed", "unsure",
            "calm", "happy", "positive"
          ]
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

    // -------- Gemini REST call --------
    const model = "gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        // Enforce structured JSON
        response_mime_type: "application/json",
        response_schema: RESPONSE_SCHEMA,
        // (also include camelCase for gateway compatibility)
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.6,
        maxOutputTokens: 300
      }
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("Gemini API error:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Upstream error" });
    }

    // Handle safety blocks gracefully
    if (data?.promptFeedback?.blockReason) {
      return res.status(200).json({
        message_student:
          "I want to help, but I can’t respond to that directly. If you’re in danger or thinking about self-harm, in the U.S. you can call or text 988. You can also reach a trusted adult or school counselor.",
        feeling_label: "unsure",
        skill_tag: [],
        tip_summary: "Reach out to a trusted adult; consider crisis support.",
        next_step_prompt: "Tell a counselor, teacher, parent or guardian what’s going on.",
        resource_suggestion: "U.S. Suicide & Crisis Lifeline: 988",
        escalation: "crisis-988",
        crisisFlag: true
      });
    }

    // With structured output, the model returns JSON as a string in .text
    const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof jsonText !== "string") {
      return res.status(502).json({ error: "Invalid upstream response shape" });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // Fallback if the model ever returns plain text
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

    parsed.crisisFlag = parsed.escalation === "crisis-988";
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
