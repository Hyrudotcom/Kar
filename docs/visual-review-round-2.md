# Visual review, round 2

Date: 2026-10-23 · Build: `integration/v1` at `3e447cd` ("Fix round 1"), uncommitted tree unchanged
Scope: every v1 screen, light and dark, at 390×844 (iPhone) and 412×915 (Android)
Benchmarks: `design-spec.md` (authoritative for UX), Listonic (simplicity), Mandje (list-comparison layout)
Screenshots: `docs/screenshots/round-2/` (86 PNGs, `NN-screen--device--scheme.png`), also copied to the
shared `screenshots/round-2/` folder.

## 1. How this was run (and what it does NOT prove)

- **Rendering: React Native Web in headless Chromium** (`/opt/pw-browsers/chromium`), not iOS or
  Android. **No simulator or device was run.** Fonts, safe areas, the tab bar height, keyboard,
  bottom-sheet gestures, the share sheet, `Switch`, haptics and focus rendering all differ on device.
  Rows marked "web-only?" may not reproduce natively. Section 6 lists what still has to be checked
  on real hardware.
- **Backend: the real local Supabase stack** (Postgres, GoTrue, PostgREST, Realtime behind the repo's
  Kong stand-in), with the **real sync engine** (expo-sqlite wasm/OPFS). The shipped web export always
  uses the demo backend. For this review, three changes were made **temporarily** and then reverted:
  `createBackend.web.ts` used the native Supabase backend, `metro.config.js` added `.wasm` assets and
  routed `expo-secure-store` to a localStorage shim on web, and the shim lived in `.review-shims/`.
  Nothing was committed.
- **Seed data** (local DB only, created through the real RPCs `create_household`, `create_invite`,
  `accept_invite` and `apply_mutations`): household "Thuis" with owner Jan and member Sanne, 12 items
  (9 open, 3 checked: Brood, Appels, Pindakaas), with notes and g/kg/l units. Extra users: Eva (empty
  list) and Tim (solo household, opens the invite link).
- **Sign-in:** passwords are now disabled server-side, so sessions came from an admin magic link plus
  `verifyOtp` (e-mail code). They were injected into the chunked session storage. The code step was
  reached by stubbing `POST /auth/v1/otp`.
