# Authentication Middleware (SEP-10 + JWT)

FlowFi API uses the Stellar SEP-10 challenge flow to authenticate wallets, then issues a JWT for subsequent API requests.

## Overview

Authentication is performed in two phases:

1. Client requests a challenge from `/v1/auth/challenge`
2. Client signs the challenge transaction and submits it to `/v1/auth/verify`
3. Server verifies the nonce and returns a JWT
4. Client uses `Authorization: Bearer <JWT>` for authenticated endpoints

This simplifies clients and standardizes authentication across all protected routes.

## Using the Middleware

### Protected Routes

Apply `requireAuth` to any route that requires authentication:

```typescript
import { requireAuth } from '../middleware/auth.js';
import { Router } from 'express';

const router = Router();

// Protected endpoint
router.get('/me', requireAuth, getCurrentUser);
```

### Optional Authentication

Use `optionalAuthMiddleware` for routes where authentication is optional:

```typescript
import { optionalAuthMiddleware } from '../middleware/auth.middleware.js';

router.get('/streams', optionalAuthMiddleware, getStreams);
```

## Request Format

### Authorization Header

```
Authorization: Bearer <jwt>
```

### Example

```bash
curl -X GET http://localhost:3001/v1/users/me \
  -H "Authorization: Bearer AAAAAgAAAAC..."
```

## Transaction Requirements

The signed transaction must meet these requirements:

1. **Source Account**: Must be the user's Stellar public key
2. **Valid Signature**: Signature must be valid for the source account
3. **Time Bounds** (optional but recommended): Transaction should include time bounds to prevent replay attacks
4. **Network**: Must match the configured Stellar network (testnet or mainnet)

## Example: Creating a Signed Transaction (Client Side)

```javascript
import * as StellarSdk from '@stellar/stellar-sdk';

// Create a keypair (in real app, this comes from the user's wallet)
const keypair = StellarSdk.Keypair.fromSecret('S...');

// Get the current network passphrase
const networkPassphrase = StellarSdk.Networks.TESTNET;

// Create a simple transaction for authentication
const account = await server.loadAccount(keypair.publicKey());
const transaction = new StellarSdk.TransactionBuilder(account, {
  fee: StellarSdk.BASE_FEE,
  networkPassphrase,
})
  .addOperation(
    StellarSdk.Operation.manageData({
      name: 'auth',
      value: crypto.randomBytes(32), // Random challenge
    })
  )
  .setTimeout(300) // 5 minutes validity
  .build();

// Sign the transaction
transaction.sign(keypair);

// Encode to XDR for the Bearer token
const xdr = transaction.toEnvelope().toXDR('base64');

// Use in Authorization header
const response = await fetch('http://localhost:3001/v1/users/me', {
  headers: {
    'Authorization': `Bearer ${xdr}`
  }
});
```

## Error Responses

### 401 Unauthorized - Missing Token

```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid Authorization header. Expected format: Bearer <signed_transaction>"
}
```

### 401 Unauthorized - Invalid Signature

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired signature"
}
```

## Security Features

1. **Signature Verification**: Cryptographically verifies the transaction was signed by the claimed public key
2. **Time Bounds**: Supports transaction time bounds to prevent replay attacks
3. **Network Validation**: Ensures transactions match the configured Stellar network
4. **No Password Storage**: No sensitive credentials stored on the server

## Configuration

### Environment Variables

```env
# Stellar Network (testnet or mainnet)
STELLAR_NETWORK=testnet

# For mainnet, use:
# STELLAR_NETWORK=mainnet
```

### Network Passphrases

- **Testnet**: `Test SDF Network ; September 2015`
- **Mainnet**: `Public Global Stellar Network ; September 2015`

## Independence from Database

Per issue #74 requirements, the middleware operates independently of the database:

- **User Exists**: Returns user data from database
- **User Missing**: Returns in-memory user object with `publicKey` and empty arrays
- **Never Blocks**: Authentication succeeds based solely on valid signature

Example in-memory response:

```json
{
  "publicKey": "GABC123...",
  "sentStreams": [],
  "receivedStreams": [],
  "inMemory": true
}
```

## TypeScript Types

### AuthUser

```typescript
interface AuthUser {
  publicKey: string;
  id?: string;
}
```

### AuthenticatedRequest

```typescript
interface AuthenticatedRequest extends Request {
  user: AuthUser;
}
```

### Usage in Controllers

```typescript
import type { AuthenticatedRequest } from '../types/auth.types.js';

export const getCurrentUser = async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { publicKey } = authReq.user;

  // Use publicKey...
};
```

## Testing

Test the middleware with a valid signed transaction:

```bash
# 1. Create a test transaction (use stellar-sdk)
# 2. Sign it with a test keypair
# 3. Encode to XDR
# 4. Send request

curl -X GET http://localhost:3001/v1/users/me \
  -H "Authorization: Bearer <your_signed_transaction_xdr>"
```

## Related Documentation

- [Stellar SEP-10 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Swagger API Docs](http://localhost:3001/api-docs)
