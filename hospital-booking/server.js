require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  dateStrings: true,
  connectionLimit: 10,
});

const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d));

// Health check (useful for Azure)
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/api/departments', async (_, res) => {
  const [rows] = await pool.query('SELECT id, name, description FROM departments ORDER BY name');
  res.json(rows);
});

app.get('/api/doctors', async (req, res) => {
  const dept = Number(req.query.department_id);
  const [rows] = await pool.query(
    'SELECT id, name, title, work_days, start_time, end_time FROM doctors WHERE department_id = ? ORDER BY name',
    [dept]
  );
  res.json(rows);
});

// Free slots for one doctor on one date
app.get('/api/doctors/:id/slots', async (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'Use date as YYYY-MM-DD' });
  if (date < new Date().toISOString().slice(0, 10)) return res.json([]);

  const [[doc]] = await pool.query('SELECT * FROM doctors WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Doctor not found' });

  const weekday = new Date(date + 'T00:00:00').getDay();
  if (!doc.work_days.split(',').map(Number).includes(weekday)) return res.json([]);

  const [booked] = await pool.query(
    'SELECT appt_time FROM appointments WHERE doctor_id = ? AND appt_date = ?',
    [doc.id, date]
  );
  const taken = new Set(booked.map((b) => b.appt_time.slice(0, 5)));

  const now = new Date();
  const today = date === now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const slots = [];
  for (let m = toMin(doc.start_time); m + doc.slot_minutes <= toMin(doc.end_time); m += doc.slot_minutes) {
    const t = toHHMM(m);
    if (!taken.has(t) && !(today && m <= nowMin)) slots.push(t);
  }
  res.json(slots);
});

app.post('/api/appointments', async (req, res) => {
  const { doctor_id, date, time, patient_name, phone, email, reason } = req.body || {};
  if (!doctor_id || !isDate(date) || !/^\d{2}:\d{2}$/.test(time || '') || !patient_name || !/^[0-9+\-\s]{7,20}$/.test(phone || ''))
    return res.status(400).json({ error: 'Please fill in name, a valid phone, date and time.' });

  const ref = 'HX' + Math.random().toString(36).slice(2, 8).toUpperCase();
  try {
    await pool.query(
      `INSERT INTO appointments (ref_code, doctor_id, appt_date, appt_time, patient_name, phone, email, reason)
       VALUES (?,?,?,?,?,?,?,?)`,
      [ref, doctor_id, date, time + ':00', patient_name.trim(), phone.trim(), email || null, reason || null]
    );
    res.status(201).json({ ref_code: ref });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That slot was just taken. Please pick another.' });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

const port = process.env.PORT || 3000; // Azure App Service sets PORT for you
app.listen(port, () => console.log('Hospital booking running on port ' + port));
