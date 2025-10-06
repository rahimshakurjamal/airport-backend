import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        final_destination VARCHAR(10),
        final_eta TIMESTAMP,
        car_assigned INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS flight_legs (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
        flight_number VARCHAR(50) NOT NULL,
        airline VARCHAR(100),
        origin VARCHAR(10) NOT NULL,
        destination VARCHAR(10) NOT NULL,
        eta TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'On Time',
        leg_order INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cars (
        id SERIAL PRIMARY KEY,
        destination VARCHAR(10),
        eta TIMESTAMP,
        flight VARCHAR(50),
        capacity INTEGER DEFAULT 5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS car_passengers (
        car_id INTEGER REFERENCES cars(id) ON DELETE CASCADE,
        guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
        PRIMARY KEY (car_id, guest_id)
      );
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

async function fetchFlightStatus(flightNumber, airline, date) {
  try {
    const response = await axios.get('http://api.aviationstack.com/v1/flights', {
      params: {
        access_key: process.env.AVIATIONSTACK_API_KEY,
        flight_iata: `${airline}${flightNumber}`,
        flight_date: date
      }
    });

    if (response.data && response.data.data && response.data.data.length > 0) {
      const flight = response.data.data[0];
      let status = 'On Time';
      
      if (flight.flight_status === 'cancelled') status = 'Cancelled';
      else if (flight.flight_status === 'landed') status = 'Landed';
      else if (flight.flight_status === 'active') status = 'On Time';
      else if (flight.flight_status === 'scheduled' && flight.departure?.delay > 0) status = 'Delayed';

      return { status };
    }
    return null;
  } catch (error) {
    console.error('Error fetching flight status:', error.message);
    return null;
  }
}

async function updateFlightStatuses() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT fl.id, fl.flight_number, fl.airline, fl.eta 
      FROM flight_legs fl
      WHERE fl.status NOT IN ('Landed', 'Cancelled')
    `);

    for (const leg of result.rows) {
      const date = new Date(leg.eta).toISOString().split('T')[0];
      const flightStatus = await fetchFlightStatus(leg.flight_number, leg.airline, date);
      
      if (flightStatus) {
        await client.query(
          'UPDATE flight_legs SET status = $1 WHERE id = $2',
          [flightStatus.status, leg.id]
        );
      }
    }
  } finally {
    client.release();
  }
}

app.get('/api/guests', async (req, res) => {
  const client = await pool.connect();
  try {
    const guestsResult = await client.query('SELECT * FROM guests ORDER BY created_at DESC');
    const guests = await Promise.all(guestsResult.rows.map(async (guest) => {
      const legsResult = await client.query(
        'SELECT * FROM flight_legs WHERE guest_id = $1 ORDER BY leg_order, eta',
        [guest.id]
      );
      return {
        id: guest.id,
        name: guest.name,
        finalDestination: guest.final_destination,
        finalETA: guest.final_eta,
        carAssigned: guest.car_assigned,
        legs: legsResult.rows.map(leg => ({
          flight: leg.flight_number,
          airline: leg.airline,
          origin: leg.origin,
          destination: leg.destination,
          eta: leg.eta,
          status: leg.status
        }))
      };
    }));
    res.json(guests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/guests', async (req, res) => {
  const { name, legs } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const finalLeg = legs[legs.length - 1];
    const guestResult = await client.query(
      'INSERT INTO guests (name, final_destination, final_eta) VALUES ($1, $2, $3) RETURNING id',
      [name, finalLeg.destination, finalLeg.eta]
    );
    
    const guestId = guestResult.rows[0].id;
    
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      await client.query(
        'INSERT INTO flight_legs (guest_id, flight_number, airline, origin, destination, eta, status, leg_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [guestId, leg.flight, leg.airline, leg.origin, leg.destination, leg.eta, leg.status || 'On Time', i]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true, guestId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/guests/:id', async (req, res) => {
  const { id } = req.params;
  const { name, legs } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const finalLeg = legs[legs.length - 1];
    await client.query(
      'UPDATE guests SET name = $1, final_destination = $2, final_eta = $3 WHERE id = $4',
      [name, finalLeg.destination, finalLeg.eta, id]
    );
    
    await client.query('DELETE FROM flight_legs WHERE guest_id = $1', [id]);
    
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      await client.query(
        'INSERT INTO flight_legs (guest_id, flight_number, airline, origin, destination, eta, status, leg_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, leg.flight, leg.airline, leg.origin, leg.destination, leg.eta, leg.status || 'On Time', i]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/api/guests/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  
  try {
    await client.query('DELETE FROM guests WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/cars', async (req, res) => {
  const client = await pool.connect();
  try {
    const carsResult = await client.query('SELECT * FROM cars ORDER BY eta');
    const cars = await Promise.all(carsResult.rows.map(async (car) => {
      const passengersResult = await client.query(
        'SELECT guest_id FROM car_passengers WHERE car_id = $1',
        [car.id]
      );
      return {
        id: car.id,
        destination: car.destination,
        eta: car.eta,
        flight: car.flight,
        capacity: car.capacity,
        passengers: passengersResult.rows.map(p => p.guest_id)
      };
    }));
    res.json(cars);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  setInterval(updateFlightStatuses, 10 * 60 * 1000);
});