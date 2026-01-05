// exampaper.js (NEW) - Exam Papers + Marks module for IRAH/CMRIT portal
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

/* ---------------------------
   1) Upload folder (separate)
---------------------------- */
const EXAM_UPLOAD_DIR = path.join(__dirname, "exam_uploads");

if (!fs.existsSync(EXAM_UPLOAD_DIR)) {
  fs.mkdirSync(EXAM_UPLOAD_DIR, { recursive: true });
}

const examStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, EXAM_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const examUpload = multer({
  storage: examStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
});

/* ---------------------------
   2) Exam schema/model
   One doc = one "exam folder"
---------------------------- */
const examSubjectSchema = new mongoose.Schema(
  {
    subjectName: { type: String, required: true },
    marksObtained: { type: Number, required: true },
    maxMarks: { type: Number, default: 100 },
    scripts: [
      {
        fileName: String, // stored filename on server
        originalName: String,
        mimeType: String,
        size: Number,
        url: String, // convenience for frontend
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { _id: true }
);

const examFolderSchema = new mongoose.Schema(
  {
    studentRollNo: { type: String, required: true, index: true },
    studentEmail: { type: String }, // optional (for display)
    studentName: { type: String }, // optional (for display)

    mentorTeacherEmail: { type: String, required: true, index: true },
    examName: { type: String, required: true, index: true },

    subjects: [examSubjectSchema],
    published: { type: Boolean, default: true }, // keep simple: visible immediately
  },
  { timestamps: true }
);

// Avoid OverwriteModelError on hot reload / server restart
const ExamFolder =
  mongoose.models.ExamFolder || mongoose.model("ExamFolder", examFolderSchema);

/* ---------------------------
   Helpers
---------------------------- */
const normalize = (s) => String(s || "").trim();

const filePublicUrl = (req, fileName) =>
  `${req.protocol}://${req.get("host")}/exam_uploads/${fileName}`;

/* ---------------------------
   3) Teacher APIs
---------------------------- */

// Create/Get exam folder (teacher)
router.post("/teacher/create-folder", async (req, res) => {
  try {
    const { studentRollNo, mentorTeacherEmail, examName, studentEmail, studentName } = req.body;

    if (!normalize(studentRollNo) || !normalize(mentorTeacherEmail) || !normalize(examName)) {
      return res.status(400).json({ message: "studentRollNo, mentorTeacherEmail, examName are required" });
    }

    const rollNo = normalize(studentRollNo);
    const teacherEmail = normalize(mentorTeacherEmail).toLowerCase();
    const exName = normalize(examName);

    let folder = await ExamFolder.findOne({
      studentRollNo: rollNo,
      mentorTeacherEmail: teacherEmail,
      examName: exName,
    });

    if (!folder) {
      folder = await ExamFolder.create({
        studentRollNo: rollNo,
        mentorTeacherEmail: teacherEmail,
        examName: exName,
        studentEmail: normalize(studentEmail).toLowerCase() || undefined,
        studentName: normalize(studentName) || undefined,
        subjects: [],
        published: true,
      });
    }

    return res.json({ message: "Folder ready", folder });
  } catch (err) {
    console.error("create-folder error:", err);
    return res.status(500).json({ message: err?.message || "Server error" });
  }
});

// Add/Update a subject (teacher)
router.post("/teacher/:folderId/upsert-subject", async (req, res) => {
  try {
    const { folderId } = req.params;
    const { subjectName, marksObtained, maxMarks } = req.body;

    if (!normalize(subjectName) || marksObtained === undefined || marksObtained === null) {
      return res.status(400).json({ message: "subjectName and marksObtained are required" });
    }

    const folder = await ExamFolder.findById(folderId);
    if (!folder) return res.status(404).json({ message: "Exam folder not found" });

    const sName = normalize(subjectName);
    const markNum = Number(marksObtained);
    const maxNum = maxMarks !== undefined && maxMarks !== null ? Number(maxMarks) : 100;

    // find existing subject by name (case-insensitive)
    const idx = folder.subjects.findIndex(
      (s) => String(s.subjectName).toLowerCase() === sName.toLowerCase()
    );

    if (idx === -1) {
      folder.subjects.push({
        subjectName: sName,
        marksObtained: markNum,
        maxMarks: maxNum,
        scripts: [],
      });
    } else {
      folder.subjects[idx].marksObtained = markNum;
      folder.subjects[idx].maxMarks = maxNum;
    }

    await folder.save();
    return res.json({ message: "Subject saved", folder });
  } catch (err) {
    console.error("upsert-subject error:", err);
    return res.status(500).json({ message: err?.message || "Server error" });
  }
});

// Upload scripts for a subject (teacher)
router.post(
  "/teacher/:folderId/:subjectId/upload-scripts",
  examUpload.array("scripts", 10),
  async (req, res) => {
    try {
      const { folderId, subjectId } = req.params;

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No scripts uploaded" });
      }

      const folder = await ExamFolder.findById(folderId);
      if (!folder) return res.status(404).json({ message: "Exam folder not found" });

      const subject = folder.subjects.id(subjectId);
      if (!subject) return res.status(404).json({ message: "Subject not found" });

      req.files.forEach((f) => {
        subject.scripts.push({
          fileName: f.filename,
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
          url: filePublicUrl(req, f.filename),
        });
      });

      await folder.save();
      return res.json({ message: "Scripts uploaded", subject });
    } catch (err) {
      console.error("upload-scripts error:", err);
      return res.status(500).json({ message: err?.message || "Server error" });
    }
  }
);

/* ---------------------------
   4) Student APIs
---------------------------- */

// List exam folders by rollNo (student)
router.get("/student/folders", async (req, res) => {
  try {
    const { rollNo } = req.query;
    if (!normalize(rollNo)) return res.status(400).json({ message: "rollNo is required" });

    const folders = await ExamFolder.find({ studentRollNo: normalize(rollNo) })
      .sort({ createdAt: -1 });

    return res.json({ folders });
  } catch (err) {
    console.error("student/folders error:", err);
    return res.status(500).json({ message: err?.message || "Server error" });
  }
});

// Get one folder detail (student)
router.get("/student/folders/:folderId", async (req, res) => {
  try {
    const { folderId } = req.params;
    const { rollNo } = req.query;

    if (!normalize(rollNo)) return res.status(400).json({ message: "rollNo is required" });

    const folder = await ExamFolder.findById(folderId);
    if (!folder) return res.status(404).json({ message: "Folder not found" });

    if (normalize(folder.studentRollNo) !== normalize(rollNo)) {
      return res.status(403).json({ message: "Not allowed" });
    }

    return res.json({ folder });
  } catch (err) {
    console.error("student/folder detail error:", err);
    return res.status(500).json({ message: err?.message || "Server error" });
  }
});

module.exports = router;
