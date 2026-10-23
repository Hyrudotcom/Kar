# Visual review, round 3

Date: 2026-10-23 · Build: `28e5953` ("Fix round 2"), working tree clean apart from untracked docs
Scope: every v1 screen, light and dark, at 390×844 (iPhone) and 412×915 (Android)
Benchmarks: `design-spec.md` (authoritative for UX), Listonic (simplicity), Mandje (list-comparison layout)
Screenshots: `docs/screenshots/round-3/` (91 PNGs, `NN-screen--device--scheme.png`). They are also copied to
the shared folder `screenshots/round-3/`.

## 1. How this was run (and what it does NOT prove)

- **Rendering: React Native Web in headless Chromium** (`/opt/pw-browsers/chromium`), not iOS or Android.
  **No simulator or device was run.** The rendered font is the browser's `-apple-system` fallback, not
  SF Pro or Roboto. Safe areas, tab-bar insets, the keyboard, sheet gestures, the native share sheet,
  the native `Switch`, haptics and focus rendering all differ on a device. Defects marked "web-only?"
  may not occur natively. Section 6 lists what still has to be checked on real hardware.
- **Backend: the real local Supabase stack** (`npx supabase start`; Postgres, GoTrue, PostgREST,
  Realtime, Kong). The database was reset to the current migrations first (`supabase db reset`). The
  app ran the **real sync engine** (expo-sqlite wasm). The web export normally uses the in-memory demo
  backend, so three changes were made **temporarily** and reverted afterwards:
  `createBackend.web.ts` used the Supabase backend, a `metro.config.js` added `.wasm` assets and routed
  `expo-secure-store` to a localStorage shim, and the shim lived in `.review-shims/`. `dist/` was then
  re-exported with the demo backend. Nothing was committed. `git status` shows only the untracked docs.
- **Seed data** (local DB only, created through the real RPCs `create_household`, `create_invite`,
  `accept_invite` and `apply_mutations`): household "Thuis" with owner Jan and member Sanne, 12 items
  (9 open, 3 checked: Brood, Appels, Pindakaas), with notes and g/kg/l units. Extra users: Eva (empty
  list) and Tim (alone in his own household; he opens the invite link `/j/8TYDFT`).
- **Sign-in:** sessions came from an admin magic link followed by `verifyOtp` (the e-mail code). They
  were injected into the chunked session storage. To reach the code step, `POST /auth/v1/otp` was stubbed.
- **Price fixture:** the "Goedkoopste route" data states were rendered by intercepting the price-table
  GETs in Playwright (with a `Content-Range` count). **No price row was written to any database.** The
  fixture uses fictional chains ("Testwinkel Noord/Zuid/Oost") and the source "Screenshotfixture (geen
  echte prijzen)". Noord and Zuid are complete baskets; Noord has one price that is 9 days old. Oost is
  an incomplete basket (10 of 12 prices; Koffiebonen and Wc-papier are missing). If it were ranked, Oost
  would be the cheapest. Product names such as "Melk 1000 ml" and "Bananen 1 st" come from the fixture,
  not from the app.
- **Measurements** (font size, line height, colour, tap-target size, focus style) were read from the DOM
  in a separate pass (iPhone complete; the Android pass stopped at the route step because opt-in was
  already on, and the earlier Android measurements match iPhone). The numbers are CSS px, which equal
  pt/dp at these viewports.
- **Benchmark material:** I again **could not view the Listonic and Mandje store screenshots.** The
  image hosts `is1-ssl.mzstatic.com` and `grand-screen.com` return `CONNECT 403` from the egress proxy,
  and WebFetch fails on the images. The comparison below therefore relies on Mandje's ten screenshot
  captions (mwm.ai lists them with their image URLs), the ID.nl review, Listonic's own feature page and
  the round-2 sources. **A pixel-level comparison with either app was not possible.** Rounds 1 and 2 and
  design-spec 1.4 have the same limitation.

## 2. Screens captured (all viewed)

