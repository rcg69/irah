const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

/**
 * Build base URL for internal calls (Render/localhost safe).
 * Uses current request host so it works on deployed domain too.
 */
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

/**
 * Find a subject in latest folder by subject name (case-insensitive)
 */
function findSubjectInFolder(folder, subjectName) {
  const target = String(subjectName || "").trim().toLowerCase();
  if (!target) return null;

  const subjects = Array.isArray(folder?.subjects) ? folder.subjects : [];
  return subjects.find((s) => String(s?.subjectName || "").trim().toLowerCase() === target) || null;
}

/* ---------------------------
1) Existing general chatbot (KEEP)
---------------------------- */
router.post("/chat", async (req, res) => {
  try {
    const { message, studentEmail } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message required" });

    if (!process.env.GEMINI_API_KEY) {
      return res
        .status(500)
        .json({ message: "Server misconfigured: GEMINI_API_KEY missing" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
2) NEW: Exam summary + improvement from existing uploads
Input: { rollNo, subjectName, examName? }
Output: short summary for chatbot
---------------------------- */
router.post("/exam-summary", async (req, res) => {
  try {
    const { rollNo, subjectName, examName } = req.body;

    if (!rollNo || !subjectName) {
      return res.status(400).json({ message: "rollNo and subjectName are required" });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: "Server misconfigured: GEMINI_API_KEY missing" });
    }

    // 1) Fetch student folders from existing exams module
    const baseUrl = getBaseUrl(req);
    const foldersUrl = `${baseUrl}/api/exams/student/folders?rollNo=${encodeURIComponent(
      String(rollNo).trim()
    )}`;

    const foldersRes = await fetch(foldersUrl);
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

    // 2) Choose folder: if examName given => latest matching; else latest overall (folders are already sorted by backend)
    let folder =
      examName
        ? folders.find((f) => String(f?.examName || "").trim().toLowerCase() === String(examName).trim().toLowerCase())
        : folders[0];

    if (!folder) {
      return res.status(404).json({ message: "Exam not found for given examName" });
    }

    // 3) Find subject inside that folder
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
      .slice(0, 5); // keep prompt small

    // 4) Ask Gemini for summary + improvement (without pretending exact per-question mark split)
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
You are an exam feedback assistant for CMRIT.
Given: student roll number, subject, marks, and answer-script file links (teacher-uploaded scans/PDFs).

Task:
- Write a short summary of performance (3-5 lines).
- List 3 strengths (bullets).
- List 3 scope-of-improvement points (bullets).
- If the script links are provided, infer likely reasons for losing marks, but do NOT claim exact question-wise marks unless clearly visible.
- Keep it concise and student-friendly.

Input:
Roll No: ${String(rollNo).trim()}
Exam: ${folder.examName}
Subject: ${subject.subjectName}
Marks: ${marksObtained}/${maxMarks}
Answer script links: ${scriptLinks.length ? scriptLinks.join(", ") : "No script files uploaded."}
`;

    const result = await model.generateContent(prompt);
    const text =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to generate summary.";

    return res.json({
      response: text,
      meta: {
        rollNo: String(rollNo).trim(),
        examName: folder.examName,
        subjectName: subject.subjectName,
        marksObtained,
        maxMarks,
        scriptCount: scripts.length,
      },
    });
  } catch (err) {
    return handleGeminiError(res, err);
  }
});

module.exports = router;
