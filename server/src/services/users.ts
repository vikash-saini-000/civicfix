import type { AuthService, PublicUser } from '../auth/authService.js';
import type { Principal } from '../auth/roles.js';
import { User } from '../models/index.js';
import { notFoundError } from '../utils/errors.js';
import { auditUserAction, diff } from './audit.js';

/** Fields a user may change on their own profile. Everything else is managed elsewhere. */
export interface ProfileUpdate {
  name?: string;
}

export function createUserService(auth: Pick<AuthService, 'currentUser'>) {
  return {
    getProfile: (principal: Principal): Promise<PublicUser> => auth.currentUser(principal),

    async updateProfile(principal: Principal, update: ProfileUpdate, requestId: string): Promise<PublicUser> {
      const user = await User.findById(principal.userId);
      if (!user) throw notFoundError('The account');
      const before = { name: user.name };
      if (update.name !== undefined) user.name = update.name;
      const changes = diff(before, { name: user.name }, ['name']);
      if (changes.length > 0) {
        await user.save();
        await auditUserAction({ actor: principal, action: 'user.profile_updated', targetType: 'User', targetId: user._id, requestId, changes });
      }
      return auth.currentUser({ ...principal, name: user.name });
    },
  };
}
export type UserService = ReturnType<typeof createUserService>;
