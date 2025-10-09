const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:vxPjrWEnJowROplPdwfBYrRXyjTYvOkf@postgres.railway.internal:5432/railway',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors({
  origin: [
    'https://airport-frontend-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:8000'
  ],
  credentials: true
}));
app.use(express.json());

// Initialize database tables - DROP AND RECREATE to fix schema issues
const initDB = async () => {
  try {
    console.log('Dropping old tables if they exist...');
    
    // Drop old tables to recreate with correct schema
    await pool.query('DROP TABLE IF EXISTS guests CASCADE');
    await pool.query('DROP TABLE IF EXISTS cars CASCADE');
    
    console.log('Creating fresh tables with correct schema...');
    
    // Create guests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        flight VARCHAR(50) NOT NULL,
        airline VARCHAR(10) NOT NULL,
        airline_name VARCHAR(255),
        origin VARCHAR(50) NOT NULL,
        eta TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'On Time',
        car_assigned INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create cars table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cars (
        id INTEGER PRIMARY KEY,
        passengers INTEGER[] DEFAULT ARRAY[]::INTEGER[],
        driver_name VARCHAR(255),
        driver_phone VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

initDB();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Airport Pickup Manager API is running',
    endpoints: {
      guests: '/api/guests',
      cars: '/api/cars',
      flightStatus: '/api/flight-status'
    }
  });
});

// ==================== GUEST ENDPOINTS ====================

// Get all guests
app.get('/api/guests', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guests ORDER BY eta ASC');
    
    // Convert camelCase for frontend
    const guests = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      flight: row.flight,
      airline: row.airline,
      airlineName: row.airline_name,
      origin: row.origin,
      eta: row.eta,
      status: row.status,
      carAssigned: row.car_assigned
    }));
    
    res.json(guests);
  } catch (error) {
    console.error('Error fetching guests:', error);
    res.status(500).json({ error: 'Failed to fetch guests' });
  }
});

// Get single guest
app.get('/api/guests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM guests WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    const row = result.rows[0];
    const guest = {
      id: row.id,
      name: row.name,
      flight: row.flight,
      airline: row.airline,
      airlineName: row.airline_name,
      origin: row.origin,
      eta: row.eta,
      status: row.status,
      carAssigned: row.car_assigned
    };
    
    res.json(guest);
  } catch (error) {
    console.error('Error fetching guest:', error);
    res.status(500).json({ error: 'Failed to fetch guest' });
  }
});

// Create new guest
app.post('/api/guests', async (req, res) => {
  try {
    const { name, flight, airline, airlineName, origin, eta, status, carAssigned } = req.body;
    
    console.log('Creating guest:', { name, flight, airline, airlineName, origin, eta, status, carAssigned });
    
    const result = await pool.query(
      `INSERT INTO guests (name, flight, airline, airline_name, origin, eta, status, car_assigned) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [name, flight, airline, airlineName, origin, eta, status || 'On Time', carAssigned || null]
    );
    
    const row = result.rows[0];
    const guest = {
      id: row.id,
      name: row.name,
      flight: row.flight,
      airline: row.airline,
      airlineName: row.airline_name,
      origin: row.origin,
      eta: row.eta,
      status: row.status,
      carAssigned: row.car_assigned
    };
    
    console.log('Guest created successfully:', guest);
    res.status(201).json(guest);
  } catch (error) {
    console.error('Error creating guest:', error);
    res.status(500).json({ error: 'Failed to create guest' });
  }
});

// Update guest
app.put('/api/guests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, flight, airline, airlineName, origin, eta, status, carAssigned } = req.body;
    
    const result = await pool.query(
      `UPDATE guests 
       SET name = $1, flight = $2, airline = $3, airline_name = $4, origin = $5, 
           eta = $6, status = $7, car_assigned = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 
       RETURNING *`,
      [name, flight, airline, airlineName, origin, eta, status, carAssigned, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    const row = result.rows[0];
    const guest = {
      id: row.id,
      name: row.name,
      flight: row.flight,
      airline: row.airline,
      airlineName: row.airline_name,
      origin: row.origin,
      eta: row.eta,
      status: row.status,
      carAssigned: row.car_assigned
    };
    
    res.json(guest);
  } catch (error) {
    console.error('Error updating guest:', error);
    res.status(500).json({ error: 'Failed to update guest' });
  }
});

// Delete guest
app.delete('/api/guests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM guests WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    res.json({ message: 'Guest deleted successfully' });
  } catch (error) {
    console.error('Error deleting guest:', error);
    res.status(500).json({ error: 'Failed to delete guest' });
  }
});

// ==================== CAR ENDPOINTS ====================

// Get all cars
app.get('/api/cars', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cars ORDER BY id ASC');
    
    const cars = result.rows.map(row => ({
      id: row.id,
      passengers: row.passengers || [],
      driverName: row.driver_name || '',
      driverPhone: row.driver_phone || '',
      notes: row.notes || ''
    }));
    
    res.json(cars);
  } catch (error) {
    console.error('Error fetching cars:', error);
    res.status(500).json({ error: 'Failed to fetch cars' });
  }
});

// Get single car
app.get('/api/cars/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM cars WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Car not found' });
    }
    
    const row = result.rows[0];
    const car = {
      id: row.id,
      passengers: row.passengers || [],
      driverName: row.driver_name || '',
      driverPhone: row.driver_phone || '',
      notes: row.notes || ''
    };
    
    res.json(car);
  } catch (error) {
    console.error('Error fetching car:', error);
    res.status(500).json({ error: 'Failed to fetch car' });
  }
});

// Create new car
app.post('/api/cars', async (req, res) => {
  try {
    const { id, passengers, driverName, driverPhone, notes } = req.body;
    
    const result = await pool.query(
      `INSERT INTO cars (id, passengers, driver_name, driver_phone, notes) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (id) DO UPDATE 
       SET passengers = $2, driver_name = $3, driver_phone = $4, notes = $5, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [id, passengers || [], driverName || '', driverPhone || '', notes || '']
    );
    
    const row = result.rows[0];
    const car = {
      id: row.id,
      passengers: row.passengers || [],
      driverName: row.driver_name || '',
      driverPhone: row.driver_phone || '',
      notes: row.notes || ''
    };
    
    res.status(201).json(car);
  } catch (error) {
    console.error('Error creating car:', error);
    res.status(500).json({ error: 'Failed to create car' });
  }
});