| # | Screen | State |
|---|---|---|
| 01 / 02 / 03 | Sign-in | E-mail form; 6-box code step with countdown; "Uitnodigingscode" sheet (empty field) |
| 04 | Empty list | Eva, autofocus in the bar |
| 05 / 06 | List with items | 9 open + "Afgevinkt (3)", collapsed and expanded |
| 07 | Quick-add | "2 kaa" with suggestions |
| 08 | Item detail | Melk, bottom sheet |
| 09 / 10 / 11 | Household / invite | Before and after "Deel lijst" (web clipboard fallback). 11 is identical to 10 because the page fits |
| 12 / 13 | Offline | Sync icon in the header; explanation sheet |
| 14 | Goedkoopste route | No verified source: "Geen geverifieerde prijzen beschikbaar" |
| 15 | Join | Tim opens `/j/<code>` |
| 16–21 | Route fixture | Opt-in; ranked result (2 complete + 1 incomplete); complete-store sheet; incomplete-store sheet (top and scrolled); ⓘ sheet |
| 22 | Household | With the price switch (opt-in on) |
| 23 / 24 (iPhone light only) | Extra | Store sheets scrolled to the end (Noord shows "9 d oud"; Oost shows "Geen prijs"); full-page Household |

I looked at every screenshot: iPhone light at full size, all four variants of each screen as
side-by-side contact sheets, and full-size crops where detail mattered (the offline icon, the sheet
headers). The capture runs logged no page errors and no console errors.

## 3. Side-by-side comparison

| Aspect | Listonic | Mandje | Goedboodschap (observed, round 3) | Verdict |
|---|---|---|---|---|
| First screen | The list, with automatic categories and an optional running total. Ads on the free tier | Promo-first home: "All supermarket deals", supermarket logos, featured offers | The list: one-line header "Thuis" + people icon, quick-add bar, rows. No promos, logos or totals | The calmest of the three. Still the app's strongest screen |
| Navigation chrome | Bottom bar plus menus; ad slots | Many destinations: deals, list, favourites, loyalty cards, search, categories | Two tabs in a 56 pt bar; 13/16 labels now fully visible (D2-01 fixed). The route tab icon is a "receipt/document" that is reused as the empty-state icon | Right concept, and it no longer looks broken |
| Adding an item | "Fast entry", voice, predictive suggestions from history | "Type list, get prices" notepad | Type + Enter, or tap one of ≤4 suggestions. "kaa" still offers **Kaart** and **Kaarsen** instead of the household's own "Kaas jong belegen" (D2-17) | As fast as Listonic. Listonic's history-first ranking is better |
| Row anatomy | Checkbox, name, quantity/unit, note; optional price and category colour | Product row with price per store | 24 pt round checkbox, 17 pt name, 15 pt muted quantity, 13 pt note, full-bleed hairlines, 57 pt rows. "1 l" still reads as "1 I" (D2-16) | Matches spec 3 exactly; the cleanest row of the three |
| Alignment | – | – | Four left edges in one column: section chevron at 24, "Afgevinkt (3)" at 44, suggestion text at 52, row names at 56. "Wissen" ends 24 pt from the edge, while the bar ends 16 pt from it (D2-18) | Still sloppy; it shows on the main screen |
| Visual noise | Low in the core, high with ads and upsells | High (deals, alerts, cards, categories, filters, price per kilo) | Very low on the list and the route result. Higher than needed on Household (green, red, red and grey text buttons; a grey "Code vervangen" that looks disabled) and on sign-in (two link styles plus legal text repeated as grey labels) | Meets principle 0.7 on the main screens; the secondary screens still need a tidy pass |
| Typography | – | – | The 20/17/15/13 scale is used consistently. Inversions remain: "Code vervangen" 17/500 next to the code at 13/400; the legal links at 17/500 under a 13 pt sentence | Good tokens, uneven use |
| Sharing | Link, no account needed | Account, max 4 people | "Deel lijst" primary button. Afterwards the page shows "Code: 8TYDFT" (13 pt muted) and "Code vervangen" (17 pt grey). The web build shows "Uitnodiging gekopieerd" | Simple, but "Code vervangen" is still on the page and still not in the share sheet (D2-06) |
| Joining | Open the link | Account | Sheet "Word je lid van ‘Thuis’ van Jan?", then "2 leden" and one button. **The browser's orange focus ring is still on the button** (D2-02) | One tap, as specified. The title deviates from the spec ("Uitgenodigd door …" was dropped instead of the "van Jan") |
| Offline | Users complain about sync | Unknown | A header cloud-off icon only; a tap opens a one-sentence sheet. At 1× the glyph reads as "eye-off", and its stroke shows internal loops | Spec-correct behaviour, but the only signal is still ambiguous (D3-01) |
| Price comparison | User-entered prices and a list total | Central: "List cost per supermarket", with per-item availability and a supermarket filter; loyalty cards | Separate opt-in tab. Flat store rows: name left, bold total right; "Goedkoopste · 1 verouderd"; "+€3,13"; under "Onvolledig", Oost shows "10 van 12 prijzen" and **no amount**, although it would be cheapest | Takes Mandje's one useful idea (total per store + coverage) without the clutter, and is more honest about partial baskets than either app |
| No-data honesty | n/a | n/a (leaflet data) | "Geen geverifieerde prijzen beschikbaar" + two short sentences in 15 pt muted. No button, no toggle, no € anywhere | Correct and calm. The spec text is still out of date (D2-13) |
| Per-store detail | n/a | Per-item availability on the comparison screen | Sheet: store name, summary "€44,67 · 12 van 12 prijzen · 1 verouderd", lines such as "Melk 1000 ml   2×  €2,38", "9 d oud" in warning colour with a clock, "? Geen prijs" in muted | Honest. **"2× €2,38" is still ambiguous** (D3-02); the summary scrolls away and rows slide under the title (D2-20) |
| Settings / account | Settings menu | Account | One screen: share, name, members, price switch, account actions | Compact. The account block is three stacked coloured text buttons with no group (D2-08 remainder); the switch is 40×20 (D2-07 remainder) |
| Account wall | None for people who receive a list | Account | Web shows only the e-mail code (Apple and Google are not rendered on web) | A higher barrier than Listonic, as accepted in spec risk 4 |

