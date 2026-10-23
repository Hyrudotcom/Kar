# Agent notes

Read `docs/architecture.md` first: it defines folder ownership, the SQL schema, RPC and sync contracts.
- Code against `src/contracts/**`; ask the architect to change them.
- Do not run `npm install`; all dependencies are present. Prefix Expo CLI with `EXPO_OFFLINE=1`.
- Routes live in `app/` (expo-router). Never put tests in `app/`.
- Before declaring done: `npm run typecheck && npm run lint && npm test`.
- All UI copy is Dutch. No promotions, no estimated prices, unknown price is never 0.