- **Price fixture:** the "Goedkoopste route" data states were rendered by intercepting the price-table
  GETs in Playwright (with a `Content-Range` count, since the repository now pages with exact counts).
  **No price row was written to any database.** The fixture uses fictional chains ("Testwinkel
  Noord/Zuid/Oost") and the source "Screenshotfixture (geen echte prijzen)". Noord and Zuid are
  complete baskets (Noord has one 9-day-old price). Oost is an incomplete basket (10 of 12, missing
  Koffiebonen and Wc-papier) that would be the cheapest if it were ranked. Product names such as
  "Melk 1000 ml" come from the fixture, not from the app.
- **Measurements** (font size, line height, tap-target size, colour, focus style) were read from the
  DOM in the same runs. The numbers are CSS px, equal to pt/dp at these viewports.
- **Benchmark material:** the store screenshots of Listonic and Mandje still **could not be viewed**.
  The image hosts (`is1-ssl.mzstatic.com`, `grand-screen.com`) are blocked by the egress proxy
  (`CONNECT 403`), WebFetch fails on them, and the App Store page only serves placeholder images. The
  comparison uses Mandje's ten screenshot captions (mwm.ai), the ID.nl review, Listonic's own feature
  pages and the App Store description text. **No pixel-level comparison with either app was
  possible.** That is the same limitation as in round 1 and in design-spec 1.4.

## 2. Screens captured

| # | Screen | State |
|---|---|---|
| 01 / 02 / 03 | Sign-in | e-mail form; 6-box code step with resend countdown; "Uitnodigingscode" sheet |
| 04 | Empty list | Eva, autofocus in the bar |
| 05 / 06 | List | 9 open + "Afgevinkt (3)", collapsed and expanded |
| 07 | Quick-add | "2 kaa" with suggestions |
| 08 | Item detail | Melk, sheet |
| 09 / 10 / 11 | Household | before and after "Deel lijst" (web clipboard fallback); 11 equals 10 because the page fits |
| 12 / 13 | Offline | sync icon in the header; explanation sheet |
| 14 | Goedkoopste route | no verified source: "Geen geverifieerde prijzen beschikbaar" |
| 15 | Join | Tim opens `/j/<code>`: "Word je lid van ‘Thuis’ van Jan?" |
| 16–20 | Route fixture | opt-in, ranked result (2 complete + 1 incomplete), complete-store sheet, incomplete-store sheet, ⓘ sheet |
| 21 / 22 (light only) | Extra | store sheets scrolled to the end (stale marker, "Geen prijs"); Household with the price switch |

All 86 screenshots were viewed (full size for iPhone light, as side-by-side contact sheets of all
four variants for each screen, and full-size crops where detail mattered). The run logged no page or
console errors.

## 3. Side-by-side comparison

| Aspect | Listonic | Mandje | Goedboodschap (observed, round 2) | Verdict |
|---|---|---|---|---|
| First screen | The list, with automatic categories and a running total. Ads on the free tier "until you buy premium" | Promo-first home ("All supermarket deals") with supermarket logos | The list: one-line header "Thuis" + people icon, quick-add bar, rows. No promos, no logos, no totals | Calmer than both. Still the strongest part of the app |
| Navigation chrome | Bottom bar plus menus; ad slots | Several tabs (deals, list, favourites, cards, search) | Two tabs. **The tab labels are clipped to their top half on every screen** (D2-01) | Right concept; it currently looks broken |
| Adding an item | "Fast entry" with predictive suggestions | "Type list, get prices" notepad | Type + Enter, or tap one of ≤4 suggestions. Focus ring now follows the 12 pt bar (round-1 D-07 fixed) | Matches Listonic's speed. Suggestions still offer non-food first (D2-17) and misalign with the bar text (D2-18) |
| Row anatomy | Checkbox, name, quantity/unit, note; optional price and category colour | Product row with price per store | Round 24 pt checkbox, 17 pt name, 15 pt muted quantity, 13 pt note, full-bleed hairlines, 57 pt rows | Calmest of the three; matches spec 3. "1 l" still reads as "1 I" (D2-16) |
| Visual noise | Low in the core, high with ads/upsell | High (deals, alerts, cards, categories, filters) | Very low on the list. Higher than needed on sign-in (two link styles plus duplicated legal text), Household (red, green and grey text buttons, a louder "Code vervangen" than the code) and route empty states (17 pt centred paragraphs) | Meets principle 0.7 on the main screen; the secondary screens need a tidy pass |
| Typography | — | — | Clear 4-step scale (20/17/15/13). Hierarchy inversions: "Code vervangen" 17/500 next to the code at 13/400; legal links 17/500 under 13 pt legal text; empty-state body text at 17 pt over three or four centred lines | Good tokens, uneven use |
| Sharing | Link, no account needed | Account, max 4 people | "Deel lijst" primary button; afterwards "Code: M4YF99" and "Code vervangen" on the page; web shows "Uitnodiging gekopieerd" | Simple, but "Code vervangen" is still on the page instead of in the share sheet (D2-06) |
| Joining | Open link | Account | Sheet "Word je lid van ‘Thuis’ van Jan?" + "Uitgenodigd door Jan · 2 leden" + one button | One tap, as in the spec. Names Jan twice; orange focus ring (D2-02, D2-09) |
| Offline | Sync complaints in reviews | Unknown | Header cloud-off icon only; tap opens a one-sentence sheet | Matches the spec. The icon still reads as "eye-off" at 20 px (D2-15) |
| Price comparison | Own price field and list total, user-entered | Central: "List cost per supermarket" with availability per item; supermarket filter; loyalty cards | Separate opt-in tab. Flat store rows: name left, bold total right, "Goedkoopste · 1 verouderd", "+€3,13"; incomplete stores under "Onvolledig" with "10 van 12 prijzen" and **no amount**, even though Oost would be cheapest | Adopts Mandje's one useful idea (total per store + coverage) without the clutter, and is more honest about partial baskets |
| No-data honesty | n/a | n/a (leaflet data) | "Geen geverifieerde prijzen beschikbaar" + "We laten liever niets zien dan een verkeerde vergelijking." No button, no toggle, no € anywhere | Correct and calm. The spec still says "Nog niet beschikbaar" (D2-13) |
| Per-store detail | n/a | Per-item availability on the comparison screen | Sheet: name, summary "€44,67 · 12 van 12 prijzen · 1 verouderd" / "Onvolledig · 10 van 12 prijzen", lines "Melk 1000 ml   2×  €2,38", "9 d oud" in warning with a clock, "? Geen prijs" muted | Good and honest (round-1 D-14 fixed). "2× €2,38" is ambiguous (D2-10); the summary scrolls away (D2-20) |
| Settings / account | Settings menu | Account | One screen: share, name ("Naam" label now present), members, price switch (only when prices exist), account actions | Compact. Off-palette teal switch thumb and a small switch target (D2-07); "Account verwijderen" looks disabled (D2-08) |
| Account wall | None for receivers | Account | E-mail code only on web (Apple/Google are not rendered on web) | Higher barrier than Listonic, as accepted in spec risk 4 |

## 4. Round-1 defects: status

| ID | Round-1 defect | Status in round 2 |
|---|---|---|
| D-01 | DB open failure shown as "Geen internet" | Not re-tested visually (fixed in code per `3e447cd`; no screen state reached) |
| D-02 | Terms/privacy not reachable | **Partly fixed**: "Voorwaarden" and "Privacybeleid" exist (48 pt targets), but they have no link styling. See D2-03 |
| D-03 | "Code vervangen" always visible, no confirmation | **Partly fixed**: hidden until a code exists, muted, behind a confirm. Still on the page, not in the share sheet (D2-06) |
| D-04 | Tab labels 10 px | **Regressed**: now 13/18, but clipped (D2-01) |
| D-05 / D-06 | Header jump between tabs; ⓘ on the subtitle line | Fixed: same y and weight on both tabs; ⓘ on the title line |
| D-07 | Square focus outline on the quick-add input | Fixed: rounded accent border on the bar |
| D-08 | Orange focus ring on "Lid worden" | **Not fixed** (D2-02) |
| D-09 | Offline icon reads as "eye-off" | **Not fixed** (D2-15) |
| D-10 | Snackbar covers the list after Household | Not re-tested (capture waited for the snackbar to expire) |
| D-11 | Straight quotes, ambiguous "Thuis" | Fixed (‘Thuis’ van Jan); new redundancy (D2-09) |
| D-12 | Spec says "Nog niet beschikbaar" | **Open**: design-spec 0, 4.5, F31 and risk 1 still say it (D2-13) |
| D-13 | Three red actions; unlabelled name field | Partly fixed: "Naam" label added, "Uitloggen" accent, "Account verwijderen" muted. See D2-08 |
| D-14 | Store sheet header without total/coverage | Fixed (summary line under the store name) |
| D-15 | Opt-in and no-data states use different layouts | Fixed: both use `EmptyState`; opt-in names the source |
| D-16 | "1 l" reads as "1 I" | **Open** (D2-16) |
| D-17 | "kaa" suggests Kaart, Kaarsen | **Open** (D2-17) |
| D-18 | Sign-in block low; no Apple/Google on web | Open (web limitation; layout unchanged) |
| D-19 | Countdown in `textDisabled` | Fixed (`textMuted`) |
| D-20 | Double parentheses in the ⓘ sheet | Fixed ("via <bron>") |
| D-21 | Cold-loading `/route` lands on the list | Not re-tested |

## 5. Defect list (round 2)

Severity: **Major** = visibly broken, misleading, or a spec rule broken in a way users hit.
**Minor** = visible polish, consistency or copy problem. **Nit** = taste/cleanup.
"Web-only?" = may not reproduce natively; verify on a device before fixing.

| ID | Sev | Screen | Defect | Evidence | Fix direction |
|---|---|---|---|---|---|
| D2-01 | **Major** | Tab bar (every tab screen, all 4 variants) | **Tab labels are cut in half.** "Mijn lijst" / "Goedkoopste route" render at 13/18 inside a 48 pt bar under a 24 pt icon. Only the top 10 px of the label box is visible (iPhone label y=829 h=10 in an 844 viewport; Android y=900 h=10 in 915). This is the only navigation, and it now looks broken. It is caused by the D-04 fix (`tabBarLabelStyle: typography.footnote`, `_layout.tsx`): the larger line height was not given room. | 04–07, 12, 14, 16, 17; measured | Give the bar its own height (icon 24 + gap 4 + 18 line + padding, ≈ 56 + bottom inset), or use `lineHeight: 16` and `tabBarLabelPosition` defaults. Verify with a home indicator (iOS), 3-button and gesture nav (Android) and font scale 135%/200% |
| D2-02 | Minor (web-only?) | Join; invite-code sheet (dark) | The browser's default **orange focus ring** (`outline: auto rgb(229,151,0)`) is still drawn around "Lid worden" when the sheet opens: the only non-palette colour in the app (round-1 D-08, unchanged). In dark mode the invite-code input gets a **double ring**: a white browser outline outside the accent border. | 15 (all 4), 03 dark; measured | Same focus treatment as the quick-add bar: suppress the UA outline, draw an accent ring with the control's radius |
| D2-03 | Minor | Sign-in | Legal links have **no link affordance**: "Voorwaarden  Privacybeleid" are 17/500 in `textMuted`, with no underline and no accent, so they read as two grey labels. They are also **bigger than the 13 pt sentence they belong to**, and they repeat it ("…akkoord met de voorwaarden en het privacybeleid." then "Voorwaarden Privacybeleid"). Meanwhile "Ik heb een uitnodigingscode" is 17 pt accent: a second link style on the same screen, and the spec calls it a "kleine tekstlink". | 01; measured | Make "voorwaarden" and "privacybeleid" inside the footnote sentence the links (accent or underlined, ≥44 pt hit slop) and drop the separate row. One link style for the screen |
| D2-04 | Minor | Sign-in, code step | "Ander e-mailadres" (17/500) uses the **same muted grey as the disabled countdown** "Opnieuw sturen (30 s)", so the one active action on the screen looks disabled. The title also jumps from **centred** (step 1) to **left-aligned** (step 2), and the block sits at about 40% screen height with an empty top half. | 02; measured | Accent for active text buttons; one alignment for both steps; top-align the block (~25%) |
| D2-05 | Minor | Invite-code sheet | The placeholder **"K7QM4Z" looks like a real, prefilled code** (same size as typed text, only slightly muted). The "Code" label repeats the sheet title "Uitnodigingscode". "Doorgaan" is a full-colour primary button while the field is empty. | 03 | Placeholder "6 tekens" (or none); drop the label; disable "Doorgaan" until 6 characters are typed |
| D2-06 | Minor | Household | **"Code vervangen" (17/500) is louder than the code it acts on** ("Code: M4YF99", 13/400), sits directly under the only primary button, and is **still on the page**. Spec 4.2 / C15 puts it **inside the share sheet, owner only**. The code line and the action are not visually connected (the code is far left, the action far right). | 10; measured | Show the code as body text, and move "Code vervangen" into the share/confirm flow, or at least make it 13/15 pt and keep it next to the code |
| D2-07 | Minor (web-only?) | Household (prices available) | The "Prijsvergelijking tonen" **switch thumb is teal** (the RN-Web default thumb colour), not the accent: an off-palette colour. The switch measures **40×20 px**, and the row label is not part of the tap target. | 22; measured | Set `thumbColor`/`trackColor` from tokens; make the whole 48 pt row toggle the switch (`accessibilityRole="switch"`) |
| D2-08 | Minor | Household | The account actions use three styles: "Uitloggen" in **accent green**, "Huishouden verlaten" in **red**, and "Account verwijderen" in **muted grey, which reads as disabled**. Spec 4.6 has "danger-text" for both destructive actions. "Ingelogd als …" plus the three actions float with no divider or section heading. | 09–11 | One "Account" group under a divider; "Uitloggen" as plain body text; both destructive actions in `danger` (only on the confirm, if quieter is wanted), never in the disabled grey |
| D2-09 | Minor (copy) | Join | **Jan is named twice**: "Word je lid van ‘Thuis’ van Jan?" and "Uitgenodigd door Jan · 2 leden". "‘Thuis’ van Jan" is also clumsy Dutch. | 15 | Title "Word je lid van ‘Thuis’?" with the subtitle "Jan nodigt je uit · 2 leden" (the spec form) |
| D2-10 | Minor (copy) | Store sheet | **"2×  €2,38" is ambiguous**: it reads as "2 times €2,38" (= €4,76), but €2,38 is the line total (2 × €1,19). The same applies to "6× €1,50" and "2× €13,98". This is the spec's own format (4.5), so the spec needs the change too. | 18, 19, 21 | "2 × €1,19" muted with the line total bold, or keep the total and show the count as "2 stuks" |
| D2-11 | Minor (copy) | Route result | Copy is terse and partly not Dutch: "12 items · oudste prijs **9 d**" ("items" is an anglicism, "d" is not a Dutch abbreviation in running text); the footer "**Webshopprijzen, kunnen in de winkel afwijken.**" is a comma splice; the subtitle "Welke winkel is voor je hele lijst het goedkoopst" is a question without a question mark. All of this comes verbatim from the spec. | 17 | "12 producten · oudste prijs 9 dagen oud"; "Dit zijn webshopprijzen. In de winkel kan het anders zijn."; add "?" to the subtitle. Update spec 4.5 at the same time |
| D2-12 | Minor | Route empty states | The no-data and opt-in states use **17 pt centred body text over 3–4 lines**, with a one-word widow ("eerlijk."). They are the heaviest text blocks in the app, while the spec calls them "één zin". The opt-in has three sentences. The tab icon (a receipt) is reused as the empty-state icon. | 14, 16 | Body in `callout` 15 muted, max-width ~300, left or balanced wrap; trim the opt-in to two sentences; its own line icon |
| D2-13 | Minor (doc) | Route / spec | Round-1 D-12 is still open: design-spec 0, 4.5, F31 and risk 1 still say **"Nog niet beschikbaar"**, while the app, contracts and e2e use "Geen geverifieerde prijzen beschikbaar". | spec lines 20, 284, 529, 462 | Update the spec (owner: design) so nobody "fixes" the app back |
| D2-14 | Minor (web-only?) | Dark mode, all sheets | **The dark scrim barely dims the background**: in dark mode the item-detail, join and offline sheets (`surfaceRaised` #1F2321) are hard to tell from the dimmed list. The sheet edge is nearly invisible, and the dark snackbar (#181B19-ish on #0F1110) also blends in. | 08, 13, 15, 10 (dark) | Darker scrim in dark mode (≈ 60% black) and/or a 1 px `border` hairline on the sheet top; raise the snackbar surface in dark mode |
| D2-15 | Minor | List header (offline) | Round-1 D-09 is unchanged: the 20 px cloud with a slash still reads as "eye-off/hidden". It is the only offline signal (spec 4.3). | 12 | Heavier, larger cloud glyph; check at 1× on a device |
| D2-16 | Minor | List rows | Round-1 D-16 is unchanged: "Yoghurt **1 l**" reads as "1 I" or "11". | 05 | Check on device; if ambiguous, show "1 liter" or "1 L" in the row |
| D2-17 | Nit | Suggestions | Round-1 D-17 is unchanged: "kaa" suggests **Kaart** and **Kaarsen** (non-grocery) after "Kaas"; the household's own "Kaas jong belegen" is not offered. | 07 | Weight household history and food above non-food |
| D2-18 | Nit | List / quick-add | **Three different left text edges** in one column: bar text x≈59, suggestion text x=52 (its "+" at 34 vs the bar's "+" at 40), row names x≈56, "Afgevinkt (3)" x=44. "Wissen" ends 8 pt inside the 16 pt margin that the amounts and "Eigenaar" use. | 05, 07; measured | One text inset (56) for rows, suggestions and section headers; right-align text buttons on the 16 pt margin |
| D2-19 | Nit | Store sheet | The overage line repeats the product name: "Spinazie **400 g**" / "**400 g**, 100 g meer". With 1× the first half adds nothing. | 18, 19 | Show only "100 g meer" when n = 1 |
| D2-20 | Nit | Store sheet (scrolled) | The title stays fixed, but the **summary line scrolls away**, and rows slide under the title with no divider, leaving half-cut rows visible under it. | 21 | Pin the summary with the title, add a hairline under the pinned header |
| D2-21 | Nit | Household | Initials from a single first name ("**JA**", "**SA**") read like abbreviations. The header "Huishouden" is semibold while the tab headers are regular. | 09 | One letter ("J") when there is no surname; one header weight |
| D2-22 | Nit | Sign-in | Web shows only the e-mail path (no Apple/Google, no "of" divider), so the platform order (iOS: Apple first; Android: Google first) still cannot be checked here. | 01 | Device check (section 6) |

### Defect count

1 Major (D2-01), 15 Minor (D2-02 … D2-16), 6 Nits (D2-17 … D2-22). No blocker. Nothing seen breaks
the price rules: no € in the no-data state, the incomplete basket shows no total although it would be
cheapest, "Geen prijs" is muted with "?" (never €0), the stale price shows "9 d oud" in `warning` with a
clock, and "Goedkoopste" sits only on the top complete basket.

What passed (spot-checked against the spec): one-line header with 48×48 "Huishouden" and sync buttons;
rows 57 pt with a 48×48 checkbox zone; quick-add 48 pt with a 48×48 clear button; "Afgevinkt (n)"
collapsed by default with "Wissen" (76×48); ≤4 suggestions with "+ ‘kaa’ toevoegen (2)" first;
the item detail matches 4.4 (no "Klaar"); the offline sheet copy matches 4.3 exactly; route header,
ⓘ placement and store rows match 4.5; amounts are 17/600; type and colour tokens match 2.1/2.2 in
both themes (primary and muted text, accent buttons and danger text all pass AA by the token values).

## 6. Must be checked on device (iOS + Android): not covered by this round

- **Tab bar** (D2-01): label clipping with the iOS home indicator, Android gesture and 3-button nav,
  and at font scale 100/135/200%.
- Real fonts (SF Pro / Roboto): truncation and wrapping of long names, "1 l" legibility, tabular euro amounts.
- Safe areas: notch/Dynamic Island, home indicator under the tab bar and bottom sheets, Android edge-to-edge.
- Focus and selection rendering (D2-02 may be web-only); VoiceOver/TalkBack labels and focus order (spec 7).
- Native `Switch` colours and hit area (D2-07); dark-mode scrim and sheet edge on OLED (D2-14).
- Keyboard: autofocus only on an empty list, Enter keeps focus, scroll dismisses, sheets lift above the keyboard.
- Bottom sheets: swipe-down and tap-outside to close, scrolling inside long store sheets, Android back button.
- Swipe-left to delete + undo snackbar, haptics (light on check, medium on delete), reduced motion.
- The 1.5 s "nothing moves under your finger" rule with real touches, and realtime inserts from a second phone.
- Native share sheet for "Deel lijst" (web used the clipboard fallback); universal link / app link `/j/<code>`, cold and warm start.
- Apple and Google sign-in buttons and their order per platform; OTP autofill (`oneTimeCode`, Android SMS-less autofill).
- Offline detection via NetInfo (airplane mode, captive portal), outbox survival after kill + restart, the "Geen internet" first-start state, and D-01 (locked or full SQLite file).
- Status bar style and Android navigation-bar colour in dark mode.
- Cold start ≤ 1.5 s on a mid-range Android.

## Sources

- Mandje screenshot captions: https://mwm.ai/apps/mandje/6758279445
- Mandje in ID.nl, October 2026: https://id.nl/huis-en-entertainment/mobiel/smartphone-en-tablet/6-apps-voor-oktober-2026-van-boodschappen-vergelijken-tot-zelf-muziek-maken-2
- Listonic feature page (vendor, not independent): https://listonic.com/compare-apps/listonic-vs-samsung-food
- Listonic App Store description (screenshots are placeholders): https://apps.apple.com/np/app/shopping-list-listonic/id331302745
- Listonic screenshot mirror (images blocked by the proxy): https://grand-screen.com/apps/shopping-list-listonic/
