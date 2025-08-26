console.log("Try programiz.pro");
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const DEV = process.env.NODE_ENV !== "production";

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

function send(res, status, json) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(json);
}

function coerceJsonFromModel(text) {
  if (typeof text !== "string") return null;

  let s = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2018\u2019\u2032]/g, "'");

  try { return JSON.parse(s); } catch {}

  const match = s.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    if (!API_KEY) {
      return send(res, 500, { error: "Missing GEMINI_API_KEY on server" });
    }

    const body = req.body || {};
    const raw =
      (typeof body.text === "string" ? body.text : "") ||
      (typeof body.userMessage === "string" ? body.userMessage : "");
    const userText = (raw || "").trim().replace(/\s+/g, " ");

    if (!userText) return send(res, 400, { error: "Missing 'text' (or 'userMessage')" });
    if (userText.length > 2000) return send(res, 413, { error: "Input too long" });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.6,
        maxOutputTokens: 300
      }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let data;
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      data = await r.json();

      if (!r.ok) {
        const msg = data?.error?.message || "Upstream error";
        if (DEV) console.error("Gemini API error", { status: r.status, msg });
        clearTimeout(timeout);
        return send(res, r.status, { error: DEV ? `Upstream ${r.status}: ${msg}` : "Upstream error" });
      }
    } catch (err) {
      clearTimeout(timeout);
      const aborted = err?.name === "AbortError";
      if (DEV) console.error("Gemini fetch failed", { aborted, err: String(err) });
      return send(res, 504, { error: aborted ? "Upstream timeout" : "Upstream fetch failed" });
    } finally {
      clearTimeout(timeout);
    }

    if (data?.promptFeedback?.blockReason) {
      return send(res, 200, {
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

    const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof jsonText !== "string") {
      return send(res, 502, { error: "Invalid upstream response shape" });
    }
    if (DEV) {
      console.log("Gemini text len:", jsonText.length);
      console.log("Gemini preview:", jsonText.slice(0, 200));
    }

    let parsed = coerceJsonFromModel(jsonText);
    if (!parsed) {
      parsed = {
        message_student:
          "I want to help, but I couldn’t process that. Could you say it a different way?",
        feeling_label: "unsure",
        skill_tag: [],
        tip_summary: "",
        next_step_prompt: "",
        resource_suggestion: "",
        escalation: "none"
      };
    }

    parsed.crisisFlag = parsed.escalation === "crisis-988";
    return send(res, 200, parsed);
  } catch (err) {
    if (DEV) console.error("Server error:", err);
    return send(res, 500, { error: "Server error" });
  }
}
