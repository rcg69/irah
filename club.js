const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

/* -------------------- SCHEMAS -------------------- */

const clubSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  presidentEmail: { type: String, required: true },
  members: [{ type: String }],          // approved members (emails)
  pendingRequests: [{ type: String }],  // join requests
}, { timestamps: true });

const meetingSchema = new mongoose.Schema({
  clubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Club' },
  date: String,
  topic: String,
  notes: String
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  clubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Club' },
  senderEmail: String,
  senderName: String,
  text: String
}, { timestamps: true });

const Club = mongoose.model('Club', clubSchema);
const ClubMeeting = mongoose.model('ClubMeeting', meetingSchema);
const ClubMessage = mongoose.model('ClubMessage', messageSchema);

/* -------------------- ROUTES -------------------- */

/**
 * CREATE CLUB (President)
 * POST /api/clubs/create
 */
router.post('/create', async (req, res) => {
  try {
    const { name, description, presidentEmail } = req.body;

    if (!name || !presidentEmail) {
      return res.status(400).json({ message: 'Club name and president email required' });
    }

    const club = await Club.create({
      name,
      description,
      presidentEmail,
      members: [presidentEmail]
    });

    res.json({ message: 'Club created', club });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET ALL CLUBS
 * GET /api/clubs
 */
router.get('/', async (req, res) => {
  try {
    const clubs = await Club.find().sort({ name: 1 });
    res.json({ clubs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET CLUBS BY STUDENT
 * GET /api/clubs/by-student?email=
 */
router.get('/by-student', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: 'Email required' });

    const clubs = await Club.find({
      members: email
    });

    res.json({ clubs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET CLUB DETAILS
 * GET /api/clubs/:clubId
 */
router.get('/:clubId', async (req, res) => {
  try {
    const { clubId } = req.params;

    const club = await Club.findById(clubId);
    if (!club) return res.status(404).json({ message: 'Club not found' });

    const meetings = await ClubMeeting.find({ clubId });
    const messages = await ClubMessage.find({ clubId }).sort({ createdAt: 1 });

    res.json({ club, meetings, messages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * REQUEST TO JOIN CLUB
 * POST /api/clubs/request-join
 */
router.post('/request-join', async (req, res) => {
  try {
    const { clubId, studentEmail } = req.body;

    const club = await Club.findById(clubId);
    if (!club) return res.status(404).json({ message: 'Club not found' });

    if (club.members.includes(studentEmail))
      return res.status(400).json({ message: 'Already a member' });

    if (!club.pendingRequests.includes(studentEmail)) {
      club.pendingRequests.push(studentEmail);
      await club.save();
    }

    res.json({ message: 'Join request sent' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * APPROVE MEMBER (President)
 * POST /api/clubs/approve-member
 */
router.post('/approve-member', async (req, res) => {
  try {
    const { clubId, studentEmail, presidentEmail } = req.body;

    const club = await Club.findById(clubId);
    if (!club) return res.status(404).json({ message: 'Club not found' });

    if (club.presidentEmail !== presidentEmail)
      return res.status(403).json({ message: 'Only president can approve' });

    club.pendingRequests = club.pendingRequests.filter(e => e !== studentEmail);
    club.members.push(studentEmail);

    await club.save();

    res.json({ message: 'Member approved' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * ADD MEETING
 * POST /api/clubs/add-meeting
 */
router.post('/add-meeting', async (req, res) => {
  try {
    const { clubId, date, topic, notes } = req.body;

    const meeting = await ClubMeeting.create({
      clubId, date, topic, notes
    });

    res.json({ message: 'Meeting added', meeting });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST MESSAGE (Discussion)
 * POST /api/clubs/post-message
 */
router.post('/post-message', async (req, res) => {
  try {
    const { clubId, senderEmail, senderName, text } = req.body;

    const msg = await ClubMessage.create({
      clubId, senderEmail, senderName, text
    });

    res.json({ message: 'Message sent', msg });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