## 4. Round-2 defects: status

| ID | Round-2 defect | Status in round 3 |
|---|---|---|
| D2-01 | Tab labels clipped | **Fixed.** 56 pt bar; labels 13/16 at y=821 (iPhone) and y=892 (Android), fully visible in all variants |
| D2-02 | Orange UA focus ring on "Lid worden" | **Open.** Measured `outline: auto rgb(229,151,0)`, visible in all 4 variants |
| D2-03 | Legal links without link styling, duplicated | **Open.** "Voorwaarden" and "Privacybeleid" are still 17/500 `textMuted` with no underline, under a 13 pt sentence that says the same thing |
| D2-04 | Code step: grey active link; alignment jump | **Partly fixed.** "Ander e-mailadres" is now accent. The title is still centred on step 1 and left-aligned on step 2 |
| D2-05 | Invite-code placeholder looks real | **Fixed.** Placeholder "6 tekens"; label removed; "Doorgaan" disabled. In dark mode the disabled button still looks active (D3-05) |
| D2-06 | "Code vervangen" louder than the code; on the page | **Open.** 17/500 `textMuted` (now reads as disabled) next to "Code: 8TYDFT" at 13/400 |
| D2-07 | Teal switch thumb, 40×20 | **Partly fixed.** The track is now accent. Still a 40×20 `<input role=switch>`, and in dark mode the thumb is dark on the green track (D3-04) |
| D2-08 | Three styles for account actions | **Partly fixed.** Both destructive actions are now `danger`; "Uitloggen" is accent. There is still no divider or "Account" group, so with the member "Verwijderen" there are three red labels on one screen |
| D2-09 | Join names Jan twice | **Partly fixed.** The duplication is gone, but the title kept "‘Thuis’ van Jan", while the spec has "Word je lid van "Thuis"?" + "Uitgenodigd door Jan · 2 leden" |
| D2-10 | "2× €2,38" ambiguous | **Open**, raised to Major (D3-02) |
| D2-11 | Route copy | **Partly fixed.** The subtitle has its "?", and the footer is now "Dit zijn webshopprijzen. In de winkel kan het anders zijn." "12 items · oudste prijs 9 d" is unchanged |
| D2-12 | Heavy empty-state text | **Fixed** for no-data (15 pt muted). The opt-in still runs 4 lines with a widow ("eerlijk.") |
| D2-13 | Spec still says "Nog niet beschikbaar" | **Open** (design-spec lines 19, 283, 461, 528) |
| D2-14 | Dark scrim / sheet edge | **Improved.** Dark sheets now separate visibly from the dimmed list; the snackbar is distinguishable |
| D2-15 | Offline icon reads as "eye-off" | **Open**, raised to Major (D3-01) |
| D2-16 | "1 l" reads as "1 I" | **Open** |
| D2-17 | "kaa" → Kaart, Kaarsen | **Open** |
| D2-18 | Several left edges | **Open** (measured: chevron 24, "Afgevinkt" 44, suggestions 52, rows 56; "Wissen" ends 24 pt from the edge) |
| D2-19 | Overage line repeats the size | **Fixed** ("100 g meer") |
| D2-20 | Summary scrolls away in the store sheet | **Open.** In 23-noord, a half-cut "Kaas jong belegen" row sits under the title with no divider |
| D2-21 | Two-letter initials; header weights | **Partly fixed.** One letter ("J", "S"). "Huishouden" is still semibold, while "Thuis" and "Goedkoopste route" are regular |
| D2-22 | No Apple/Google on web | Open (web limitation) |

