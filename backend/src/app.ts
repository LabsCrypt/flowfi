import express from 'express';
import cors from 'cors';
import streamRoutes from './routes/stream.routes.js';

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/streams', streamRoutes);

app.get('/', (req, res) => {
  res.send('FlowFi Backend is running');
});

export default app;
