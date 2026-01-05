const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const router = express.Router();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ✅ Extract retryDelay from Gemini error details (e.g., "4s", "32s")
function parseRetryDelayMs(err) {
  try {
    const details =
      err?.errorDetails ||
      err?.details ||
      err?.response?.data?.error?.details ||
      err?.error?.details ||
      [];

    if (!Array.isArray(details)) return null;

    const retryInfo = details.find(
      (d) =>
        d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' &&
        typeof d?.retryDelay === 'string'
    );

    if (!retryInfo?.retryDelay) return null;

    const m = retryInfo.retryDelay.trim().match(/^(\d+(?:\.\d+)?)s$/i);
    if (!m) return null;

    return Math.ceil(Number(m[1]) * 1000);
  } catch {
    return null;
  }
}

router.post('/chat', async (req, res) => {
  try {
    const { message, studentEmail } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: 'Message required' });

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: 'Server misconfigured: GEMINI_API_KEY missing' });
    }

    // ✅ 2026 WORKING MODELS
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are CMRIT Assistant. Student: ${studentEmail || 'anonymous'}. Query: ${message}. Answer briefly.`;

    const result = await model.generateContent(prompt);
    const responseText =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Unable to respond.';

    res.json({ response: responseText });
  } catch (err) {
    const status = err?.status || err?.code;

    // ✅ Handle rate limit / quota errors properly
    if (status === 429 || String(err?.message || '').includes('429')) {
      const retryAfterMs = parseRetryDelayMs(err) ?? 5000; // fallback 5s
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      console.error('🚨 Gemini 429/quota:', err);

      return res.status(429).json({
        message: `Rate limit exceeded. Please try again in ${retryAfterSec}s.`,
        retryAfterMs,
        type: 'RATE_LIMIT'
      });
    }

    // ✅ Other errors
    console.error('🚨 Gemini error:', err);
    res.status(500).json({
      message: err?.message || 'Chat service error',
      type: 'SERVER_ERROR'
    });
  }
});

module.exports = router;
