// server.js - CMRIT Portal Backend

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const clubRoutes = require('./club');

const chatbotRoutes = require('./chatbot');
const examPaperRoutes = require("./exampaper");

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- BASIC SETUP ----------

// CORS for your frontend + local dev
app.use(cors({
  origin: ['https://cmr-it-ihpn.onrender.com', 'http://localhost:3000'],
  credentials: true
}));

app.use(helmet());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Mount chatbot routes
app.use('/api/chatbot', chatbotRoutes);

// Mount exam paper routes (ADDED RIGHT AFTER CHATBOT)
console.log("Mounting exam paper routes at /api/exams");
app.use("/api/exams", examPaperRoutes);
app.use('/api/clubs', clubRoutes);

// Create uploads folder if missing
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads', { recursive: true });
}

// Create dedicated exam uploads folder if missing (ADDED)
const examUploadsDir = path.join(__dirname, "exam_uploads");
if (!fs.existsSync(examUploadsDir)) {
  fs.mkdirSync(examUploadsDir, { recursive: true });
}

// Multer for file upload
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) =>
    cb(
      null,
      Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname)
    )
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Rate limiter for login endpoints (heavy load protection)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Health check (Render health + uptime tools)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongodbUriConfigured: !!process.env.MONGODB_URI,
    timestamp: new Date().toISOString()
  });
});

// ---------- MONGODB CONNECTION ----------

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is missing in .env / Render environment variables.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ MongoDB Atlas connected!');
  } catch (err) {
    console.error('❌ MongoDB Atlas connection failed:', err.message);
    process.exit(1);
  }
};

connectDB();

// Graceful shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});

// ---------- SCHEMAS & MODELS ----------

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true, minlength: 6 },
  name: { type: String, required: true },
  rollNo: String,
  mentorTeacherEmail: String,
  dept: String,
  role: { type: String, enum: ['student', 'teacher', 'admin'], default: 'student' },
  profile: {
    phone: String,
    branch: String,
    year: String,
    section: String,
    address: String,
    interests: String,
    guardianName: String,
    guardianPhone: String,
    bloodGroup: String,
    extraInfo: String,
    profileImageUrl: String
  }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  studentEmail: { type: String, required: true, index: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  slot: { type: Number, required: true, min: 1, max: 8 },
  status: { type: String, enum: ['present', 'absent'], required: true },
  subject: { type: String, required: true },
  mentorTeacherEmail: { type: String, required: true }
}, { timestamps: true });

userSchema.index({ email: 1 });
attendanceSchema.index({ studentEmail: 1, date: 1 });
attendanceSchema.index({ mentorTeacherEmail: 1, date: 1, slot: 1 });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// ---------- AUTH ROUTES ----------

// Student Login - POST /api/student/login
app.post('/api/student/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required' });

    if (!email.includes('cmrit.ac.in'))
      return res.status(400).json({ message: 'Please use your CMRIT email (student@cmrit.ac.in)' });

    const student = await User.findOne({ email, role: 'student' });
    if (!student) return res.status(401).json({ message: 'Login failed' });

    const match = await bcrypt.compare(password, student.password);
    if (!match) return res.status(401).json({ message: 'Login failed' });

    res.json({
      email: student.email,
      name: student.name,
      rollNo: student.rollNo,
      mentorTeacherEmail: student.mentorTeacherEmail
    });
  } catch (err) {
    console.error('Student login error:', err);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
});

// Teacher Login - POST /api/teacher/login
app.post('/api/teacher/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const teacher = await User.findOne({ email, role: 'teacher' });
    if (!teacher || !await bcrypt.compare(password, teacher.password)) {
      return res.status(401).json({ message: 'Teacher login failed' });
    }

    res.json({
      email: teacher.email,
      name: teacher.name,
      dept: teacher.dept
    });
  } catch (err) {
    console.error('Teacher login error:', err);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
});