// Update car
app.put('/api/cars/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { passengers, driverName, driverPhone, notes } = req.body;
    
    const result = await pool.query(
      `UPDATE cars 
       SET passengers = $1, driver_name = $2, driver_phone = $3, notes = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 
       RETURNING *`,
      [passengers || [], driverName || '', driverPhone || '', notes || '', id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Car not found' });
    }
    
    const row = result.rows[0];
    const car = {
      id: row.id,
      passengers: row.passengers || [],
      driverName: row.driver_name || '',
      driverPhone: row.driver_phone || '',
      notes: row.notes || ''
    };
    
    res.json(car);
  } catch (error) {
    console.error('Error updating car:', error);
    res.status(500).json({ error: 'Failed to update car' });
  }
});

// Delete single car
app.delete('/api/cars/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM cars WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Car not found' });
    }
    
    res.json({ message: 'Car deleted successfully' });
  } catch (error) {
    console.error('Error deleting car:', error);
    res.status(500).json({ error: 'Failed to delete car' });
  }
});

// Delete all cars (for auto-assign)
app.delete('/api/cars', async (req, res) => {
  try {
    await pool.query('DELETE FROM cars');
    res.json({ message: 'All cars deleted successfully' });
  } catch (error) {
    console.error('Error deleting cars:', error);
    res.status(500).json({ error: 'Failed to delete cars' });
  }
});

// ==================== FLIGHT STATUS ENDPOINT ====================

// Get flight status from AviationStack API
app.get('/api/flight-status', async (req, res) => {
  const { flight, airline } = req.query;
  
  if (!flight || !airline) {
    return res.status(400).json({ error: 'Flight and airline parameters are required' });
  }

  try {
    // AviationStack API call
    const apiKey = process.env.AVIATIONSTACK_API_KEY;
    
    if (!apiKey) {
      console.error('AviationStack API key not found');
      return res.json({ status: 'On Time' });
    }

    const response = await axios.get('http://api.aviationstack.com/v1/flights', {
      params: {
        access_key: apiKey,
        flight_iata: `${airline}${flight}`,
        limit: 1
      },
      timeout: 5000
    });

    if (response.data && response.data.data && response.data.data.length > 0) {
      const flightData = response.data.data[0];
      let status = 'On Time';

      // Map AviationStack status to our status
      if (flightData.flight_status) {
        const aviationStatus = flightData.flight_status.toLowerCase();
        
        if (aviationStatus === 'landed') {
          status = 'Landed';
        } else if (aviationStatus === 'cancelled' || aviationStatus === 'canceled') {
          status = 'Cancelled';
        } else if (aviationStatus === 'delayed') {
          status = 'Delayed';
        } else if (aviationStatus === 'active' || aviationStatus === 'scheduled' || aviationStatus === 'en-route') {
          status = 'On Time';
        }
      }

      console.log(`Flight ${airline}${flight} status: ${status}`);
      return res.json({ status });
    } else {
      console.log(`No data found for flight ${airline}${flight}`);
      return res.json({ status: 'On Time' });
    }
  } catch (error) {
    console.error('Error fetching flight status:', error.message);
    // Return default status on error to prevent frontend issues
    return res.json({ status: 'On Time' });
  }
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Frontend URL: https://airport-frontend-production.up.railway.app`);
  console.log(`Backend URL: https://airport-backend-production-89e9.up.railway.app`);
});
