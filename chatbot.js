const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---- fetch fallback (Node < 18) ----
let fetchFn = global.fetch;
if (!fetchFn) {
  // npm i node-fetch@2
  fetchFn = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

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
        d?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo" &&
        typeof d?.retryDelay === "string"
    );

    if (!retryInfo?.retryDelay) return null;

    const m = retryInfo.retryDelay.trim().match(/^(\d+(?:\.\d+)?)s$/i);
    if (!m) return null;

    return Math.ceil(Number(m[1]) * 1000);
  } catch {
    return null;
  }
}

function handleGeminiError(res, err) {
  const status = err?.status || err?.code;

  if (status === 429 || String(err?.message || "").includes("429")) {
    const retryAfterMs = parseRetryDelayMs(err) ?? 5000;
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    console.error("🚨 Gemini 429/quota:", err);
    return res.status(429).json({
      message: `Rate limit exceeded. Please try again in ${retryAfterSec}s.`,
      retryAfterMs,
      type: "RATE_LIMIT",
    });
  }

  console.error("🚨 Gemini error:", err);
  return res.status(500).json({
    message: err?.message || "Chat service error",
    type: "SERVER_ERROR",
  });
}

// --- Generic text generation helper with fallback to OpenAI ---
async function generateText(prompt, opts = {}) {
  // Try Gemini first if configured
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = genAI.getGenerativeModel({ model: opts.geminiModel || "gemini-2.5-flash" });
      const result = await model.generateContent(prompt);
      const text = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text, source: 'gemini' };
      // If no text, throw to trigger fallback
      throw new Error('Empty response from Gemini');
    } catch (err) {
      // For known transient errors, allow fallback
      const msg = String(err?.message || '').toLowerCase();
      const status = err?.status || err?.code;
      if (status === 503 || msg.includes('overloaded') || msg.includes('service unavailable')) {
        console.warn('Gemini unavailable, falling back to OpenAI:', err?.message || err);
        // continue to OpenAI fallback
      } else if (status === 429 || msg.includes('rate limit')) {
        // propagate rate limit to caller
        const retryAfterMs = parseRetryDelayMs(err) ?? 5000;
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        const e = new Error(`Rate limited by Gemini. Try again in ${retryAfterSec}s.`);
        e.code = 'GEMINI_RATE_LIMIT';
        e.retryAfterMs = retryAfterMs;
        throw e;
      } else {
        // other errors: log and fallthrough to OpenAI if available
        console.warn('Gemini error, attempting OpenAI if available:', err?.message || err);
      }
    }
  }

  // Fallback to OpenAI if configured
  if (process.env.OPENAI_API_KEY) {
    try {
      const openaiModel = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
      const payload = {
        model: openaiModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts.maxTokens || 500,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3
      };

      const openaiRes = await fetchFn('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      });

      if (!openaiRes.ok) {
        const body = await openaiRes.text();
        throw new Error(`OpenAI error ${openaiRes.status}: ${body}`);
      }

      const data = await openaiRes.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) return { text, source: 'openai' };
      throw new Error('Empty response from OpenAI');
    } catch (err) {
      console.error('OpenAI fallback failed:', err);
      throw err;
    }
  }

  // No model available
  const e = new Error('No generative model available. Configure GEMINI_API_KEY or OPENAI_API_KEY.');
  e.code = 'NO_MODEL';
  throw e;
}

// Build base URL for internal calls (Render/localhost safe).
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function findSubjectInFolder(folder, subjectName) {
  const target = String(subjectName || "").trim().toLowerCase();
  if (!target) return null;
  const subjects = Array.isArray(folder?.subjects) ? folder.subjects : [];
  return (
    subjects.find((s) => String(s?.subjectName || "").trim().toLowerCase() === target) || null
  );
}

// Parse roll + subject from a free-form message
function extractRollAndSubject(message) {
  const text = String(message || "").trim();

  // roll patterns like 21CMR001 / 21CS001 etc
  const rollMatch = text.match(/\b\d{2}[A-Za-z]{2,6}\d{3,4}\b/);
  const rollNo = rollMatch ? rollMatch[0].toUpperCase() : null;

  // subject: try "subject DSA" or "exam DSA" or just "DSA"
  let subjectName = null;

  const subjectMatch =
    text.match(/\bsubject\s*[:\-]?\s*([A-Za-z& ]{2,25})\b/i) ||
    text.match(/\bexam\s*[:\-]?\s*([A-Za-z& ]{2,25})\b/i);

  if (subjectMatch?.[1]) subjectName = subjectMatch[1].trim();

  // fallback: common short all-caps token e.g., DSA, DBMS, OS, CN
  if (!subjectName) {
    const token = text.match(/\b(DSA|DBMS|OS|CN|COA|OOPS|AI|ML|SE)\b/i);
    if (token?.[1]) subjectName = token[1].toUpperCase();
  }

  // exam name extraction (e.g., "mid-1", "mid 1", "endsem", "end-sem")
  let examName = null;
  const examMatch =
    text.match(/\b(?:mid(?:\-?term)?|mid)\s*(?:\-)?\s*(\d)\b/i) ||
    text.match(/\bmid\-?1\b/i) ||
    text.match(/\bmid\-?2\b/i) ||
    text.match(/\bend(?:\-)??sem(?:ester)?\b/i) ||
    text.match(/\binternal\s*(?:\-)?\s*(\d)\b/i);

  if (examMatch) {
    // Normalize
    if (/mid/i.test(examMatch[0])) {
      const n = examMatch[1] || (examMatch[0].match(/\d/) || [])[0] || '1';
      examName = `Mid-${n}`;
    } else if (/internal/i.test(examMatch[0])) {
      const n = examMatch[1] || '1';
      examName = `Internal-${n}`;
    } else if (/end/i.test(examMatch[0])) {
      examName = 'End-Sem';
    }
  }

  return { rollNo, subjectName, examName };
}

