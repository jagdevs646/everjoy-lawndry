import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../server/index.js';

async function login(email: string) {
  const response = await request(app).post('/api/auth/login').send({ email, password: 'Everjoy@123' });
  expect(response.status).toBe(200);
  return response.body.token as string;
}

describe('EVERJOY LAUNDRY core API', () => {
  it('authenticates a staff user and calculates entitlement server-side', async () => {
    const token = await login('staff@everjoy.local');
    const auth = { Authorization: `Bearer ${token}` };
    const students = await request(app).get('/api/students').set(auth);
    const categories = await request(app).get('/api/categories').set(auth);
    const washFold = categories.body.find((category: { name: string }) => category.name === 'Wash & Fold');
    const quote = await request(app).post('/api/transactions/quote').set(auth).send({ student_id: students.body[0].id, category_id: washFold.id, weight: 3, service_type: 'STANDARD' });
    expect(quote.status).toBe(200);
    expect(quote.body.entitled_weight).toBe(3);
    expect(quote.body.excess_weight).toBe(0);
  });

  it('does not expose administration to a student', async () => {
    const token = await login('student@everjoy.local');
    const response = await request(app).get('/api/students').set({ Authorization: `Bearer ${token}` });
    expect(response.status).toBe(403);
  });

  it('enforces report export permissions on the backend', async () => {
    const token = await login('student@everjoy.local');
    const response = await request(app).post('/api/reports/export').set({ Authorization: `Bearer ${token}` }).send({ filters: {}, columns: ['transaction_no'] });
    expect(response.status).toBe(403);
  });
});
