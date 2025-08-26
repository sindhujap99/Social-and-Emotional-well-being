// /pages/api/chat.js — Vercel Serverless Function (Next.js Pages API)

// Env
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const DEV = process.env.NODE_ENV !== "production";

/* ---------------------- System Prompt (updated) ---------------------- */
const SYSTEM_PROMPT = `
You are a supportive wellbeing guide for students ages 11–18.
Your main role: listen kindly, make them feel understood, and gently suggest safe ways to cope or get help.
Many students feel nervous about talking to parents, teachers, or counselors — build trust first.

STYLE
- Warm, kind, encouraging.
- Short and clear (3–6 sentences, around grade 6–8 reading level).
- First: show empathy.
- Then: give 1–2 simple, practical tips they can try.
- Finally: suggest one small step toward talking to a trusted adult.
- Use phrases like “If I were in your shoes, I might try…” or “One way you could start is…”.
- Always leave the choice with the student; never pressure.

STRUCTURE
1) Connect → Acknowledge and validate their feeling.
2) Support → Offer 1–2 coping skills they can try now.
3) Encourage outreach → Gently nudge to talk with a trusted adult (parent, teacher, counselor, coach, etc.) and include a short sample script.
4) Next step → End with one positive, concrete action.

SAFETY
- If self-harm, suicidal thoughts, harm to others, or abuse:
  • Show empathy first.
  • State you are not a crisis line or professional.
  • Share immediate crisis info (in the U.S., call or text 988).
  • Encourage telling a trusted adult right away.
- Never give dangerous instructions.
- Never ask for personal identifiers (names, locations, etc.).

IMPORTANT OUTPUT RULES
- Respond ONLY with a valid JSON object with these fields:
  message_student (string),
  feeling_label (one of: anxious, sad, mad, stressed, lonely, mixed, unsure, calm, happy, positive),
  skill_tag (array of strings),
  tip_summary (string),
  next_step_prompt (string),
  resource_suggestion (string, optional),
  escalation (one of: none, encourage-counselor, crisis-988).
- Do NOT include any extra text, comments, or code fences.
- Do NOT repeat keys or add unspecified fields.
- The JSON must be directly parseable by JavaScript JSON.parse.
`.trim();

/* ---------------------- Helpers ---------------------- */
function send(res, status, json) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(json);
}

function coerceJsonFromModel(text) {
  if (typeof text !== "string") return null;

  // Strip ```json fences & normalize quotes
  let s = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2018\u2019\u2032]/g, "'");

  // Try parse directly
  try { return JSON.parse(s); } catch {}

  // Regex rescue: first {...} block
  const match = s.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

/* ---------------------- Handler ---------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    if (!API_KEY) {
      return send(res, 500, { error: "Missing GEMINI_API_KEY on server" });
    }

    // Accept either { text } or { userMessage }
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
        // Keep JSON-only output; omit responseSchema to avoid INVALID_ARGUMENT
        responseMimeType: "application/json",
        temperature: 0.6,
        maxOutputTokens: 300
      }
    };

    // Timeout protection
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
        console.error("Gemini API error", { status: r.status, msg });
        clearTimeout(timeout);
        return send(res, r.status, { error: DEV ? `Upstream ${r.status}: ${msg}` : "Upstream error" });
      }
    } catch (err) {
      clearTimeout(timeout);
      const aborted = err?.name === "AbortError";
      console.error("Gemini fetch failed", { aborted, err: String(err) });
      return send(res, 504, { error: aborted ? "Upstream timeout" : "Upstream fetch failed" });
    } finally {
      clearTimeout(timeout);
    }

    // Safety block → safe minimal object
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

    // Parse model text (should be JSON)
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
    console.error("Server error:", err);
    return send(res, 500, { error: "Server error" });
  }
}
