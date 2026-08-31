import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.1.0',
    info: {
      title: 'FlowFi API',
      version: '1.0.0',
      description: `API documentation for FlowFi - Real-time payment streaming on Stellar

## Performance & Caching
The API implements caching for frequently accessed endpoints, such as claimable amount calculations. 
- **Claimable Cache TTL**: 5 seconds
- **Invalidation**: Automatically cleared when a withdrawal event occurs.

## Sandbox Mode

FlowFi API supports sandbox mode for testing without affecting production data.

**Enable Sandbox Mode:**
- Header: \`X-Sandbox-Mode: true\`
- Query Parameter: \`?sandbox=true\`

**Sandbox Features:**
- Isolated database (separate from production)
- All responses include \`_sandbox\` metadata
- Response headers include \`X-Sandbox-Mode: true\`
- Safe for testing and development

See [Sandbox Mode Documentation](../docs/SANDBOX_MODE.md) for details.`,
      contact: {
        name: 'FlowFi Team',
        url: 'https://github.com/LabsCrypt/flowfi',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: (() => {
      const baseUrl = process.env.API_BASE_URL;
      if (baseUrl) {
        return [{ url: `${baseUrl}/v1`, description: 'API server' }];
      }
      return [
        { url: 'http://localhost:3001/v1', description: 'Development server (v1)' },
        { url: 'https://api.flowfi.io/v1', description: 'Production server (v1)' },
      ];
    })(),
    tags: [
      {
        name: 'Health',
        description: 'Health check endpoints',
      },
      {
        name: 'Users',
        description: 'User management endpoints',
      },
      {
        name: 'Streams',
        description: 'Payment stream management endpoints',
      },
      {
        name: 'Events',
        description: 'Stream event tracking endpoints',
      },
      {
        name: 'Admin',
        description: 'Administrative and monitoring endpoints',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JSON Web Token issued by /v1/auth/verify after completing the SEP-10 challenge flow.'
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Alias for BearerAuth — used by route-level security annotations.'
        },
        adminAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Admin JWT — the token subject must match ADMIN_PUBLIC_KEY.'
        }
      },
      schemas: {
        User: {
          type: 'object',
          required: ['id', 'publicKey'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Unique identifier for the user',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            publicKey: {
              type: 'string',
              description: 'Stellar public key (G...)',
              example: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'User creation timestamp',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
            },
          },
        },
        Stream: {
          type: 'object',
          required: ['id', 'streamId', 'sender', 'recipient', 'tokenAddress', 'ratePerSecond'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Database UUID',
            },
            streamId: {
              type: 'integer',
              description: 'On-chain stream ID',
              example: 1,
            },
            sender: {
              type: 'string',
              description: 'Sender Stellar public key',
              example: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
            },
            recipient: {
              type: 'string',
              description: 'Recipient Stellar public key',
              example: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
            },
            tokenAddress: {
              type: 'string',
              description: 'Token contract address',
              example: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
            },
            ratePerSecond: {
              type: 'string',
              description: 'Payment rate per second (i128 as string)',
              example: '100',
            },
            depositedAmount: {
              type: 'string',
              description: 'Total deposited amount (i128 as string)',
              example: '10000',
            },
            withdrawnAmount: {
              type: 'string',
              description: 'Total withdrawn amount (i128 as string)',
              example: '2500',
            },
            startTime: {
              type: 'integer',
              description: 'Stream start time (Unix timestamp)',
              example: 1708531200,
            },
            lastUpdateTime: {
              type: 'integer',
              description: 'Last update time (Unix timestamp)',
              example: 1708534800,
            },
            isActive: {
              type: 'boolean',
              description: 'Stream active status',
              example: true,
            },
            isPaused: {
              type: 'boolean',
              description: 'Whether the stream is currently paused',
              example: false,
            },
            pausedAt: {
              type: 'integer',
              nullable: true,
              description: 'Ledger timestamp when the stream was last paused (Unix), null if not paused',
              example: null,
            },
            totalPausedDuration: {
              type: 'integer',
              description: 'Cumulative seconds the stream has spent paused',
              example: 0,
            },
            endTime: {
              type: 'integer',
              nullable: true,
              description: 'Ledger timestamp when the stream ended (Unix), null if still active',
              example: null,
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        StreamEvent: {
          type: 'object',
          required: ['id', 'streamId', 'eventType', 'transactionHash', 'ledgerSequence', 'timestamp'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            streamId: {
              type: 'integer',
              description: 'Reference to stream ID',
            },
            eventType: {
              type: 'string',
              enum: ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED', 'FEE_COLLECTED'],
              description: 'Type of stream event',
              example: 'TOPPED_UP',
            },
            amount: {
              type: 'string',
              nullable: true,
              description: 'Amount involved in event (i128 as string)',
              example: '5000',
            },
            transactionHash: {
              type: 'string',
              description: 'Stellar transaction hash',
              example: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6',
            },
            ledgerSequence: {
              type: 'integer',
              description: 'Ledger sequence number',
              example: 12345678,
            },
            timestamp: {
              type: 'integer',
              description: 'Event timestamp (Unix)',
              example: 1708531200,
            },
            metadata: {
              type: 'string',
              nullable: true,
              description: 'Additional event data (JSON string)',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        StreamListResponse: {
          type: 'object',
          required: ['data', 'total', 'hasMore', 'limit', 'offset'],
          properties: {
            data: {
              type: 'array',
              description: 'Streams matching the filter, sorted and paginated',
              items: { $ref: '#/components/schemas/Stream' },
            },
            total: { type: 'integer', description: 'Total number of streams matching the filter' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
            limit: { type: 'integer', description: 'Page size applied (capped at MAX_STREAM_PAGE_SIZE)' },
            offset: { type: 'integer', description: 'Number of results skipped' },
          },
        },
        StreamEventListResponse: {
          type: 'object',
          required: ['data', 'total', 'hasMore'],
          properties: {
            data: {
              type: 'array',
              description: 'Events for the stream, sorted by timestamp (tie-broken by id)',
              items: { $ref: '#/components/schemas/StreamEvent' },
            },
            total: { type: 'integer', description: 'Total number of events matching the filter' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
          },
        },
        EventListResponse: {
          type: 'object',
          required: ['events', 'total', 'limit', 'offset', 'hasMore'],
          properties: {
            events: {
              type: 'array',
              description: 'Reverse-chronological stream events for the wallet',
              items: { $ref: '#/components/schemas/StreamEvent' },
            },
            total: { type: 'integer', description: 'Total number of matching events' },
            limit: { type: 'integer', description: 'Page size applied (capped at 200)' },
            offset: { type: 'integer', description: 'Number of events skipped' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
          },
        },
        UserEventListResponse: {
          type: 'object',
          required: ['data', 'total', 'hasMore', 'limit', 'offset'],
          properties: {
            data: {
              type: 'array',
              description: 'Events associated with the user, newest first',
              items: { $ref: '#/components/schemas/StreamEvent' },
            },
            total: { type: 'integer', description: 'Total number of matching events' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
            limit: { type: 'integer', description: 'Page size applied (capped at 200)' },
            offset: { type: 'integer', description: 'Number of events skipped' },
          },
        },
        UserStreamSummary: {
          type: 'object',
          required: [
            'address',
            'totalStreamsCreated',
            'totalStreamedOut',
            'totalStreamedIn',
            'currentClaimable',
            'activeOutgoingCount',
            'activeIncomingCount',
          ],
          properties: {
            address: { type: 'string', description: 'Stellar public key' },
            totalStreamsCreated: { type: 'integer', description: 'Number of streams this wallet sent' },
            totalStreamedOut: { type: 'string', description: 'Sum of withdrawn amounts on outgoing streams (i128 as string)' },
            totalStreamedIn: { type: 'string', description: 'Sum of withdrawn amounts on incoming streams (i128 as string)' },
            currentClaimable: { type: 'string', description: 'Total currently claimable across active incoming streams (i128 as string)' },
            activeOutgoingCount: { type: 'integer' },
            activeIncomingCount: { type: 'integer' },
            truncated: { type: 'boolean', description: 'True when the number of streams was capped at MAX_USER_STREAMS per direction', example: false },
          },
        },
        ClaimableResponse: {
          type: 'object',
          required: ['claimableAmount', 'actionable', 'calculatedAt'],
          properties: {
            streamId: { type: 'integer', description: 'On-chain stream ID' },
            ratePerSecond: { type: 'string', description: 'Payment rate per second (i128 as string)' },
            depositedAmount: { type: 'string', description: 'Total deposited amount (i128 as string)' },
            withdrawnAmount: { type: 'string', description: 'Total withdrawn amount (i128 as string)' },
            startTime: { type: 'integer', description: 'Stream start time (Unix timestamp)' },
            lastUpdateTime: { type: 'integer', description: 'Last state update time (Unix timestamp)' },
            claimableAmount: { type: 'string', description: 'Amount claimable at the requested time (i128 as string)' },
            actionable: { type: 'boolean', description: 'Whether the claimable amount is positive' },
            calculatedAt: { type: 'integer', description: 'Unix timestamp of the calculation' },
            cached: { type: 'boolean', description: 'Whether the value came from cache or a fresh computation' },
            source: { type: 'string', enum: ['db', 'chain'], description: 'Where the value was computed from' },
          },
        },
        PauseResumeResponse: {
          type: 'object',
          required: ['success', 'streamId', 'txHash'],
          properties: {
            success: { type: 'boolean', example: true },
            streamId: { type: 'integer' },
            txHash: { type: 'string', description: 'Stellar transaction hash of the pause/resume simulation' },
            stream: { $ref: '#/components/schemas/Stream' },
          },
        },
        TopUpResponse: {
          type: 'object',
          required: ['streamId', 'txHash', 'depositedAmount'],
          properties: {
            streamId: { type: 'integer' },
            txHash: { type: 'string', description: 'Stellar transaction hash' },
            depositedAmount: { type: 'string', description: 'New total deposited amount after the top-up (i128 as string)' },
          },
        },
        WithdrawResponse: {
          type: 'object',
          required: ['success', 'streamId', 'txHash', 'amount'],
          properties: {
            success: { type: 'boolean', example: true },
            streamId: { type: 'integer' },
            txHash: { type: 'string', description: 'Stellar transaction hash of the withdrawal' },
            amount: { type: 'string', description: 'Amount withdrawn (i128 as string)' },
            stream: { $ref: '#/components/schemas/Stream' },
          },
        },
        CancelResponse: {
          type: 'object',
          required: ['txHash', 'status'],
          properties: {
            txHash: { type: 'string', description: 'Stellar transaction hash of the cancel' },
            status: { type: 'string', enum: ['CANCELLED'], example: 'CANCELLED' },
          },
        },
        AuthChallengeResponse: {
          type: 'object',
          required: ['nonce', 'expiresAt'],
          properties: {
            nonce: { type: 'string', description: 'Hex-encoded nonce to sign via a Stellar manage_data operation' },
            expiresAt: { type: 'integer', description: 'Unix timestamp (ms) when the challenge expires (60s)' },
          },
        },
        AuthVerifyResponse: {
          type: 'object',
          required: ['token', 'expiresIn'],
          properties: {
            token: { type: 'string', description: 'JWT to use in the Authorization: Bearer header' },
            expiresIn: { type: 'integer', description: 'Token lifetime in seconds (3600)' },
          },
        },
        SseStats: {
          type: 'object',
          required: ['activeConnections', 'activeIps', 'perIpPeakConnections', 'maxConnections', 'timestamp'],
          properties: {
            activeConnections: { type: 'integer', example: 42 },
            activeIps: { type: 'integer', example: 8 },
            perIpPeakConnections: { type: 'integer', example: 5 },
            maxConnections: { type: 'integer', example: 10000 },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        WebhookSubscription: {
          type: 'object',
          required: ['id', 'userAddress', 'targetUrl', 'eventTypes', 'active', 'createdAt'],
          properties: {
            id: { type: 'string', description: 'Webhook subscription id' },
            userAddress: { type: 'string', description: 'Stellar public key the subscription belongs to' },
            targetUrl: { type: 'string', description: 'HTTPS endpoint receiving the events' },
            eventTypes: {
              type: 'array',
              items: { type: 'string', enum: ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED', 'FEE_COLLECTED'] },
            },
            active: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'db', 'indexerEnabled', 'uptime', 'checks'],
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'], example: 'ok' },
            db: { type: 'string', enum: ['connected', 'disconnected'], example: 'connected' },
            indexerEnabled: { type: 'boolean', description: 'Whether the event indexer is configured' },
            indexerLag: { type: 'integer', nullable: true, description: 'Seconds since last indexer update, or null when no state row exists yet' },
            eventsProcessed: { type: 'integer', description: 'Lifetime count of successfully processed indexer events' },
            eventsFailed: { type: 'integer', description: 'Lifetime count of indexer events that threw during processing' },
            lastErrorAt: { type: 'string', format: 'date-time', nullable: true, description: 'Most recent per-event processing failure' },
            indexerDegraded: { type: 'boolean', description: 'True when recent event-processing failure rate spikes' },
            uptime: { type: 'number', description: 'Server uptime in seconds' },
            checks: {
              type: 'object',
              description: 'Per-subsystem status breakdown',
              properties: {
                database: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['ok', 'down'] } },
                },
                indexer: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded', 'disabled'] },
                    enabled: { type: 'boolean' },
                    lagSeconds: { type: 'integer', nullable: true },
                  },
                },
                redis: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['ok', 'unavailable', 'not_configured'] } },
                },
                sorobanRpc: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['ok', 'down'] } },
                },
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Error message',
              example: 'Resource not found',
            },
            code: {
              type: 'string',
              description: 'Error code',
              example: 'NOT_FOUND',
            },
            message: {
              type: 'string',
              nullable: true,
              description: 'Human-readable detail (present on many error responses)',
            },
            details: {
              type: 'array',
              nullable: true,
              description: 'Structured validation issues (zod) when the error is a 400',
              items: { type: 'object' },
            },
          },
        },
      },
    },
  },
  apis: ['./src/**/*.ts'], // Path to the API routes
};

export const swaggerSpec = swaggerJsdoc(options);
