// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

/* ===================== MIDDLEWARE (ORDER FIXED) ===================== */
app.use(cors({
  origin: [
    'https://cmr-it-ihpn.onrender.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5000'
  ],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));      // ✅ MUST be BEFORE routes
app.use(express.urlencoded({ extended: true }));

app.use(helmet());
app.use(compression());
app.use(morgan('combined'));

/* ===================== CHATBOT ROUTES ===================== */
const chatbotRoutes = require('./chatbot');
app.use('/api', chatbotRoutes);   // /api/chat works now

/* ===================== UPLOADS ===================== */
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads', { recursive: true });
}

const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

/* ===================== RATE LIMIT ===================== */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

/* ===================== HEALTH ===================== */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    mongodbConfigured: !!process.env.MONGODB_URI,
  });
});

/* ===================== DATABASE ===================== */
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    process.exit(1);
  });

/* ===================== SCHEMAS (UNCHANGED) ===================== */
const userSchema = new mongoose.Schema({
  email: String,
  password: String,
  name: String,
  rollNo: String,
  mentorTeacherEmail: String,
  role: String,
  profile: Object
});

const attendanceSchema = new mongoose.Schema({
  studentEmail: String,
  date: String,
  slot: Number,
  status: String,
  subject: String,
  mentorTeacherEmail: String
});

const chatDataSchema = new mongoose.Schema({
  question: String,
  answer: String,
  keywords: [String]
});

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const ChatData = mongoose.model('ChatData', chatDataSchema);

module.exports = { User, Attendance, ChatData };

/* ===================== AUTH ROUTES (UNCHANGED) ===================== */
app.post('/api/auth/student-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const student = await User.findOne({ email, role: 'student' });
  if (!student)
    return res.status(401).json({ error: 'No student found with this email' });

  const ok = await bcrypt.compare(password, student.password);
  if (!ok)
    return res.status(401).json({ error: 'Incorrect password' });

  res.json({
    message: 'Student login successful',
    student: {
      name: student.name,
      email: student.email,
      rollNo: student.rollNo
    }
  });
});

/* ===================== STATIC & FALLBACK ===================== */
app.use('/uploads', express.static('uploads'));

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on ${PORT}`);
});
