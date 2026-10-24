// Citizen sign-up rules. They mirror the backend (server/src/routes/auth.ts):
// name 1–100 characters (trimmed), valid email up to 254 (trimmed, lower-cased), password 8–128 used exactly as typed.

export const NAME_MAX = 100;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export type SignUpField = 'name' | 'email' | 'password' | 'confirmPassword' | 'consent';
export type SignUpErrors = Partial<Record<SignUpField, string>>;

export interface SignUpValues {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  consent: boolean;
}

/** Field order, used for the error summary and to focus the first problem. */
export const SIGN_UP_FIELDS: SignUpField[] = ['name', 'email', 'password', 'confirmPassword', 'consent'];

// A short list of passwords that are guessed first. The backend accepts them; the client asks for better.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123',
  '11111111', '00000000', 'iloveyou', 'abcdefgh', 'abc12345', 'letmein1', 'welcome1', 'admin123', 'civicfix',
  'civicfix1', 'civicfix123', 'india123', 'bangalore', 'mangalore', 'passw0rd', 'football', 'baseball',
]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateName(name: string): string | undefined {
  const value = name.trim();
  if (!value) return 'Enter your name.';
  if (value.length > NAME_MAX) return `Keep your name to ${NAME_MAX} characters or fewer.`;
  return undefined;
}

export function validateEmail(email: string): string | undefined {
  const value = normalizeEmail(email);
  if (!value) return 'Enter your email address.';
  if (value.length > EMAIL_MAX) return `Use an email address of ${EMAIL_MAX} characters or fewer.`;
  // Same shape the server accepts: something@domain.tld, no spaces.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Enter an email address like name@example.com.';
  return undefined;
}

export function validatePassword(password: string, context: { email?: string; name?: string } = {}): string | undefined {
  if (!password) return 'Create a password.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use ${PASSWORD_MAX} characters or fewer.`;
  if (isCommonPassword(password, context)) return 'This password is too easy to guess. Try a short phrase of a few words.';
  return undefined;
}

export function validateSignUp(values: SignUpValues): SignUpErrors {
  const errors: SignUpErrors = {};
  errors.name = validateName(values.name);
  errors.email = validateEmail(values.email);
  errors.password = validatePassword(values.password, { email: values.email, name: values.name });
  if (!errors.password) {
    if (!values.confirmPassword) errors.confirmPassword = 'Type your password again.';
    else if (values.confirmPassword !== values.password) errors.confirmPassword = 'The passwords do not match.';
  }
  if (!values.consent) errors.consent = 'Agree to the privacy notice to create an account.';
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as SignUpErrors;
}

function isCommonPassword(password: string, context: { email?: string; name?: string }): boolean {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  if (/^(.)\1+$/.test(password)) return true; // one repeated character
  if (/^(0123456789|1234567890|abcdefghij)/.test(lower) && lower.length <= 10) return true;
  const local = context.email ? normalizeEmail(context.email).split('@')[0] : '';
  if (local && local.length >= 4 && lower === local) return true;
  const name = context.name?.trim().toLowerCase().replace(/\s+/g, '') ?? '';
  if (name.length >= 4 && lower.replace(/\s+/g, '') === name) return true;
  return false;
}

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  level: StrengthLevel;
  label: 'Too short' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  hint: string;
}

/**
 * A rough, explainable strength estimate. Length matters most (passphrases are encouraged);
 * variety helps a little. It is guidance, not a guarantee.
 */
export function passwordStrength(password: string, context: { email?: string; name?: string } = {}): PasswordStrength {
  if (password.length < PASSWORD_MIN) {
    return { level: 0, label: 'Too short', hint: `${PASSWORD_MIN - password.length} more character${PASSWORD_MIN - password.length === 1 ? '' : 's'} needed.` };
  }
  if (isCommonPassword(password, context)) return { level: 1, label: 'Weak', hint: 'This is a commonly used password.' };

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const words = password.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3).length;
  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;
  if (password.length >= 20 || words >= 4) score += 1;
  if (classes >= 3) score += 1;
  if (/(.)\1\1/.test(password)) score -= 1;

  const level = Math.max(1, Math.min(4, score)) as StrengthLevel;
  const labels = { 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' } as const;
  const hints = {
    1: 'Make it longer. A few unrelated words work well.',
    2: 'Getting there. Longer is stronger.',
    3: 'Good password.',
    4: 'Strong password.',
  } as const;
  return { level, label: labels[level as 1 | 2 | 3 | 4], hint: hints[level as 1 | 2 | 3 | 4] };
}

/** Maps backend validation details (`body.email`, …) to form fields. */
export function serverFieldErrors(details: unknown): SignUpErrors {
  if (!Array.isArray(details)) return {};
  const errors: SignUpErrors = {};
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null) continue;
    const { field, issue, message } = detail as { field?: unknown; issue?: unknown; message?: unknown };
    const key = typeof field === 'string' ? field.replace(/^body\./, '') : '';
    if (key !== 'name' && key !== 'email' && key !== 'password') continue;
    if (issue === 'duplicate') errors.email = 'An account with this email already exists.';
    else errors[key] = typeof message === 'string' ? message : 'Check this field.';
  }
  return errors;
}
