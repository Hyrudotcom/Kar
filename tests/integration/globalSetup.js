/** Fails fast with instructions when the local stack's API (:54321) is not reachable. */
module.exports = async function globalSetup() {
  const url = process.env.GB_API_URL ?? 'http://127.0.0.1:54321';
  try {
    const res = await fetch(`${url}/auth/v1/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(
      `Local Supabase API not reachable at ${url} (${e.message}). Start it with \`npm run db:start\` ` +
        '(or, without the kong image: `npx supabase start --ignore-health-check -x kong,...` then `npm run db:gateway`).',
    );
  }
};
