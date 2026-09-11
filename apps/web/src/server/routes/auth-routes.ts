/**
 * FR1 - register, log in, log out.
 *
 * These handlers do three things and no more: validate the shape of the
 * request, call the business logic, and turn the result into a response. Every
 * rule about what makes a password acceptable or an address already taken lives
 * in `@tasks/core`; every decision about cookies lives in `../presentation`.
 */
import type { AuthService } from '@tasks/core';
import { Router } from 'express';
import { z } from 'zod';

import { toUserResponse } from '../presentation/serializers.js';
import { currentUser, endSession, requireAuthentication, startSession } from '../presentation/session.js';
import { isValidTimeZone } from '../presentation/timezone.js';

export const DEFAULT_TIMEZONE = 'Europe/London';

const registerBody = z.object({
  email: z.string(),
  password: z.string(),
  /* Validated as a real IANA zone here because the presentation layer is the
     only layer that interprets timezones at all. */
  timezone: z
    .string()
    .refine(isValidTimeZone, { message: 'That is not a recognised timezone' })
    .optional(),
});

const loginBody = z.object({
  email: z.string(),
  password: z.string(),
});

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  router.post('/register', async (request, response) => {
    const body = registerBody.parse(request.body);

    const user = await authService.register({
      email: body.email,
      password: body.password,
      timezone: body.timezone ?? DEFAULT_TIMEZONE,
    });

    /* Registering signs you in, so the client needs no second round trip. */
    await startSession(request, user);
    response.status(201).json({ user: toUserResponse(user) });
  });

  router.post('/login', async (request, response) => {
    const body = loginBody.parse(request.body);

    const user = await authService.login(body.email, body.password);

    await startSession(request, user);
    response.status(200).json({ user: toUserResponse(user) });
  });

  router.post('/logout', async (request, response) => {
    await endSession(request);
    /* Clear the browser's copy too, so a stale cookie is not presented on
       every subsequent request. */
    response.clearCookie('tasks.sid', { httpOnly: true, sameSite: 'lax', path: '/' });
    response.status(204).end();
  });

  router.get('/me', requireAuthentication(authService), (request, response) => {
    response.status(200).json({ user: toUserResponse(currentUser(request)) });
  });

  return router;
}
