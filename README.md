# Goedboodschap

Minimalistische gedeelde boodschappenlijst voor iOS en Android (Expo + Supabase).

- Architectuur, schema, RPC- en sync-contract, mapeigendom: [`docs/architecture.md`](docs/architecture.md)
- Gedeelde TypeScript-contracten: `src/contracts/`
- UX-specificatie: `design-spec.md` (discovery-map)

```bash
npm run typecheck && npm run lint && npm test   # geen netwerk of database nodig
npm run db:start && npm run test:db             # lokale Supabase (Docker)
npm run export:web && npm run test:e2e          # web-export + Playwright
```

Expo CLI: zet `EXPO_OFFLINE=1` in deze omgeving (api.expo.dev is geblokkeerd).

## Local stack and integration tests

```sh
dockerd > /tmp/dockerd.log 2>&1 &           # if the Docker daemon is not running
npm run db:start                             # or, when the kong image cannot be pulled:
#   npx supabase start --ignore-health-check -x kong,studio,imgproxy,storage-api,logflare,vector,edge-runtime,supavisor,postgres-meta
#   npm run db:gateway                       # Kong stand-in on :54321 (+ Dutch OTP mail template)
npm run db:reset                             # apply all migrations
npm run test:db                              # SQL / RLS / RPC tests (pg)
npm run test:integration                     # real users + sync engine + API/Realtime on :54321
GB_SYNC_PG=1 npx jest --selectProjects sync  # sync engine against the real RPCs
npm run db:stop
```

The app needs `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (see `.env.example`);
a device build without them fails with a configuration error. `EXPO_PUBLIC_DEMO_MODE=1` runs a device
build on in-memory demo data. The web export (`npm run export:web`, `npm run test:e2e`) always uses the
demo backend and is for visual inspection only.
