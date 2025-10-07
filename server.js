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

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function fetchFlightStatus(flightNumber, airline, date) {
  if (!process.env.AVIATIONSTACK_API_KEY) {
    console.error('❌ AVIATIONSTACK_API_KEY not set');
    return null;
  }

  try {
    const response = await axios.get('http://api.aviationstack.com/v1/flights', {
      params: {
        access_key: process.env.AVIATIONSTACK_API_KEY,
        flight_iata: `${airline}${flightNumber}`,
        flight_date: date
      },
      timeout: 10000
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
  console.log('🔄 Starting flight status update...');
  const client = await pool.connect();
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const result = await client.query(`
      SELECT fl.id, fl.flight_number, fl.airline, fl.eta 
      FROM flight_legs fl
      WHERE fl.status NOT IN ('Landed', 'Cancelled')
      AND DATE(fl.eta) = $1
    `, [today]);

    console.log(`✅ Checking ${result.rows.length} flights for today (${today})`);

    for (const leg of result.rows) {
      const date = new Date(leg.eta).toISOString().split('T')[0];
      const flightStatus = await fetchFlightStatus(leg.flight_number, leg.airline, date);
      
      if (flightStatus) {
        await client.query(
          'UPDATE flight_legs SET status = $1 WHERE id = $2',
          [flightStatus.status, leg.id]
        );
        console.log(`✅ Updated ${leg.airline}${leg.flight_number}: ${flightStatus.status}`);
      }
    }
    console.log('✅ Flight status update complete');
  } catch (error) {
    console.error('❌ Error updating flight statuses:', error);
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
    console.error('Error fetching guests:', error);
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
    console.log(`✅ Added guest: ${name}`);
    res.json({ success: true, guestId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding guest:', error);
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
    console.log(`✅ Deleted guest: ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting guest:', error);
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
    console.error('Error fetching cars:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/cars', async (req, res) => {
  const { cars, guestAssignments } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const car of cars) {
      const carResult = await client.query(
        'INSERT INTO cars (id, destination, eta, flight, capacity) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [car.id, car.destination, car.eta, car.flight, car.capacity]
      );
      
      const carId = carResult.rows[0].id;
      
      for (const passengerId of car.passengers) {
        await client.query(
          'INSERT INTO car_passengers (car_id, guest_id) VALUES ($1, $2)',
          [carId, passengerId]
        );
      }
    }
    
    for (const [guestId, carId] of Object.entries(guestAssignments)) {
      await client.query(
        'UPDATE guests SET car_assigned = $1 WHERE id = $2',
        [carId, parseInt(guestId)]
      );
    }
    
    await client.query('COMMIT');
    console.log(`✅ Created ${cars.length} car assignments`);
    res.json({ success: true, carsCreated: cars.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating cars:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/api/cars', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('DELETE FROM cars');
    await client.query('UPDATE guests SET car_assigned = NULL');
    console.log('✅ Cleared all car assignments');
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing cars:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/update-flight-status', async (req, res) => {
  try {
    await updateFlightStatuses();
    res.json({ success: true, message: 'Flight statuses updated successfully' });
  } catch (error) {
    console.error('Error in manual update:', error);
    res.status(500).json({ error: error.message });
  }
});

async function startServer() {
  try {
    await initDB();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`✅ Environment: ${process.env.NODE_ENV}`);
      console.log(`✅ Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
      console.log(`✅ AviationStack API: ${process.env.AVIATIONSTACK_API_KEY ? 'Configured' : 'Not configured'}`);
    });

    setInterval(updateFlightStatuses, 10 * 60 * 1000);
    console.log('✅ Auto-update scheduled every 10 minutes');
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
