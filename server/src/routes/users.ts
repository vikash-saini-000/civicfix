import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { input, validate } from '../middleware/validate.js';
import type { ProfileUpdate, UserService } from '../services/users.js';
import { sendSuccess } from '../utils/respond.js';
import { text } from '../validation/common.js';

// Only `name` is self-service. Email changes need verification (not implemented); roles, status and
// memberships are managed through admin/department endpoints. Anything else is a 400.
const profileUpdate = z
  .strictObject({ name: text(1, 100).optional() })
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field to update.');

/** /api/v1/users */
export function usersRouter(deps: { authService: AuthService; userService: UserService }): Router {
  const router = Router();
  router.use(requireAuth(deps.authService));

  router.get('/me', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { user: await deps.userService.getProfile(req.auth!) });
  });

  router.patch('/me', validate({ body: profileUpdate }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { user: await deps.userService.updateProfile(req.auth!, input<ProfileUpdate>(req, 'body'), req.id) });
  });

  return router;
}
