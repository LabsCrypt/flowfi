import { Router } from 'express';
import { registerUser, getUser, getUserEvents, getCurrentUser } from '../../controllers/user.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';

const router = Router();

/**
 * @openapi
 * /v1/users:
 *   post:
 *     tags:
 *       - Users
 *     summary: Register a wallet public key
 *     description: Registers a new Stellar wallet public key or returns the existing user if already registered.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - publicKey
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: Stellar public key (G...)
 *                 example: "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA"
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       200:
 *         description: User already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid request body
 * 
 * /v1/users/{publicKey}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Fetch a user by public key
 *     description: Returns user details along with recent sent and received streams.
 *     parameters:
 *       - in: path
 *         name: publicKey
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key
 *     responses:
 *       200:
 *         description: User found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: User not found
 *
 * /v1/users/me:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get current authenticated user
 *     description: Returns the currently authenticated user's details (protected endpoint)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Current user details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.post('/', registerUser);
router.get('/me', authMiddleware, getCurrentUser);
router.get('/:publicKey', getUser);

/**
 * @openapi
 * /v1/users/{publicKey}/events:
 *   get:
 *     tags:
 *       - Users
 *     summary: Fetch user activity history
 *     description: Returns a chronological history of all stream events associated with the user.
 *     parameters:
 *       - in: path
 *         name: publicKey
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key
 *     responses:
 *       200:
 *         description: List of user events
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/StreamEvent'
 *       404:
 *         description: User not found
 */
router.get('/:publicKey/events', getUserEvents);

export default router;
