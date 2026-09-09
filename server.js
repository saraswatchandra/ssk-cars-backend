const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'SSK Cars Backend API Running',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});

// Sample API Routes
app.get('/api/cars', (req, res) => {
    res.status(200).json({
        status: 'success',
        data: [
            { id: 1, make: 'Toyota', model: 'Camry', year: 2023, price: 25000, status: 'available' },
            { id: 2, make: 'Honda', model: 'Civic', year: 2024, price: 22000, status: 'available' }
        ]
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
