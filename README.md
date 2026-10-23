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
