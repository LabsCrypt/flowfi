import { Router } from 'express';
import streamRoutes from './stream.routes.js';
import eventsRoutes from './events.routes.js';
import userRoutes from './user.routes.js';
import adminRoutes from './admin.routes.js';

const router = Router();

// V1 API Routes
router.use('/streams', streamRoutes);
router.use('/events', eventsRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);

export default router;
