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

  return { rollNo, subjectName };
}

/* ---------------------------
1) Existing general chatbot (KEEP) - Updated to gemini-3.0-flash-preview
---------------------------- */
router.post("/chat", async (req, res) => {
  try {
    const { message, studentEmail } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message required" });

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: "Server misconfigured: GEMINI_API_KEY missing" });
    }

    // ✅ Updated to gemini-3.0-flash-preview
    const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash-preview" });

    const prompt = `You are CMRIT Assistant. Student: ${studentEmail || "anonymous"}. Query: ${message}. Answer briefly.`;
    const result = await model.generateContent(prompt);

    const responseText =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to respond.";

    return res.json({ response: responseText });
  } catch (err) {
    return handleGeminiError(res, err);
  }
});

/* ---------------------------
2) Exam summary route (SIMPLIFIED) - Updated to gemini-3.0-flash-preview
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

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: "Server misconfigured: GEMINI_API_KEY missing" });
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

    // ✅ SIMPLIFIED PROMPT + gemini-3.0-flash-preview
    const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash-preview" });

    const prompt = `CMRIT Exam Review:

Roll No: ${String(rollNo).trim()}
Exam: ${folder.examName}
Subject: ${String(subject?.subjectName || subjectName).trim()}
Marks: ${marksObtained}/${maxMarks}

Give a short performance review with:
- Summary (2-3 lines)
- 3 areas to improve

Format exactly:
Summary:
Improvements:`;

    const result = await model.generateContent(prompt);
    const text =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to generate summary.";

    return res.json({
      response: text,
      meta: {
        rollNo: String(rollNo).trim(),
        examName: folder.examName,
        subjectName: subject?.subjectName || subjectName,
        marksObtained,
        maxMarks,
      },
    });
  } catch (err) {
    return handleGeminiError(res, err);
  }
});

module.exports = router;
