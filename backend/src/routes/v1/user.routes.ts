import { Router } from 'express';
import { registerUser, getUser } from '../../controllers/user.controller.js';

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
 */
router.post('/', registerUser);
router.get('/:publicKey', getUser);

export default router;
