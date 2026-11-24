require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  dateStrings: true, connectionLimit: 10
});
const SECRET = process.env.JWT_SECRET || 'dev-secret';

// ---------- auth helpers ----------
const sign = u => jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '8h' });
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: 'Please log in first.' }); }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e); res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------- auth ----------
app.post('/api/auth/signup', wrap(async (req, res) => {
  const { name, email, password, adminCode } = req.body;
  if (!name || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required.' });
  let role = 'patient';
  if (adminCode) {
    if (adminCode !== process.env.ADMIN_SIGNUP_CODE)
      return res.status(403).json({ error: 'Wrong admin staff code.' });
    role = 'admin';
  }
  const [dup] = await pool.query('SELECT id FROM users WHERE email=?', [email]);
  if (dup.length) return res.status(409).json({ error: 'This email is already registered.' });
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)',
    [name, email, hash, role]);
  const u = { id: r.insertId, name, role };
  res.json({ token: sign(u), user: u });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM users WHERE email=?', [email]);
  if (!rows.length || !(await bcrypt.compare(password || '', rows[0].password_hash)))
    return res.status(401).json({ error: 'Wrong email or password.' });
  const u = { id: rows[0].id, name: rows[0].name, role: rows[0].role };
  res.json({ token: sign(u), user: u });
}));

// ---------- public data ----------
app.get('/api/departments', wrap(async (_, res) => {
  const [r] = await pool.query('SELECT * FROM departments ORDER BY name'); res.json(r);
}));
app.get('/api/doctors', wrap(async (req, res) => {
  const [r] = await pool.query(
    `SELECT d.id, d.name, d.title, d.department_id, dp.name AS department
     FROM doctors d JOIN departments dp ON dp.id=d.department_id
     WHERE (? IS NULL OR d.department_id=?) ORDER BY d.name`,
    [req.query.department_id || null, req.query.department_id || null]);
  res.json(r);
}));
app.get('/api/doctors/:id/slots', wrap(async (req, res) => {
  const [r] = await pool.query(
    `SELECT id, slot_start FROM slots
     WHERE doctor_id=? AND is_booked=0 AND slot_start > NOW() ORDER BY slot_start LIMIT 200`,
    [req.params.id]);
  res.json(r);
}));

// ---------- patient: appointments ----------
app.post('/api/appointments', auth, wrap(async (req, res) => {
  const { slot_id, reason } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // atomic claim: only one person can flip is_booked from 0 to 1
    const [u] = await conn.query(
      'UPDATE slots SET is_booked=1 WHERE id=? AND is_booked=0 AND slot_start > NOW()', [slot_id]);
    if (!u.affectedRows) { await conn.rollback(); return res.status(409).json({ error: 'That slot was just taken. Please pick another.' }); }
    await conn.query('INSERT INTO appointments (user_id,slot_id,reason) VALUES (?,?,?)',
      [req.user.id, slot_id, reason || null]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.get('/api/appointments/mine', auth, wrap(async (req, res) => {
  const [r] = await pool.query(
    `SELECT a.id, a.status, a.reason, s.slot_start, d.name AS doctor, dp.name AS department
     FROM appointments a JOIN slots s ON s.id=a.slot_id
     JOIN doctors d ON d.id=s.doctor_id JOIN departments dp ON dp.id=d.department_id
     WHERE a.user_id=? ORDER BY s.slot_start DESC`, [req.user.id]);
  res.json(r);
}));

app.delete('/api/appointments/:id', auth, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM appointments WHERE id=? AND status="booked"', [req.params.id]);
  if (!rows.length || (rows[0].user_id !== req.user.id && req.user.role !== 'admin'))
    return res.status(404).json({ error: 'Appointment not found.' });
  await pool.query('UPDATE appointments SET status="cancelled" WHERE id=?', [rows[0].id]);
  await pool.query('UPDATE slots SET is_booked=0 WHERE id=?', [rows[0].slot_id]);
  res.json({ ok: true });
}));

// ---------- admin ----------
app.post('/api/admin/departments', auth, adminOnly, wrap(async (req, res) => {
  await pool.query('INSERT INTO departments (name) VALUES (?)', [req.body.name]); res.json({ ok: true });
}));
app.post('/api/admin/doctors', auth, adminOnly, wrap(async (req, res) => {
  const { name, title, department_id } = req.body;
  await pool.query('INSERT INTO doctors (name,title,department_id) VALUES (?,?,?)', [name, title, department_id]);
  res.json({ ok: true });
}));
// creates slots for one doctor on one date, e.g. 09:00-13:00 every 30 minutes
app.post('/api/admin/slots', auth, adminOnly, wrap(async (req, res) => {
  const { doctor_id, date, start, end, minutes } = req.body;
  const step = Math.max(10, parseInt(minutes) || 30);
  let t = new Date(`${date}T${start}:00`); const stop = new Date(`${date}T${end}:00`);
  const vals = [];
  while (t < stop) {
    const p = n => String(n).padStart(2, '0');
    vals.push([doctor_id, `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:00`]);
    t = new Date(t.getTime() + step * 60000);
  }
  if (!vals.length) return res.status(400).json({ error: 'End time must be after start time.' });
  await pool.query('INSERT IGNORE INTO slots (doctor_id, slot_start) VALUES ?', [vals]);
  res.json({ created: vals.length });
}));
app.get('/api/admin/appointments', auth, adminOnly, wrap(async (_, res) => {
  const [r] = await pool.query(
    `SELECT a.id, a.status, a.reason, s.slot_start, d.name AS doctor, dp.name AS department,
            u.name AS patient, u.email
     FROM appointments a JOIN slots s ON s.id=a.slot_id JOIN users u ON u.id=a.user_id
     JOIN doctors d ON d.id=s.doctor_id JOIN departments dp ON dp.id=d.department_id
     ORDER BY s.slot_start DESC LIMIT 300`);
  res.json(r);
}));

// ---------- startup: create tables + first admin ----------
async function init() {
  const q = s => pool.query(s);
  await q(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL,
    role ENUM('patient','admin') NOT NULL DEFAULT 'patient', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await q(`CREATE TABLE IF NOT EXISTS departments (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE)`);
  await q(`CREATE TABLE IF NOT EXISTS doctors (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
    title VARCHAR(100), department_id INT NOT NULL, FOREIGN KEY (department_id) REFERENCES departments(id))`);
  await q(`CREATE TABLE IF NOT EXISTS slots (id INT AUTO_INCREMENT PRIMARY KEY, doctor_id INT NOT NULL,
    slot_start DATETIME NOT NULL, is_booked TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uq_doc_time (doctor_id, slot_start), FOREIGN KEY (doctor_id) REFERENCES doctors(id))`);
  await q(`CREATE TABLE IF NOT EXISTS appointments (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
    slot_id INT NOT NULL, reason VARCHAR(255), status ENUM('booked','cancelled') NOT NULL DEFAULT 'booked',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (slot_id) REFERENCES slots(id))`);
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const [x] = await pool.query('SELECT id FROM users WHERE email=?', [ADMIN_EMAIL]);
    if (!x.length) await pool.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,"admin")',
      ['Administrator', ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  }
}
const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log('Running on port ' + port)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
