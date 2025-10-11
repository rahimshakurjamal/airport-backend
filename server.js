import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import axios from 'axios';
import multer from 'multer';
import * as XLSX from 'xlsx';

dotenv.config();

const app = express();
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Initialize database
pool.query(`
  CREATE TABLE IF NOT EXISTS guests (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    flight VARCHAR(50) NOT NULL,
    airline VARCHAR(10),
    airline_name VARCHAR(100),
    origin VARCHAR(10),
    eta TIMESTAMP,
    status VARCHAR(50) DEFAULT 'On Time',
    car_assigned INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.error('Table creation error:', err));

// Get all guests with flight status updates
app.get('/api/guests', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guests ORDER BY eta ASC');
    const guests = result.rows;

    // Update flight statuses from API ONLY
    for (let guest of guests) {
      if (guest.flight && guest.airline && guest.origin) {
        try {
          const response = await axios.get('http://api.aviationstack.com/v1/flights', {
            params: {
              access_key: process.env.AVIATIONSTACK_API_KEY,
              flight_iata: `${guest.airline}${guest.flight}`
            }
          });

          if (response.data.data && response.data.data.length > 0) {
            const flight = response.data.data[0];
            
            // Map API flight_status directly - no calculations, no assumptions
            const apiStatus = flight.flight_status?.toLowerCase();
            let newStatus = 'On Time'; // default if unknown status
            
            // Map API status directly to our statuses
            const statusMap = {
              'cancelled': 'Cancelled',
              'landed': 'Landed',
              'delayed': 'Delayed',
              'active': 'On Time',
              'scheduled': 'On Time'
            };
            
            if (statusMap[apiStatus]) {
              newStatus = statusMap[apiStatus];
            }

            await pool.query('UPDATE guests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newStatus, guest.id]);
            guest.status = newStatus;
          }
        } catch (apiError) {
          console.error('API error for flight:', guest.flight, apiError.message);
          // Don't change status if API call fails - keep existing status
        }
      }
    }

    res.json(guests);
  } catch (error) {
    console.error('Error fetching guests:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add guest
app.post('/api/guests', async (req, res) => {
  try {
    const { name, phone, flight, airline, origin, eta } = req.body;
    const result = await pool.query(
      'INSERT INTO guests (name, phone, flight, airline, origin, eta) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, phone || null, flight, airline, origin, eta]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error adding guest:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update guest
app.put('/api/guests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, flight, airline, origin, eta, status, car_assigned } = req.body;
    const result = await pool.query(
      'UPDATE guests SET name = $1, phone = $2, flight = $3, airline = $4, origin = $5, eta = $6, status = $7, car_assigned = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9 RETURNING *',
      [name, phone || null, flight, airline, origin, eta, status, car_assigned, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating guest:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete guest
app.delete('/api/guests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM guests WHERE id = $1', [id]);
    res.json({ message: 'Guest deleted' });
  } catch (error) {
    console.error('Error deleting guest:', error);
    res.status(500).json({ error: error.message });
  }
});

// Auto-assign cars
app.post('/api/assign-cars', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guests ORDER BY flight, eta');
    const guests = result.rows;

    const flightGroups = {};
    guests.forEach(guest => {
      if (!flightGroups[guest.flight]) {
        flightGroups[guest.flight] = [];
      }
      flightGroups[guest.flight].push(guest);
    });

    let carId = 1;
    for (const flight in flightGroups) {
      const flightGuests = flightGroups[flight];
      for (let i = 0; i < flightGuests.length; i += 5) {
        const carGuests = flightGuests.slice(i, i + 5);
        for (const guest of carGuests) {
          await pool.query('UPDATE guests SET car_assigned = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [carId, guest.id]);
        }
        carId++;
      }
    }

    res.json({ message: 'Cars assigned successfully' });
  } catch (error) {
    console.error('Error assigning cars:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk upload
app.post('/api/bulk-upload', upload.single('file'), async (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    for (const row of data) {
      const eta = row.date && row.time ? `${row.date}T${row.time}:00` : new Date().toISOString();
      await pool.query(
        'INSERT INTO guests (name, phone, flight, airline, origin, eta) VALUES ($1, $2, $3, $4, $5, $6)',
        [row.name, row.phone || null, row.flight, row.airline, row.origin, eta]
      );
    }

    res.json({ message: 'Bulk upload successful' });
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
