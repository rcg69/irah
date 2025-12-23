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

const app = express();
const PORT = process.env.PORT || 5000;

// Create uploads folder
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads', { recursive: true });
}

// File upload
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// CORS for your frontend
app.use(cors({ origin: ['https://cmr-it-ihpn.onrender.com', 'http://localhost:3000'] }));
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: 'Too many login attempts' }
});

// Health check
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  mongodb: !!process.env.MONGODB_URI ? 'configured' : 'missing MONGODB_URI'
}));

// MongoDB Connection (FIXED)
const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI missing from .env file!');
    console.log('Add to .env: MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Atlas connected!');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
};

// SCHEMAS (NO DUPLICATE INDEXES)
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  name: String,
  rollNo: String,
  mentorTeacherEmail: String,
  dept: String,
  role: { type: String, enum: ['student', 'teacher', 'admin'], default: 'student' },
  profile: {
    phone: String, branch: String, year: String, section: String,
    address: String, interests: String, guardianName: String,
    guardianPhone: String, bloodGroup: String, extraInfo: String,
    profileImageUrl: String
  }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  studentEmail: { type: String, required: true },
  date: { type: String, required: true },
  slot: { type: Number, required: true },
  status: { type: String, enum: ['present', 'absent'], required: true },
  subject: String,
  mentorTeacherEmail: String
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// Connect DB
connectDB();

// Test login data
app.post('/api/setup-test-data', async (req, res) => {
  try {
    await User.deleteMany({ email: { $in: ['student@cmrit.ac.in', 'teacher@cmrit.ac.in'] } });
    
    await User.create([{
      email: 'student@cmrit.ac.in',
      password: await bcrypt.hash('password123', 10),
      name: 'Test Student',
      rollNo: '21CS001',
      role: 'student',
      mentorTeacherEmail: 'teacher@cmrit.ac.in'
    }, {
      email: 'teacher@cmrit.ac.in',
      password: await bcrypt.hash('password123', 10),
      name: 'Test Teacher',
      dept: 'CSE',
      role: 'teacher'
    }]);
    
    res.json({ message: '✅ Test data created! Login: student@cmrit.ac.in / password123' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Student Login
app.post('/api/student/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email?.includes('cmrit.ac.in')) return res.status(400).json({ message: 'Use CMRIT email' });
    
    const student = await User.findOne({ email, role: 'student' });
    if (!student || !await bcrypt.compare(password, student.password)) {
      return res.status(401).json({ message: 'Login failed' });
    }
    
    res.json({
      email: student.email,
      name: student.name || 'Student',
      rollNo: student.rollNo,
      mentorTeacherEmail: student.mentorTeacherEmail
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Add other routes here (teacher login, attendance, etc.) from previous complete version...

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
});
