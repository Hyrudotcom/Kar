/**
 * Pre-account takeover: someone signs up with another person's e-mail address and a password
 * before that person ever uses the app. The app has no passwords, so such a password must never
 * give a session, not before and not after the real owner signs in with the mailed code.
 */
import { createAuth } from '@/src/lib/backend/supabaseApis';

import { MAILPIT_URL, closeAll, newClient, readMailedCode, sleep, uniqueEmail } from './stack';

jest.setTimeout(60_000);
afterAll(closeAll);

async function clearMail(email: string) {
  await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { method: 'DELETE' });
}

test('a password set by a sign-up never signs in, also after the owner signed in with a code', async () => {
  const email = uniqueEmail('takeover');
  const password = 'Geheim-wachtwoord-123';

  const attacker = newClient();
  const signUp = await attacker.auth.signUp({ email, password });
  expect(signUp.data.session).toBeNull(); // e-mail confirmation is required
  expect((await attacker.auth.signInWithPassword({ email, password })).data.session).toBeNull();

  // The owner of the address signs in like the app does.
  await readMailedCode(email).catch(() => undefined); // the confirmation mail of the sign-up
  await clearMail(email);
  await sleep(1_500); // auth.email.max_frequency
  const owner = newClient();
  const auth = createAuth(owner);
  const sent = await auth.sendEmailCode(email);
  if (!sent.ok) throw new Error(`sendEmailCode: ${sent.error}`);
  const mail = await readMailedCode(email);
  const verified = await auth.verifyEmailCode(email, mail.code);
  expect(verified.ok).toBe(true);
  expect((await owner.auth.getSession()).data.session).not.toBeNull();

  const later = await newClient().auth.signInWithPassword({ email, password });
  expect(later.data.session).toBeNull();
  expect(later.error).not.toBeNull();
});