## 5. Defect list (round 3)

Severity: **Major** = visibly broken, misleading, or a spec rule broken in a way users hit.
**Minor** = visible polish, consistency or copy problem. **Nit** = taste or cleanup.
"Web-only?" = may not reproduce natively; verify on a device before fixing.

| ID | Sev | Screen | Defect | Evidence | Fix direction |
|---|---|---|---|---|---|
| D3-01 | **Major** | List header (offline) | **The only offline signal is still unreadable** (D-09 → D2-15 → now, three rounds). At 20 px the slashed cloud reads as "eye-off/hidden". At 3× the cloud outline shows its internal arcs (overlapping circles inside the outline), so the glyph looks like a knot. It is also drawn in `textMuted` next to a `text`-coloured people icon, so it looks disabled. Spec 0.6 and 4.3 rely on this icon alone | 12 (all 4), crop of 12 iPhone light | Use a clean single-path `cloud-off` (e.g. Lucide/Material), 22–24 px, in `text` colour, at the same stroke weight as the people icon; check at 1× on a device |
| D3-02 | **Major** | Store sheet (Goedkoopste route) | **"2×  €2,38" reads as 2 × €2,38 = €4,76**, but €2,38 is the line total (2 × €1,19). The same applies to "6× €1,50" and "2× €13,98". In a feature whose whole promise is price honesty, this misleads. The spec (4.5) prescribes this format, so the spec needs the change as well | 18, 19, 21, 23 | "2 × €1,19" in muted with the line total bold on the right, or "2 stuks" in muted under the name. Update spec 4.5 at the same time |
| D3-03 | Minor (web-only?) | Join; also the invite-code input (dark) | The browser's **orange focus ring** is still drawn around "Lid worden" when the sheet opens: the only non-palette colour in the app (D-08 → D2-02, unchanged) | 15 (all 4); measured `outline auto rgb(229,151,0)` | Suppress the UA outline on Pressables; draw an accent focus ring with the control's radius, as on the quick-add bar |
| D3-04 | Minor (web-only?) | Household, price switch | The switch is still **40×20 px** with an `aria-label` but no visible row tap target. In **dark mode the thumb is dark** (≈ `surfaceRaised`) on the green track, so it reads as a hole. Light mode is fine | 22 dark; measured | `thumbColor` = `onAccent`/white in both themes; make the whole 48 pt row toggle it (`accessibilityRole="switch"` on the row) |
| D3-05 | Minor | Invite-code sheet (dark) | **The disabled "Doorgaan" looks active in dark mode**: a mid-green fill with dark text, close to the enabled style. In light mode the pale disabled fill is clear | 03 dark vs light | Disabled = `surface` fill + `textDisabled` label in both themes, or 40% opacity on the accent |
| D3-06 | Minor | Household | **"Code vervangen" looks disabled and is still on the page** (D2-06). It is 17/500 in `textMuted`, the same grey as disabled text, and it is larger than the code it acts on ("Code: 8TYDFT", 13/400). Spec 4.2 puts it **inside the share sheet, owner only**. The code itself, which people read aloud, is the smallest text on the screen | 10 (all 4); measured | Show "Code: 8TYDFT" in `body`; move "Code vervangen" into the share/confirm flow, or at least use accent at 15 pt directly next to the code |
| D3-07 | Minor | Household | **The account block is visually loud and ungrouped.** "Ingelogd als …" is followed by three 17/500 coloured text buttons (green, red, red), each in a 48 pt row, with no divider or heading. With the member "Verwijderen", one screen has **three red labels**: the loudest thing on a settings page whose main action is "Deel lijst" | 09, 10, 22 | A hairline + an "Account" group; "Uitloggen" in `text` (not accent); keep `danger` for the two destructive actions; consider 15 pt for the group |
| D3-08 | Minor | Sign-in | **The legal links are still unstyled duplicates** (D2-03): "Voorwaarden  Privacybeleid" at 17/500 in grey with no underline, directly under a 13 pt sentence that names both. A second link style (accent, 17 pt) follows for "Ik heb een uitnodigingscode", which the spec calls a "kleine tekstlink" | 01; measured | Make the words inside the footnote the links (accent or underlined, 44 pt hit slop) and drop the row; one link style |
| D3-09 | Minor | Sign-in code step | **The alignment jumps**: step 1 is centred ("Goedboodschap"), step 2 is left-aligned ("Typ de code uit je mail"). Both blocks float at 30–40% of the screen height with an empty top | 01 vs 02 | Pick one alignment (left, like the rest of the app) and top-align at ≈ 25% |
| D3-10 | Minor (copy) | Join | The title "**Word je lid van ‘Thuis’ van Jan?**" is clumsy Dutch and differs from spec 4.2 ("Word je lid van "Thuis"?" / "Uitgenodigd door Jan · 3 leden"). The round-2 fix removed the subtitle's inviter instead of the "van Jan" in the title. "van Jan" is useful only because the joiner's own household is also called "Thuis" | 15 | Title "Word je lid van ‘Thuis’?"; subtitle "Jan nodigt je uit · 2 leden" |
| D3-11 | Minor (copy) | Route result | "**12 items · oudste prijs 9 d**": "items" is an anglicism, and "9 d" is not a Dutch abbreviation in running text. It also stacks a second muted 13 pt line under the muted subtitle, so the header is three lines | 17 | "12 producten · oudste prijs 9 dagen oud"; consider dropping the subtitle once results show. Update spec 4.5 |
| D3-12 | Minor (doc) | Spec | D-12 → D2-13 is still open: design-spec lines 19, 283, 461 and 528 say **"Nog niet beschikbaar"**, while the app shows "Geen geverifieerde prijzen beschikbaar" | spec | Owner: design. Update the spec so nobody "fixes" the app back |
| D3-13 | Minor | List / quick-add | **Four left edges in one column** (D2-18): section chevron x=24, "Afgevinkt (3)" x=44, suggestion text x=52, row names x=56; the suggestion "+" sits about 6 pt left of the bar's "+". "Wissen" ends 24 pt from the edge, while the bar and the "Eigenaar" label end at 16 | 05, 06, 07; measured | One text inset (56) for rows, suggestions and section headers; text buttons right-aligned on the 16 pt margin |
| D3-14 | Minor | List rows | "**Yoghurt 1 l**" still reads as "1 I" or "11" in the web font (D-16 → D2-16) | 05 | Check on a device with SF Pro/Roboto; if it is still ambiguous, render "1 L" or "1 liter" |
| D3-15 | Minor | Store sheet | **The sheet header does not stay put** (D2-20): the summary line ("€44,67 · 12 van 12 prijzen · 1 verouderd") scrolls away, and rows slide under the pinned title with no divider, leaving a half-cut row. Rows are also very airy (55–75 pt each for one line of text), so only 9–10 of 12 lines fit on an iPhone, and the sheet uses inset hairlines while every other list uses full-bleed hairlines | 21, 23-noord | Pin the summary with the title, with a hairline under it; 48–52 pt line rows; one hairline style |
| D3-16 | Nit | Suggestions | "kaa" suggests **Kaart** and **Kaarsen** (non-food) and not the household's own "Kaas jong belegen" (D2-17). Spec 3 ranks household history above the catalogue | 07 | Rank household history first, then the food catalogue |
| D3-17 | Nit | Route opt-in | The body is still **4 centred lines with a one-word widow** ("eerlijk."). The "Prijzen vergelijken" button is inset 24 pt while the header text sits at 16 | 16 | Shorter body or `text-wrap: balance`; one horizontal inset |
| D3-18 | Nit | Headers | Header weights differ: "Huishouden" is semibold, while "Thuis" and "Goedkoopste route" are regular 20 pt. Sign-in uses a 24 pt side margin; every other screen uses 16 | 09 vs 05, 14; 01 | One header style; one side margin (spec 2.3: 16) |
| D3-19 | Nit | Route empty states | The route tab's receipt icon is reused as the empty-state illustration on the no-data and opt-in screens, so the screen shows the tab icon twice | 14, 16 | Its own line icon (e.g. a scale or a tag with a question mark), or no icon |
| D3-20 | Nit | Sign-in | Web shows only the e-mail path (no Apple/Google, no "of" divider), so the platform order (iOS: Apple first; Android: Google first) still cannot be checked here | 01 | Device check (section 6) |

