import { Router } from 'express';
import { getToken, listTokens } from '../../controllers/token.controller.js';

const router = Router();
router.get('/', listTokens);
router.get('/:address', getToken);

export default router;