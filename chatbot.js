const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const router = express.Router();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/chat', async (req, res) => {
  try {
    const { message, studentEmail } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: 'Message required' });

    // ✅ 2026 WORKING MODELS (from Google docs)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are CMRIT Assistant. Student: ${studentEmail || 'anonymous'}. Query: ${message}. Answer briefly.`;

    const result = await model.generateContent(prompt);
    const responseText = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Unable to respond.';

    res.json({ response: responseText });
  } catch (err) {
    console.error('🚨 Gemini:', err.message);
    res.status(500).json({ message: 'Chat error (check model)' });
  }
});

module.exports = router;
