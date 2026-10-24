import { Schema, model, type InferSchemaType } from 'mongoose';

export const SESSION_REVOKE_REASONS = ['LOGOUT', 'REFRESH_TOKEN_REUSE', 'ACCOUNT_DISABLED', 'ADMIN'] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * One login (device/browser). Access tokens carry this session's ID, so revoking the session
 * invalidates them immediately. Only SHA-256 hashes of refresh tokens are stored.
 */
const authSessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    refreshTokenHash: { type: String, required: true, match: SHA256_HEX },
    // Hashes of refresh tokens already rotated out. Presenting one means it was stolen or replayed.
    rotatedTokenHashes: { type: [{ type: String, match: SHA256_HEX }], default: [] },
    // Absolute lifetime: refreshing does not extend it.
    expiresAt: { type: Date, required: true, immutable: true },
    lastUsedAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String, enum: SESSION_REVOKE_REASONS },
    userAgent: { type: String, maxlength: 200 },
  },
  { timestamps: true },
);

authSessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
authSessionSchema.index({ rotatedTokenHashes: 1 });
authSessionSchema.index({ user: 1, revokedAt: 1 });
// MongoDB deletes sessions automatically once they expire.
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AuthSessionFields = InferSchemaType<typeof authSessionSchema>;
export const AuthSession = model('AuthSession', authSessionSchema);
