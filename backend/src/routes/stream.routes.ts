import { Router } from 'express';
import { createStream } from '../controllers/stream.controller.js';

const router = Router();

router.post('/', createStream);

export default router;
