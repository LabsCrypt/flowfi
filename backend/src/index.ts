import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/', (req: Request, res: Response) => {
    res.send('FlowFi Backend is running');
});

app.listen(port, () => {
    logger.info('Server started', { port });
});
