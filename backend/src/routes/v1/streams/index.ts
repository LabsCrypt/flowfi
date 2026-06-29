import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import oldStreamRoutes from '../stream.routes.js';
const router = Router();

// Mount the old routes first
router.use('/', oldStreamRoutes);

export default router;