/* ---------------------------
1) Existing general chatbot (KEEP)
---------------------------- */
router.post("/chat", async (req, res) => {
  try {
    const { message, studentEmail } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message required" });

    const prompt = `You are CMRIT Assistant. Student: ${studentEmail || "anonymous"}. Query: ${message}. Answer briefly.`;

    try {
      const { text, source } = await generateText(prompt, { maxTokens: 300 });
      return res.json({ response: text, model: source });
    } catch (err) {
      if (err?.code === 'GEMINI_RATE_LIMIT') {
        return res.status(429).json({ message: err.message, retryAfterMs: err.retryAfterMs });
      }
      return res.status(500).json({ message: err?.message || 'No model available' });
    }
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/* ---------------------------
2) Exam summary route (works with existing uploads)
Accepts:
- { message: "review my paper roll 21CMR001 subject DSA" }
OR
- { rollNo: "...", subjectName: "...", examName?: "Mid-1" }
---------------------------- */
router.post("/exam-summary", async (req, res) => {
  try {
    let { rollNo, subjectName, examName, message } = req.body;

    // Allow generic natural language
    if ((!rollNo || !subjectName) && message) {
      const extracted = extractRollAndSubject(message);
      rollNo = rollNo || extracted.rollNo;
      subjectName = subjectName || extracted.subjectName;
    }

    if (!rollNo || !subjectName) {
      return res.status(400).json({
        message:
          'Provide rollNo + subjectName, or a message like: "Give me a review of my paper roll 21CMR001 subject DSA".',
      });
    }

    // 1) Fetch student folders from existing exams module
    const baseUrl = getBaseUrl(req);
    const foldersUrl = `${baseUrl}/api/exams/student/folders?rollNo=${encodeURIComponent(
      String(rollNo).trim()
    )}`;

    const foldersRes = await fetchFn(foldersUrl);
    const foldersData = await foldersRes.json().catch(() => ({}));

    if (!foldersRes.ok) {
      return res.status(foldersRes.status).json({
        message: foldersData?.message || "Failed to load exam folders",
      });
    }

    if (!foldersRes.ok) {
      return res.status(foldersRes.status).json({
        message: foldersData?.message || "Failed to load exam folders",
      });
    }

    const folders = Array.isArray(foldersData?.folders) ? foldersData.folders : [];
    if (folders.length === 0) {
      return res.status(404).json({ message: "No exam folders found for this roll number" });
    }

    // 2) Choose folder
    let folder = examName
      ? folders.find(
          (f) =>
            String(f?.examName || "").trim().toLowerCase() ===
            String(examName).trim().toLowerCase()
        )
      : folders[0];

    if (!folder) {
      return res.status(404).json({ message: "Exam not found for given examName" });
    }

    // 3) Find subject
    const subject = findSubjectInFolder(folder, subjectName);
    if (!subject) {
      return res.status(404).json({
        message: `Subject "${subjectName}" not found in exam "${folder.examName}"`,
      });
    }

    const marksObtained = subject?.marksObtained;
    const maxMarks = subject?.maxMarks;
    const scripts = Array.isArray(subject?.scripts) ? subject.scripts : [];
    const scriptLinks = scripts
      .map((s) => s?.url)
      .filter(Boolean)
      .slice(0, 5);

    // 4) Build prompt & call generator (supports Gemini, falls back to OpenAI)
    const prompt = `You are CMRIT Exam Review Bot.
You DO have access to the student's exam data because it is provided below by the system from the CMRIT portal database.

Data from portal DB (trusted):
Roll No: ${String(rollNo).trim()}
Subject: ${String(subject?.subjectName || subjectName).trim()}
Exam Name: ${folder.examName}
Marks: ${marksObtained}/${maxMarks}
Answer script file links (teacher-uploaded): ${scriptLinks.length ? scriptLinks.join(", ") : "No script files uploaded."}

Task:
- Give a short review of the student’s performance (3–5 lines).
- Mention where marks were likely lost (3 bullet points) based on the scripts and marks.
- Give scope of improvement (3 bullet points) with actionable tips.
Rules:
- Do not mention privacy/confidentiality or say “I don’t have access”.
- If scripts are unclear, say “Script scan unclear” and base feedback on marks + common expectations for the subject.

Output format (plain text only):
Summary:
Marks lost:
Improvements:
`;

    try {
      const { text: reviewText, source } = await generateText(prompt, { maxTokens: 800 });

      return res.json({
        response: reviewText,
        meta: {
          rollNo: String(rollNo).trim(),
          examName: folder.examName,
          subjectName: subject?.subjectName || subjectName,
          marksObtained,
          maxMarks,
          scriptCount: scripts.length,
          model: source,
        },
      });
    } catch (err) {
      if (err?.code === 'GEMINI_RATE_LIMIT') {
        return res.status(429).json({ message: err.message, retryAfterMs: err.retryAfterMs });
      }
      console.error('Exam summary model error:', err);
      return res.status(500).json({ message: err?.message || 'Failed to generate review' });
    }
  } catch (err) {
    return handleGeminiError(res, err);
  }
});

module.exports = router;