### Defect count

2 Major (D3-01, D3-02), 13 Minor (D3-03 … D3-15), 5 Nits (D3-16 … D3-20). No blocker.

**Price rules: nothing seen breaks them.** The no-data state shows no € anywhere. The incomplete basket
(Oost) shows no total even though it would be cheapest. Missing prices show "? Geen prijs" in muted,
never €0. The stale price shows "9 d oud" in `warning` with a clock and counts towards the total.
"Goedkoopste" appears only on the top complete basket. Ranking is per single store only, with no
multi-store route.

**What passed** (spot-checked against the spec): one-line header with 48×48 "Huishouden" and sync
buttons; rows 57 pt with a 48×48 checkbox zone; a 48 pt quick-add bar with a 48×48 clear button;
"Afgevinkt (n)" collapsed by default, with "Wissen" at 76×48; ≤4 suggestions with "+ ‘kaa’ toevoegen
(2)" first; the item detail matches 4.4 (unlabelled name field, "Hoeveelheid", "Notitie", "Toegevoegd
door jou · 21:08", danger "Verwijderen", no "Klaar"); the offline sheet copy matches 4.3 exactly; the
tab bar is 56 pt with readable labels; one-letter initials; the store and route rows match 4.5; amounts
are 17/600; the type and colour tokens match 2.1/2.2 in both themes.

