// /api/image.js — Vercel Serverless Function (Node 18+)
const { GoogleAuth } = require("google-auth-library");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing 'prompt' string" });
    }

    const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
    const LOCATION   = process.env.GOOGLE_LOCATION || "us-central1";
    const SA_KEY_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; // whole JSON string

    if (!PROJECT_ID || !SA_KEY_JSON) {
      return res.status(500).json({ error: "Missing GOOGLE_PROJECT_ID or GOOGLE_SERVICE_ACCOUNT_KEY" });
    }

    // Auth with service account (no file needed; we pass JSON)
    const auth = new GoogleAuth({
      credentials: JSON.parse(SA_KEY_JSON),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // Imagen / Image Generation model on Vertex AI (publisher model)
    // Model names change over time; these are commonly available:
    // - imagegeneration@006  (latest)
    // - imagegeneration@005
    const model = "imagegeneration@006";

    const endpoint =
      `https://${LOCATION}-aiplatform.googleapis.com/v1/` +
      `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        // Return an image. You can request PNG or JPEG.
        responseMimeType: "image/png",
        // Optional: smaller or larger output (defaults are fine)
        // "image": { "width": 1024, "height": 768 }
      }
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken.token || accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Vertex AI image error:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Upstream error" });
    }

    // Find the inline image in the response
    const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    const mime = part?.inlineData?.mimeType || "image/png";
    const b64  = part?.inlineData?.data;

    if (!b64) {
      return res.status(502).json({ error: "No image returned" });
    }

    // Return a data URL so the browser can show it directly
    return res.status(200).json({ dataUrl: `data:${mime};base64,${b64}` });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
