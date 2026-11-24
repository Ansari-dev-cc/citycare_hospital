CREATE DATABASE IF NOT EXISTS hospital;
USE hospital;

CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS doctors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  department_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  title VARCHAR(100),
  work_days VARCHAR(30) NOT NULL DEFAULT '1,2,3,4,5', -- 0=Sun ... 6=Sat
  start_time TIME NOT NULL DEFAULT '09:00:00',
  end_time TIME NOT NULL DEFAULT '13:00:00',
  slot_minutes INT NOT NULL DEFAULT 20,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ref_code VARCHAR(12) NOT NULL UNIQUE,
  doctor_id INT NOT NULL,
  appt_date DATE NOT NULL,
  appt_time TIME NOT NULL,
  patient_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(120),
  reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY no_double_booking (doctor_id, appt_date, appt_time), -- the safety lock
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
);

INSERT INTO departments (name, description) VALUES
 ('Cardiology','Heart and blood vessels'),
 ('Orthopaedics','Bones, joints and muscles'),
 ('Paediatrics','Children''s health'),
 ('Dermatology','Skin, hair and nails'),
 ('General Medicine','Fever, infections and routine check-ups');

INSERT INTO doctors (department_id, name, title, work_days, start_time, end_time, slot_minutes) VALUES
 (1,'Dr. Anita Menon','Senior Consultant','1,2,3,4,5','09:00','13:00',20),
 (1,'Dr. Rahul Nair','Consultant','1,3,5','14:00','18:00',30),
 (2,'Dr. Faisal Kareem','Consultant','1,2,4,5','10:00','14:00',20),
 (3,'Dr. Sreeja Pillai','Paediatrician','1,2,3,4,5,6','09:00','12:00',15),
 (4,'Dr. Meera Das','Dermatologist','2,4,6','11:00','15:00',20),
 (5,'Dr. Arun Kumar','General Physician','1,2,3,4,5,6','08:00','12:00',15);