## 6. Must be checked on device (iOS + Android): not covered by this round

No iOS simulator, Android emulator or physical device was available. Everything below is unverified:

- **Tab bar:** 56 pt height plus the iOS home indicator, Android gesture and 3-button navigation, at font
  scale 100/135/200% (the D2-01 fix was only verified on web).
- **Real fonts** (SF Pro / Roboto): "1 l" legibility (D3-14), wrapping of long item and store names,
  tabular euro amounts, the 2-line route title "Geen geverifieerde prijzen beschikbaar".
- **Offline icon** (D3-01) at 1×/2×/3× on real pixel densities.
- **Safe areas:** notch/Dynamic Island, home indicator under bottom sheets, Android edge-to-edge,
  status-bar style and Android navigation-bar colour in dark mode.
- **Focus rendering** (D3-03 may be web-only); VoiceOver/TalkBack labels, focus order and announcement
  of the undo snackbar (spec 7).
- **Native `Switch`** colours, thumb in dark mode and hit area (D3-04); the dark-mode scrim on OLED.
- **Keyboard:** autofocus only on an empty list, Enter keeps focus, scrolling dismisses, sheets lift above
  the keyboard, OTP autofill (`oneTimeCode`, Android autofill).
- **Bottom sheets:** swipe down and tap outside to close, scrolling inside long store sheets with a
  pinned header (D3-15), Android back button.
- **Gestures:** swipe left to delete + undo snackbar, haptics (light on check, medium on delete),
  reduced motion.
- **The 1.5 s "nothing moves under your finger" rule** with real touches, and realtime inserts from a
  second phone.
- **Sharing:** native share sheet for "Deel lijst" (web used the clipboard fallback); universal link /
  App Link `/j/<code>` on cold and warm start, and before sign-in (pending code).
- **Apple and Google sign-in** buttons and their order per platform (D3-20).
- **Offline:** NetInfo detection (airplane mode, captive portal), outbox survival after kill + restart,
  the "Geen internet" first-start state, a locked or full SQLite file.
- **Performance:** cold start ≤ 1.5 s on a mid-range Android; suggestions < 16 ms per keystroke.

## Sources

- Mandje screenshot captions and image URLs (images blocked by the proxy): https://mwm.ai/apps/mandje/6758279445
- Mandje in ID.nl, October 2026: https://id.nl/huis-en-entertainment/mobiel/smartphone-en-tablet/6-apps-voor-oktober-2026-van-boodschappen-vergelijken-tot-zelf-muziek-maken-2
- Listonic feature page (vendor, not independent): https://listonic.com/compare-apps/listonic-vs-samsung-food
- Listonic screenshot mirror (images blocked by the proxy): https://grand-screen.com/apps/shopping-list-listonic/
- Listonic App Store listing: https://apps.apple.com/app/grocery-shopping-list-listonic/id331302745
