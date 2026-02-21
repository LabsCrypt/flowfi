import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('POST /streams', () => {
  it('should return 201 and mock response when validation succeeds', async () => {
    const validData = {
      sender: 'GB...123',
      recipient: 'GB...456',
      amount: 100,
      token: 'USDC'
    };

    const response = await request(app)
      .post('/streams')
      .send(validData);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: '123',
      status: 'pending',
      ...validData
    });
  });

  it('should return 400 when validation fails (missing fields)', async () => {
    const invalidData = {
      sender: 'GB...123',
      // recipient missing
      amount: 100,
      token: 'USDC'
    };

    const response = await request(app)
      .post('/streams')
      .send(invalidData);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Validation failed');
    expect(response.body.errors).toBeDefined();
  });

  it('should return 400 when validation fails (invalid amount)', async () => {
    const invalidData = {
      sender: 'GB...123',
      recipient: 'GB...456',
      amount: -10, // invalid amount
      token: 'USDC'
    };

    const response = await request(app)
      .post('/streams')
      .send(invalidData);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Validation failed');
  });
});
