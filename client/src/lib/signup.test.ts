import { describe, expect, it } from 'vitest';
import { passwordStrength, serverFieldErrors, validateEmail, validatePassword, validateSignUp } from './signup';

const valid = { name: 'Asha Rao', email: 'Asha@Example.com ', password: 'blue river tea cup', confirmPassword: 'blue river tea cup', consent: true };

describe('sign-up rules (mirroring the backend)', () => {
  it('accepts a complete, valid form', () => {
    expect(validateSignUp(valid)).toEqual({});
  });

  it('reports every problem at once', () => {
    expect(validateSignUp({ name: ' ', email: 'nope', password: 'short', confirmPassword: '', consent: false })).toEqual({
      name: 'Enter your name.',
      email: 'Enter an email address like name@example.com.',
      password: 'Use at least 8 characters.',
      consent: 'Agree to the privacy notice to create an account.',
    });
  });

  it('enforces the backend length limits', () => {
    expect(validateSignUp({ ...valid, name: 'a'.repeat(101) }).name).toMatch(/100 characters/);
    expect(validatePassword('a'.repeat(129))).toMatch(/128 characters/);
    expect(validateEmail(`${'a'.repeat(250)}@x.com`)).toMatch(/254 characters/);
  });

  it('asks for a better password than common ones or the email name', () => {
    expect(validatePassword('password123')).toMatch(/too easy/);
    expect(validatePassword('aaaaaaaaaa')).toMatch(/too easy/);
    expect(validatePassword('ashar0123', { email: 'ashar0123@example.com' })).toMatch(/too easy/);
  });

  it('checks the confirmation only once the password itself is valid', () => {
    expect(validateSignUp({ ...valid, confirmPassword: 'different words here' }).confirmPassword).toBe('The passwords do not match.');
    expect(validateSignUp({ ...valid, password: 'short', confirmPassword: 'x' }).confirmPassword).toBeUndefined();
  });

  it('rates long passphrases above short mixed passwords', () => {
    expect(passwordStrength('abc').label).toBe('Too short');
    expect(passwordStrength('password1').label).toBe('Weak');
    expect(passwordStrength('correct horse battery staple').level).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('Tr0ub4dor&3xyz').level).toBeGreaterThanOrEqual(3);
  });

  it('maps backend field details to form fields', () => {
    expect(serverFieldErrors([{ field: 'body.email', issue: 'duplicate', message: 'This email is already registered.' }])).toEqual({
      email: 'An account with this email already exists.',
    });
    expect(serverFieldErrors([{ field: 'body.password', issue: 'too_small', message: 'Too small' }, { field: 'body.role', issue: 'unrecognized_key' }])).toEqual({
      password: 'Too small',
    });
    expect(serverFieldErrors(undefined)).toEqual({});
  });
});
