# Visual review, round 1

Date: 2026-10-23 · Scope: every v1 screen, light and dark, at 390×844 (iPhone) and 412×915 (Android)
Benchmarks: `design-spec.md` (authoritative for UX), Listonic (simplicity), Mandje (list-comparison layout)
Screenshots: `docs/screenshots/round-1/` (72 PNGs, `NN-screen--device--scheme.png`), also copied to the
shared `screenshots/round-1/` folder.

## 1. How this was run (and what it does NOT prove)

- **Rendering: React Native Web in headless Chromium**, not iOS or Android. No simulators or devices
  were available. Fonts, safe areas, keyboard, bottom-sheet gestures, the share sheet, Switch, haptics
  and focus rendering all differ on device. Everything under "web-only" below may not occur natively,
  and everything in section 6 still has to be checked on real hardware.
- **Backend: the real local Supabase stack** (Postgres + GoTrue + PostgREST + Realtime behind the
  repo's Kong stand-in), with the **real sync engine** (expo-sqlite wasm/OPFS). The shipped web export
  always uses the in-memory demo backend (`createBackend.web.ts`). For this review that file and a
  `metro.config.js` (`.wasm` asset) were **temporarily** changed to use Supabase, then reverted.
  Nothing was committed.
- **Seed data** (local DB only, created through the real RPCs): household "Thuis" with owner Jan and
  member Sanne, 14 items (11 open, 3 checked: Brood, Appels, Pindakaas), notes and g/kg/l units.
  Extra users: Eva (empty list) and Tim (solo household, opens the invite link).
- **Sign-in:** sessions were injected as a signed-in user. The code step was reached by stubbing
  `POST /auth/v1/otp`, because local GoTrue allows 2 mails per hour.
- **Price fixture:** "Goedkoopste route" with data was rendered by intercepting the price-table GETs
  in Playwright. No row was written to any database. The fixture uses fictional chains
  ("Testwinkel Noord/Zuid/Oost") and the source "Screenshotfixture (geen echte prijzen)": two
  complete baskets (one with a 9-day-old price) and one incomplete basket (12 of 14, cheaper than
  both, so it shows that an incomplete basket is never ranked). Product names such as "Melk 1000 ml"
  come from the fixture, not from the app.
- **Benchmark material:** the App Store screenshot images for Listonic and Mandje could not be
  downloaded (`is1-ssl.mzstatic.com` is blocked by the egress proxy, and apps.apple.com returned a
  client error). The comparison uses the screenshot captions listed on mwm.ai (Mandje, 10 captions),
  AppGoblin's monetization data (Listonic) and Listonic's own feature pages. **No pixel-level
  comparison with either app was possible.** This is the same limitation as in design-spec 1.4.

## 2. Screens captured

| # | Screen | State |
|---|---|---|
| 01 / 02 | Sign-in / code step | email form; 6-box OTP with resend countdown |
| 03 | Empty list | Eva, autofocus in the bar |
| 04 / 05 | List | 11 open + "Afgevinkt (3)", collapsed and expanded |
| 06 | Quick-add | "2 kaa" with suggestions |
| 07 | Item detail | Melk, sheet |
| 08 / 09 / 10 | Household | before and after "Deel lijst" (web clipboard fallback), bottom |
| 11 / 12 | Offline | sync icon in the header; explanation sheet |
| 13 | Goedkoopste route | no verified source: "Geen geverifieerde prijzen beschikbaar" |
| 14 | Join | Tim opens `/j/<code>`: "Word je lid van "Thuis"?" |
| 15–18 | Route fixture | opt-in, ranked result, complete store sheet, incomplete store sheet |

All 72 screenshots were viewed. Data was checked after the run, and the seeded list was unchanged.

## 3. Side-by-side comparison

| Aspect | Listonic | Mandje | Goedboodschap (observed, round 1) | Verdict |
|---|---|---|---|---|
| First screen | List, usually with categories and a running total; ad slots on free tier (AppGoblin: ~76% ad revenue, 10 ad SDKs) | "All supermarket deals" home: promo-first, with supermarket logos | The list itself: one-line header "Thuis" + people icon, quick-add bar, rows. No promos, no logos | Better than both. This is the strongest part of the app |
| Adding an item | Type with predictive suggestions | "Type list, get prices" notepad, then product details/prices are attached | Type + Enter, or tap one of ≤4 suggestions. The "‘kaa’ toevoegen (2)" row sits on top in `accentSoft` | Matches Listonic's speed. The focus outline on web is noisy (D-07) |
| Row anatomy | Checkbox, name, quantity; often price and category colour | Product row with price per store | Round 24 pt checkbox, 17 pt name, 15 pt muted quantity, 13 pt note. Hairline separators, 56 pt rows | Calmest of the three. Matches spec 3 exactly |
| Visual noise | Low in the core, high with ads/upsell | High (deals, cards, alerts, categories) | Very low. One accent green, grey scale, no logos, no badges | Meets principle 0.7. Remaining noise: "Code vervangen" (D-03), three red actions in Household (D-13), web focus rings (D-07/08) |
| Sharing | Link, no account needed | Account | "Deel lijst" primary button; code shown after sharing; on web, "Uitnodiging gekopieerd" snackbar | Simple. "Code vervangen" next to it is risky (D-03) |
| Offline | Sync complaints in reviews | Unknown | Header cloud-off icon only; tap opens a one-sentence sheet | Matches spec. The icon is hard to read at 20 px (D-09) |
| Price comparison | Own price field, user-entered | Central: "List cost per supermarket" with total per store and availability per item; supermarket filter; loyalty cards | Separate opt-in tab. Flat store rows (name left, total right, "Goedkoopste · 1 verouderd"), "+€3,77" delta, incomplete stores under "Onvolledig" with "12 van 14 prijzen" and **no amount** | Adopts Mandje's one useful idea (total per store + coverage) without the clutter. More honest than Mandje, where it is unclear whether a partial basket shows a total |
| No-data honesty | n/a | n/a (folder data) | "Geen geverifieerde prijzen beschikbaar" + "We laten liever niets zien dan een verkeerde vergelijking." No button, no toggle, no € anywhere | Correct and calm |
| Per-store detail | n/a | Per-item availability on the comparison screen | Sheet: product + size, "2×" muted, amount bold tabular, "Geen prijs" with "?" in muted, "9 d oud", overage "400 g, 100 g meer" | Good. Header lacks total/status (D-14) |
| Account wall | None for receivers | Account | Email code only on web (Apple/Google not rendered on web) | Higher barrier than Listonic, as accepted in spec risk 4 |

## 4. Defect list

Severity: **Major** = wrong behaviour or misleading copy a user will hit, or a spec rule broken in a
risky way. **Minor** = visible polish/consistency problem. **Nit** = taste/cleanup.
"Web-only?" = may not reproduce natively; verify on device before fixing.

| ID | Sev | Screen | Defect | Evidence | Fix direction |
|---|---|---|---|---|---|
| D-01 | **Major** | Boot / any | Any failure to open the local database is shown as **"Geen internet · Inloggen en lid worden kan alleen online"** (`SessionProvider.tsx` ~l.167: `openEngine` catch → `noInternet`). Reproduced: reloading the page while the previous OPFS handle is held gives `cannot create file`, so the user sees "Geen internet" while online. On device the same path is a locked, corrupt or full SQLite file, and "Opnieuw proberen" never fixes it. | reload test; console `cannot create file`, route `/status` | Separate state + copy ("Je lijst kon niet worden geopend…") and log the cause; keep "Geen internet" for real network failures only |
| D-02 | **Major** | Sign-in | "Door verder te gaan ga je akkoord met de **voorwaarden**." The terms are not linked and cannot be opened (plain `AppText`). There is also no privacy-policy link. Store review and the GDPR expect both to be reachable before an account is created. | 01-sign-in | Make "voorwaarden" and "privacybeleid" links (≥44 pt target), or drop the sentence until the documents exist |
| D-03 | **Major** | Household | **"Code vervangen"** is always visible as an accent text button right under "Deel lijst", even before a code exists (a lone right-aligned link above a blank gap, 08). One tap immediately invalidates every link already sent (`share(true)`: no confirmation, no undo). Spec 4.2 puts it **inside the share sheet, owner only**. | 08, 09 | Move it behind the share sheet (or a confirm sheet: "Oude links werken dan niet meer"). Never show it before a code exists |
| D-04 | **Major** | Tab bar | Tab labels render at **10 px** in `system-ui`, a different font stack from the rest of the app. That is the smallest text in the app (the spec's smallest token is `footnote` 13). At 412 px the labels look like captions; inactive grey + 10 px is the weakest text on screen, on the only navigation. | measured 10px/w500; 04, 13 | Use the type tokens (≥ 12–13) and the app font; verify Dynamic Type/font scale on device |
| D-05 | Minor | Route header | The route title sits at y=8 (list header y=15) and is semibold, while "Thuis" is regular. Switching tabs makes the header jump 7 px and change weight. The title is cramped against the top edge. | 13 vs 04; measured | One shared header component: same height, padding and weight on both tabs |
| D-06 | Minor | Route header | The ⓘ button is vertically centred on title + subtitle, so it lines up with the subtitle instead of the title (spec 4.5 puts it on the title line). | 16 | Align with the title baseline |
| D-07 | Minor (web-only?) | Quick-add | Focus draws a **square 2 px accent outline around the inner `TextInput` only**. It ignores the 12 pt radius of the bar and leaves the "+" and "✕" outside the ring. On the empty list (autofocus) it is the loudest element on screen. `outlineWidth: 0` in `QuickAddBar.tsx` is not taking effect. On native there is no focus indicator at all. | 03, 06 | Put the focus style on the bar container (rounded border or accent hairline) on all platforms |
| D-08 | Minor (web-only?) | Join | "Lid worden" gets the browser's default **yellow/orange focus ring** on open, the only non-palette colour in the app. | 14 | Same focus treatment as D-07 (accent, rounded) |
| D-09 | Minor | List header | The offline icon (cloud with a slash, about 20 px, muted) reads as "eye-off/hidden" at that size. It is the only offline signal (spec 4.3), so it has to be unmistakable. | 11 | Heavier/bigger cloud glyph; check at 1× on device |
| D-10 | Minor | List | A snackbar from Household ("Uitnodiging gekopieerd") follows you to the list and **covers the last rows / the "Afgevinkt (3)" header** (iPhone 11-offline). The list has no bottom inset while a snackbar is visible. | 11 (iPhone) | Add bottom content inset while the snackbar shows, or dismiss on navigation |
| D-11 | Minor | Join (copy) | Title uses straight ASCII quotes, **Word je lid van "Thuis"?**, while suggestions use curly ‘kaa’. The joiner's own household is also "Thuis", so the question is ambiguous ("which Thuis?"). | 14 | Dutch quotes (‘Thuis’ or „Thuis”). Disambiguate: "Word je lid van ‘Thuis’ van Jan?" |
| D-12 | Minor (doc) | Route | Copy diverges from design-spec 4.5: the spec says **"Nog niet beschikbaar"**, but the app, contracts and e2e use **"Geen geverifieerde prijzen beschikbaar"**. The app follows the product rule. The spec must be updated so the next reviewer does not "fix" it back. | 13 | Update design-spec 4.5 / 4.7 |
| D-13 | Minor | Household | Three red danger texts (member "Verwijderen", "Huishouden verlaten", "Account verwijderen") are the loudest elements on the screen. "Uitloggen" is plain body text with no affordance. The household-name field is a grey box with no label and no edit hint. | 08, 10 | Label "Naam"; group account actions under one divider; consider a lower-key colour until press for "Account verwijderen" |
| D-14 | Minor | Store sheet | The sheet header is only the store name: no total, no coverage, and the incomplete store's sheet does not say "Onvolledig · 12 van 14 prijzen". The last line ends flush at the bottom edge with no scroll cue (the sheet does scroll, verified). | 17, 18 | Subtitle "€53,84 · 14 van 14 prijzen · 1 verouderd" / "Onvolledig · 12 van 14 prijzen"; bottom padding |
| D-15 | Minor | Route opt-in vs no-data | The opt-in state is vertically centred with no icon, while the no-data state is top-third with an icon. Two layouts for what is the same "empty tab" family. "Ontbrekende prijzen tonen we eerlijk." alone does not say what the tap does or which source is used. | 13, 15 | Use `EmptyState` for both. Add a footnote with source + channel |
| D-16 | Minor | List rows | "Yoghurt **1 l**" reads as "1 I"/"11" in the web font. The same risk exists with SF Pro/Roboto, where lowercase l is a bare stroke. | 04 | Check on device; if ambiguous, render "1 liter" (or "1 L") in the row only |
| D-17 | Nit | Suggestions | "kaa" suggests **Kaart** and **Kaarsen** (non-grocery catalogue entries) ahead of cheese variants. The household's own "Kaas jong belegen" (open) is not offered. | 06 | Review the catalogue for non-food noise, or weight food above non-food |
| D-18 | Nit | Sign-in | On web only the email path renders: no Apple/Google buttons and no "of" divider. The provider order (iOS: Apple first; Android: Google first) cannot be verified here. The block sits low, with ~40% empty space above the title. | 01 | Verify on device; consider top-aligning at ~25% |
| D-19 | Nit | OTP | "Opnieuw sturen (30 s)" in `textDisabled` (#8E9692 on white ≈ 3.2:1). WCAG allows this for disabled controls, but the countdown is information. Consider `textMuted` for the counter text. | 02 | — |
| D-20 | Nit | Info sheet | "We gebruiken <bron> (<kanaal>)" gives double parentheses when the source name has a parenthesis. The real source names in the price verdict do not, so this is only a template robustness issue. | info sheet | Use "via" instead of brackets |
| D-21 | Nit (web-only) | Routing | Cold-loading `/household` or `/route` lands on "Mijn lijst". Only `/j/<code>` is a real deep link on device, so this is low impact. | reload test | — |

What passed (spot-checked against the spec): one-line header with "Huishouden" icon button (48×48);
rows ≥56 pt, checkbox tap zone covers the row's left side (measured 390×57 row, body 322×56);
"Afgevinkt (n)" collapsed by default with a "Wissen" text button (76×48); quick-add 48 pt high;
suggestions show "+ ‘kaa’ toevoegen (2)" first, then ≤3 plain rows without icons;
item detail is name / Hoeveelheid / Notitie / "Toegevoegd door jou · 19:07" / red "Verwijderen", with no
"Klaar"; offline = icon only, sheet copy exactly as spec; the route never shows € in the no-data state;
incomplete basket shows no total even when it would be cheapest; stale shown as "9 d oud";
"Geen prijs" muted with "?", not red; overage "400 g, 100 g meer" only above 25%; amounts use tabular
figures; dark mode tokens match spec 2.1 (no contrast failures seen on primary text, muted text or the
green-on-dark primary button).

## 5. Priorities for round 2

1. D-01 (wrong "Geen internet"), D-02 (terms/privacy links), D-03 ("Code vervangen"), D-04 (tab labels).
2. One header component for both tabs (D-05/D-06) and one focus style (D-07/D-08).
3. Household tidy-up (D-13), store-sheet header (D-14), Dutch quotes and join copy (D-11), spec update (D-12).

## 6. Must be checked on device (iOS + Android), not covered by this round

- Real fonts (SF Pro / Roboto): truncation, wrapping of long names, "1 l" legibility, tabular euro amounts.
- Safe areas: notch/Dynamic Island, home indicator under the tab bar and bottom sheets, Android gesture nav.
- Tab bar height and label size per platform; Dynamic Type / Android font scale at 135% and 200% (spec 7).
- Keyboard: autofocus only on an empty list, Enter keeps focus, scroll dismisses the keyboard, sheets lift above the keyboard.
- Bottom sheets: swipe-down to close, tap outside, scroll inside long store sheets, Android back button.
- Swipe-left to delete + undo snackbar, haptics (light on check, medium on delete), reduced motion.
- The 1.5 s "nothing moves under your finger" rule with real touches, and realtime inserts from a second phone.
- Native share sheet for "Deel lijst" (web used the clipboard fallback), universal link / app link `/j/<code>` cold and warm.
- Apple and Google sign-in buttons (order per platform), OTP autofill (`oneTimeCode`/SMS-less autofill on Android).
- Offline detection via NetInfo (airplane mode, captive portal), outbox survival after kill + restart, the "Geen internet" first-start state.
- Focus/selection rendering (D-07/D-08 may be web-only); VoiceOver/TalkBack labels and focus order (spec 7).
- Dark mode via the OS setting (status bar style, Android navigation bar colour, Switch colours in Household when prices are available).
- Cold start ≤ 1.5 s on a mid-range Android, and the SQLite open path (D-01) on a full or locked database.

## Sources

- Mandje screenshot captions: https://mwm.ai/apps/mandje/6758279445
- Mandje in ID.nl, October 2026: https://id.nl/huis-en-entertainment/mobiel/smartphone-en-tablet/6-apps-voor-oktober-2026-van-boodschappen-vergelijken-tot-zelf-muziek-maken-2
- Listonic monetization/screenshots listing: https://appgoblin.info/apps/331302745
- Listonic feature page: https://listonic.com/compare-apps/listonic-vs-bring
- Listonic App Store page (not retrievable): https://apps.apple.com/app/grocery-shopping-list-listonic/id331302745
