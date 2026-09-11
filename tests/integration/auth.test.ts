/**
 * FR1 over HTTP, against the real application and a real database.
 *
 * Real bcrypt, real Postgres-backed sessions, real Express. Supertest drives
 * the app object directly, so nothing binds a port.
 */
import { DEMO_EMAIL } from '@tasks/data';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupTestApp, type TestApp } from '../support/app.js';

let testApp: TestApp;

const CREDENTIALS = { email: 'person@example.com', password: 'correct-horse-battery' };

beforeAll(async () => {
  testApp = await setupTestApp();
});

afterAll(async () => {
  await testApp.close();
});

beforeEach(async () => {
  await testApp.reset();
});

describe('POST /api/v1/auth/register', () => {
  it('creates the account, signs the user in, and never echoes the password', async () => {
    const response = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send(CREDENTIALS)
      .expect(201);

    expect(response.body.user).toMatchObject({
      email: 'person@example.com',
      timezone: 'Europe/London',
    });
    expect(JSON.stringify(response.body)).not.toContain(CREDENTIALS.password);
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('stores a bcrypt hash rather than the password', async () => {
    await request(testApp.app).post('/api/v1/auth/register').send(CREDENTIALS).expect(201);

    const { rows } = await testApp.database.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [CREDENTIALS.email],
    );

    expect(rows[0]?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(rows[0]?.password_hash).not.toContain(CREDENTIALS.password);
  });

  it('accepts a timezone and rejects one that is not a real IANA zone', async () => {
    await request(testApp.app)
      .post('/api/v1/auth/register')
      .send({ ...CREDENTIALS, timezone: 'America/New_York' })
      .expect(201)
      .expect((response) => {
        expect(response.body.user.timezone).toBe('America/New_York');
      });

    const rejected = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send({ email: 'other@example.com', password: CREDENTIALS.password, timezone: 'Mars/Olympus' })
      .expect(400);

    expect(rejected.body.error.field).toBe('timezone');
  });

  it('rejects a duplicate address with 409', async () => {
    await request(testApp.app).post('/api/v1/auth/register').send(CREDENTIALS).expect(201);

    const response = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send({ ...CREDENTIALS, email: 'PERSON@example.com' })
      .expect(409);

    expect(response.body.error.field).toBe('email');
  });

  it('rejects a malformed address and a short password with 400 and a field', async () => {
    const badEmail = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-address', password: CREDENTIALS.password })
      .expect(400);
    expect(badEmail.body.error.field).toBe('email');

    const shortPassword = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send({ email: 'fine@example.com', password: 'short' })
      .expect(400);
    expect(shortPassword.body.error.field).toBe('password');
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await request(testApp.app).post('/api/v1/auth/register').send(CREDENTIALS).expect(201);
  });

  it('signs in with correct credentials', async () => {
    const response = await request(testApp.app)
      .post('/api/v1/auth/login')
      .send(CREDENTIALS)
      .expect(200);

    expect(response.body.user.email).toBe('person@example.com');
  });

  it('gives an unknown address and a wrong password the identical 401', async () => {
    const wrongPassword = await request(testApp.app)
      .post('/api/v1/auth/login')
      .send({ ...CREDENTIALS, password: 'not-the-password' })
      .expect(401);

    const unknownAddress = await request(testApp.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: CREDENTIALS.password })
      .expect(401);

    /* Byte-identical, so the response cannot be used to enumerate accounts. */
    expect(unknownAddress.body).toEqual(wrongPassword.body);
  });

  it('issues a new session id, so a fixed cookie cannot be reused', async () => {
    const agent = request.agent(testApp.app);

    const first = await agent.post('/api/v1/auth/login').send(CREDENTIALS).expect(200);
    const second = await agent.post('/api/v1/auth/login').send(CREDENTIALS).expect(200);

    const sidOf = (response: request.Response): string =>
      String(response.headers['set-cookie']).split(';')[0] ?? '';

    expect(sidOf(first)).not.toBe(sidOf(second));
  });
});

describe('the session cookie', () => {
  it('is HttpOnly, SameSite=Lax and path-scoped', async () => {
    const response = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send(CREDENTIALS)
      .expect(201);

    const cookie = String(response.headers['set-cookie']);

    expect(cookie).toContain('tasks.sid=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    /* Not Secure in this configuration: the cookie has to travel over plain
       HTTP for the documented `docker compose up` on localhost. */
    expect(cookie).not.toContain('Secure');
  });

  it('is signed: a tampered session id is rejected', async () => {
    const agent = request.agent(testApp.app);
    await agent.post('/api/v1/auth/register').send(CREDENTIALS).expect(201);
    await agent.get('/api/v1/auth/me').expect(200);

    await request(testApp.app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'tasks.sid=s%3Aforged-session-id.invalidsignature')
      .expect(401);
  });

  it('survives a restart of the web process, because the store is Postgres', async () => {
    const registration = await request(testApp.app)
      .post('/api/v1/auth/register')
      .send(CREDENTIALS)
      .expect(201);

    const cookie = registration.headers['set-cookie'];
    expect(cookie).toBeDefined();

    /* A brand-new Express application over the same database - what a
       `docker compose restart web` produces. Nothing about the session lives
       in the old process's memory. */
    const restarted = testApp.restart();

    const response = await request(restarted)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie as unknown as string[])
      .expect(200);

    expect(response.body.user.email).toBe('person@example.com');
  });

  it('is recorded in the session table', async () => {
    await request(testApp.app).post('/api/v1/auth/register').send(CREDENTIALS).expect(201);

    const { rows } = await testApp.database.pool.query<{ count: string }>(
      'SELECT count(*) FROM "session"',
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe('GET /api/v1/auth/me and logout', () => {
  it('rejects an anonymous request', async () => {
    await request(testApp.app).get('/api/v1/auth/me').expect(401);
  });

  it('returns the signed-in user, then stops after logout', async () => {
    const agent = request.agent(testApp.app);
    await agent.post('/api/v1/auth/register').send(CREDENTIALS).expect(201);

    await agent
      .get('/api/v1/auth/me')
      .expect(200)
      .expect((response) => {
        expect(response.body.user.email).toBe('person@example.com');
      });

    await agent.post('/api/v1/auth/logout').expect(204);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('removes the session row on logout', async () => {
    const agent = request.agent(testApp.app);
    await agent.post('/api/v1/auth/register').send(CREDENTIALS).expect(201);
    await agent.post('/api/v1/auth/logout').expect(204);

    const { rows } = await testApp.database.pool.query<{ count: string }>(
      'SELECT count(*) FROM "session"',
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('the seeded demo account', () => {
  it('can sign in with the credentials printed in the README', async () => {
    const { seedDemoData } = await import('@tasks/data');
    const { createBcryptPasswordHasher } = await import(
      '@tasks/web/adapters/bcrypt-password-hasher'
    );

    const hasher = createBcryptPasswordHasher(4);
    await seedDemoData(testApp.database.db, { passwordHash: await hasher.hash('demo1234') });

    const response = await request(testApp.app)
      .post('/api/v1/auth/login')
      .send({ email: DEMO_EMAIL, password: 'demo1234' })
      .expect(200);

    expect(response.body.user.email).toBe(DEMO_EMAIL);
  });
});
