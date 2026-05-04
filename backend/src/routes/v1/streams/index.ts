import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { withdrawHandler } from './withdraw.js';
import oldStreamRoutes from '../stream.routes.js';

const router = Router();

// Mount the old routes first
router.use('/', oldStreamRoutes);

/**
 * Override/Add POST /api/v1/streams/:streamId/withdraw
 */
router.post('/:streamId/withdraw', requireAuth, withdrawHandler as any);

export default router;