// Admin Login (from .env) - POST /api/admin/login
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    // Fail closed if not configured
    if (!adminEmail || !adminPassword) {
      console.error('❌ ADMIN_EMAIL / ADMIN_PASSWORD missing in environment variables.');
      return res.status(500).json({ message: 'Admin credentials not configured on server' });
    }

    if (email === adminEmail && password === adminPassword) {
      return res.json({ email, name: 'Admin', role: 'admin' });
    }
    return res.status(401).json({ message: 'Admin login failed' });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
});

// ---------- STUDENT DASHBOARD ROUTES ----------

// Attendance Summary - GET /api/student/attendance-summary?email=...
app.get('/api/student/attendance-summary', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const records = await Attendance.find({ studentEmail: email });
    const totalClasses = records.length;
    const present = records.filter(r => r.status === 'present').length;
    const absent = totalClasses - present;
    const percentage = totalClasses ? Math.round((present / totalClasses) * 100) : 0;

    res.json({ totalClasses, present, absent, percentage });
  } catch (err) {
    console.error('Attendance summary error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Attendance Records - GET /api/student/attendance-records?email=...
app.get('/api/student/attendance-records', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const records = await Attendance.find({ studentEmail: email })
      .sort({ date: -1, slot: 1 })
      .limit(200);

    res.json({ records });
  } catch (err) {
    console.error('Attendance records error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Student Profile - GET /api/student/profile?email=...
app.get('/api/student/profile', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const student = await User.findOne({ email, role: 'student' });
    if (!student) return res.status(404).json({ message: 'Profile not found' });

    res.json({ profile: student.profile || {} });
  } catch (err) {
    console.error('Profile GET error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Student Profile - POST /api/student/profile
app.post('/api/student/profile', async (req, res) => {
  try {
    const {
      email, phone, branch, year, section, address,
      interests, guardianName, guardianPhone, bloodGroup, extraInfo
    } = req.body;

    if (!email) return res.status(400).json({ message: 'Email is required' });

    await User.updateOne(
      { email, role: 'student' },
      {
        $set: {
          'profile.phone': phone,
          'profile.branch': branch,
          'profile.year': year,
          'profile.section': section,
          'profile.address': address,
          'profile.interests': interests,
          'profile.guardianName': guardianName,
          'profile.guardianPhone': guardianPhone,
          'profile.bloodGroup': bloodGroup,
          'profile.extraInfo': extraInfo
        }
      },
      { upsert: false }
    );

    res.json({ message: 'Profile saved successfully!' });
  } catch (err) {
    console.error('Profile POST error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Student Profile Image - POST /api/student/profile-image
app.post('/api/student/profile-image', upload.single('image'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!req.file) return res.status(400).json({ message: 'No image uploaded' });

    const profileImageUrl = `/uploads/${req.file.filename}`;

    if (email) {
      await User.updateOne(
        { email, role: 'student' },
        { $set: { 'profile.profileImageUrl': profileImageUrl } }
      );
    }

    res.json({ profileImageUrl });
  } catch (err) {
    console.error('Profile image error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Serve uploaded images
app.use('/uploads', express.static('uploads'));

// Serve dedicated exam uploads folder (ADDED)
// Using absolute path is safer than relative when serving static files.
app.use("/exam_uploads", express.static(path.join(__dirname, "exam_uploads")));

// ---------- TEACHER DASHBOARD ROUTES ----------

// Get students by mentor - POST /api/admin/students-by-mentor
app.post('/api/admin/students-by-mentor', async (req, res) => {
  try {
    const { mentorTeacherEmail } = req.body;
    if (!mentorTeacherEmail)
      return res.status(400).json({ message: 'mentorTeacherEmail is required' });

    const students = await User.find({
      mentorTeacherEmail,
      role: 'student'
    }).select('email name rollNo _id');

    const studentsWithStatus = students.map(s => ({
      ...s.toObject(),
      id: s._id,
      present: false,
      absent: false
    }));

    res.json({ students: studentsWithStatus });
  } catch (err) {
    console.error('Students-by-mentor error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Mark attendance - POST /api/teacher/mark-attendance
app.post('/api/teacher/mark-attendance', async (req, res) => {
  try {
    const { mentorTeacherEmail, date, slot, subject, records } = req.body;

    if (!mentorTeacherEmail || !date || !slot || !subject || !records) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    await Attendance.deleteMany({ mentorTeacherEmail, date, slot: Number(slot) });

    const docs = records.map(r => ({
      studentEmail: r.studentEmail,
      date,
      slot: Number(slot),
      status: r.status,
      subject: subject.trim(),
      mentorTeacherEmail
    }));

    await Attendance.insertMany(docs);

    res.json({
      count: docs.length,
      message: `Attendance saved for ${date}, Slot ${slot} - ${subject}`
    });
  } catch (err) {
    console.error('Mark attendance error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ---------- ADMIN EXCEL UPLOAD ROUTES ----------

// Upload Students - POST /api/admin/upload-students
app.post('/api/admin/upload-students', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    const students = [];
    const emails = [];

    for (const row of rows) {
      if (!row.email) continue;
      const email = String(row.email).toLowerCase().trim();
      const passwordHash = await bcrypt.hash(String(row.password || 'password123'), 10);

      students.push({
        email,
        password: passwordHash,
        name: row.name || 'Student',
        rollNo: row.rollNo,
        mentorTeacherEmail: row.mentorTeacherEmail,
        role: 'student'
      });
      emails.push(email);
    }

    await User.deleteMany({ email: { $in: emails } });
    const result = await User.insertMany(students);

    fs.unlinkSync(req.file.path);

    res.json({
      message: `${result.length} students processed`,
      insertedCount: result.length
    });
  } catch (err) {
    console.error('Upload students error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Upload Teachers - POST /api/admin/upload-teachers
app.post('/api/admin/upload-teachers', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    const teachers = [];
    const emails = [];

    for (const row of rows) {
      if (!row.email) continue;
      const email = String(row.email).toLowerCase().trim();
      const passwordHash = await bcrypt.hash(String(row.password || 'password123'), 10);

      teachers.push({
        email,
        password: passwordHash,
        name: row.name || 'Teacher',
        dept: row.dept,
        role: 'teacher'
      });
      emails.push(email);
    }

    await User.deleteMany({ email: { $in: emails } });
    const result = await User.insertMany(teachers);

    fs.unlinkSync(req.file.path);

    res.json({
      message: `${result.length} teachers processed`,
      insertedCount: result.length
    });
  } catch (err) {
    console.error('Upload teachers error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get all students and teachers
app.get('/api/admin/list-users', async (req, res) => {
  try {
    const students = await User.find({ role: 'student' }).select(
      'email name rollNo mentorTeacherEmail'
    );
    const teachers = await User.find({ role: 'teacher' }).select(
      'email name dept'
    );
    res.json({ students, teachers });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ message: 'Failed to load users' });
  }
});

// ---------- ONE-TIME TEST DATA ROUTE (OPTIONAL) ----------

app.post('/api/setup-test-data', async (req, res) => {
  try {
    await User.deleteMany({
      email: { $in: ['student@cmrit.ac.in', 'teacher@cmrit.ac.in'] }
    });

    await User.insertMany([
      {
        email: 'student@cmrit.ac.in',
        password: await bcrypt.hash('password123', 10),
        name: 'Test Student',
        rollNo: '21CS001',
        role: 'student',
        mentorTeacherEmail: 'teacher@cmrit.ac.in'
      },
      {
        email: 'teacher@cmrit.ac.in',
        password: await bcrypt.hash('password123', 10),
        name: 'Test Teacher',
        dept: 'CSE',
        role: 'teacher'
      }
    ]);

    res.json({
      message: 'Test data created',
      studentLogin: "student@cmrit.ac.in / password123"
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- FALLBACKS & SERVER START ----------

// 404 fallback (keep after all routes/mounts).
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler (keep last).
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CMRIT Backend running on port ${PORT}`);
  console.log('✅ CORS for https://cmr-it-ihpn.onrender.com');
});
