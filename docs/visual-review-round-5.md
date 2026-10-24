# Visual review, round 5

Date: 2026-10-23 · Build: `ad3116f` ("Fix round 4"). The working tree is clean apart from untracked docs.
Scope: every v1 screen, light and dark, at 390×844 (iPhone) and 412×915 (Android)
Benchmarks: `design-spec.md` (authoritative for UX), Listonic (simplicity), Mandje (list-comparison layout)
Screenshots: `docs/screenshots/round-5/`. There are 95 PNGs:

- 92 screen captures: 23 screens × 2 devices × 2 schemes, named `NN-screen--device--scheme.png`.
- 3 detail crops: `crop-join-dark`, `crop-offline-zoom` and `crop-store-sheet-top`.

All of them are also copied to the shared folder `screenshots/round-5/`.

## 1. How this was run (and what it does NOT prove)

- **Rendering: React Native Web in headless Chromium** (`/opt/pw-browsers/chromium`, Playwright).
  - This is not iOS or Android. **No iOS simulator, Android emulator or physical device was run.**
    None is available in this environment.
  - The font is the browser's `-apple-system` fallback, not SF Pro or Roboto.
  - Safe areas, tab-bar insets, the keyboard, sheet gestures, the native share sheet, the native
    `Switch`, haptics, focus rendering and screen readers all behave differently on a device.
  - Defects marked "web-only?" may not occur natively. Section 7 lists what still has to be checked on
    real hardware.
- **Backend: the real local Supabase stack.**
  - The Docker daemon was started, then `npx supabase start` and `supabase db reset`, which applied all
    nine migrations including `round4_fixes`.
  - The app used the **real sync engine** (expo-sqlite wasm).
  - The web export normally uses the in-memory demo backend, so three changes were made **temporarily**
    for the export:
    1. `createBackend.web.ts` returned the Supabase backend.
    2. A temporary `metro.config.js` added `.wasm` as an asset and routed `expo-secure-store` to a
       localStorage shim.
    3. The shim itself lived in `.review-shims/`.
  - The export went to the scratchpad, not to `dist/`. All three changes were reverted right after the
    export, before any capture. Nothing was committed.
  - The stack was stopped at the end (`supabase stop`).
- **Seed data** (local DB only), created through the real RPCs `create_household`, `create_invite`,
  `accept_invite` and `apply_mutations`:
  - Household "Thuis": owner Jan, member Sanne.
  - 12 items: 9 open and 3 checked (Brood, Appels, Pindakaas), with notes and g/kg/l units.
  - Eva has an empty list.
  - Tim is alone in his own household ("Thuis"). He opens the invite link `/j/<code>`.
- **Sign-in:** each session came from an admin magic link followed by `verifyOtp` (the e-mail code). It
  was injected into the chunked session storage. `POST /auth/v1/otp` was stubbed to reach the code step.
- **Price fixture:** the "Goedkoopste route" data states were rendered by intercepting the price-table
  GETs in Playwright. **No price row was written to any database.**
  - The fictional chains are "Testwinkel Noord", "Testwinkel Zuid" and "Testwinkel Oost". The source is
    "Screenshotfixture (geen echte prijzen)".
  - Noord and Zuid are **complete** baskets. Noord has one price that is 9 days old.
  - Oost is **incomplete**: 10 of 12 prices, with Koffiebonen and Wc-papier missing. If it were ranked,
    Oost would be the cheapest.
  - The no-data state (screen 14) used the real, empty price tables.
- **Measurements** (font size, line height, colour, tap-target size, focus style, nested roles) were
  read from the DOM in a separate iPhone pass. The numbers are CSS px, which equal pt/dp at these
  viewports. The Android measurement pass stopped early on a script issue (opt-in already set), so the
  measurements are iPhone only. The Android layout is the same flex layout, only wider.
- **The capture runs logged no page errors and no console errors.**
- **Benchmark material:** I **still could not view the Listonic or Mandje store screenshots.**
  - `curl` to `is1-ssl.mzstatic.com` returns `CONNECT tunnel failed, response 403`. WebFetch on the
    image URL returns a server error.
  - The Apple listing page for Listonic only returns a placeholder image.
  - The comparison therefore relies on text sources:
    - Mandje's ten screenshot captions, which mwm.ai lists with their image URLs.
    - The ID.nl review.
    - Listonic's App Store feature text and reviews, and its own product page.
  - **A pixel-level comparison with either app was not possible.** This is the same limitation as in
    rounds 1–4 and design-spec 1.4.

## 2. Screens captured (all viewed)

| # | Screen | State |
|---|---|---|
| 01 / 02 / 03 | Sign-in | E-mail form; 6-box code step with countdown; "Uitnodigingscode" sheet |
| 04 | Empty list | Eva, autofocus in the bar |
| 05 / 06 | List with items | 9 open + "Afgevinkt (3)", collapsed and expanded |
| 07 | Quick-add | "2 kaa" with suggestions |
| 08 | Item detail | Melk, bottom sheet |
| 09 / 10 / 11 | Household / invite | Before and after "Deel lijst" (web clipboard fallback + snackbar); 11 = 10 (the page fits) |
| 12 / 13 | Offline | Sync icon in the header; explanation sheet |
| 14 | Goedkoopste route, **no verified source** | "Geen geverifieerde prijzen beschikbaar" |
| 15 | Join | Tim opens `/j/<code>` |
| 16 / 17 | Route fixture | Opt-in; ranked result (2 complete baskets, 1 incomplete) |
| 18 / 23 | Route fixture, **complete basket** | Noord sheet, top and scrolled |
| 19 / 21 | Route fixture, **incomplete basket** | Oost sheet, top and scrolled (all 12 lines fit) |
| 20 | Route fixture | ⓘ sheet "Hoe we vergelijken" |
| 22 | Household | With the price switch (opt-in on) |

How I looked at them:

- Every iPhone light screenshot at full size.
- iPhone dark, Android light and Android dark as 6-up contact sheets. All four Android sheets of both
  schemes were opened.
- Full-resolution crops where detail mattered: the join button in dark mode, the offline icon at 2×,
  and the top edge of the store sheet.

**Android matches iPhone in every screen** apart from one difference: the store sheet's top edge sits
at a different height (D5-08). I found no defect that appears on only one device.

## 3. Side-by-side comparison

| Aspect | Listonic | Mandje | Goedboodschap (observed, round 5) | Verdict |
|---|---|---|---|---|
| First screen | The list, with category/aisle grouping and sort options; per-item price fields; ads on the free tier | Promo-first: "All supermarket deals", supermarket logos, featured offers | The list: a one-line header "Thuis" + people icon, the quick-add bar and the rows. No promos, logos or totals | Still the calmest of the three |
| Navigation chrome | Bottom bar plus menus, list switcher, ad slots | ~10 destinations (deals, list, favourites, loyalty cards, search, categories, store picker) | Two tabs in a 56 pt bar, 13/500 labels. The route tab icon is still a generic document | Right concept. The route icon does not say "compare" |
| Adding an item | Auto-complete, popular products, history ("what you buy most first") | "Type list, get prices" notepad | Type + Enter, or tap one of ≤4 suggestions. "kaa" still offers **Kaart** and **Kaarsen** | As few taps as Listonic. Ranking is still worse than Listonic's history-first list |
| Row anatomy | Checkbox, name, quantity/unit, note; optional price and category | Product row with a price per store | 24 pt round checkbox (48 zone), 17 name, 15 muted quantity, 13 note, full-bleed hairlines, 57 pt rows | The cleanest row of the three. "1 l" still reads as "1 I" |
| Alignment | – | – | Row text, suggestions and "Afgevinkt" at x=56. The bar, "Wissen" and the amounts end at the 16 pt margin. Empty states and the route opt-in/no-data block are **centred**, while everything else is left-aligned | Main screens pass. Empty states break the left axis |
| Visual noise | Low in the core; high with ads, upsells and categories | High: deals, alerts, loyalty cards, categories, price per kilo | Very low on the list and the route. Household still has **three red labels**. The header mixes a **filled grey** offline glyph with a **black outline** people icon | Meets principle 0.7 on the main screens |
| Typography | – | – | The 20/17/15/13 scale is used consistently. Household text actions are now one weight (15/400) and "Ingelogd als" is 13. Remaining inversion: the centred 20/600 content title outweighs the 17/400 screen header on route no-data, opt-in and the empty list | Good tokens, nearly consistent use |
| Sharing | Link/e-mail sharing, real-time | Account, max. 4 people | "Deel lijst" is the primary button. Afterwards the page shows "Code: SVWH3B" and an accent "Code vervangen". The snackbar reads "Uitnodiging gekopieerd" | Clear, but "Code vervangen" is still on the page (spec 4.2) |
| Joining | Open the link | Account | Sheet: "Word je lid van ‘Thuis’?" / "Uitgenodigd door Jan · 2 leden" / one button. Matches spec 4.2 | Good. Dark mode still shows a **white ring** around the button |
| Offline | Users report sync failures | Unknown | A cloud-off icon in the header (now `textMuted` grey, still solid). A tap opens a one-sentence sheet with the exact spec copy | Honest and quiet. The glyph style still does not match the icon set |
| Price comparison | User-entered prices and a list total | Central: "List cost per supermarket", with per-item availability and a supermarket picker | Separate opt-in tab with flat rows: name left, bold total right. "Goedkoopste · 1 verouderd", "+€3,13". Under "Onvolledig", Oost shows "10 van 12 prijzen" and **no amount** | Takes Mandje's one useful idea without the clutter. More honest than either app |
| No-data honesty | n/a | n/a (leaflet data) | "Geen geverifieerde prijzen beschikbaar" + one muted paragraph. No icon, button, toggle or € | Correct and calm. The spec text is still out of date |
| Per-store detail | n/a | Per-item availability on the comparison screen | Pinned title + summary ("€44,67 · 12 van 12 prijzen · 1 verouderd"). The lines show "2 stuks €2,38", "100 g meer", "9 dagen oud" (warning + clock) and "? Geen prijs" (muted) | Reads well. Missing lines do not say what was asked for |
| Settings / account | Settings menu | Account | One screen: share, name, members, the price switch (only after opt-in) and the "Account" group with 48 pt rows | Compact. Calmer than round 4 |
| Account wall | None for people who receive a list | Account | Web shows only the e-mail code; Apple and Google are not rendered on web | A higher barrier than Listonic, as accepted in spec risk 4 |

## 4. Round-4 defects: status

| ID | Round-4 defect | Status in round 5 |
|---|---|---|
| D4-01 | Double rule under the members | **Fixed.** There is no hairline after the last member and one divider above "Account". With opt-in, the price row sits about 24–32 pt from each neighbour |
| D4-02 | Legal links are 16 pt tap targets | **Open.** Measured 81×16 and 83×16 (D5-01) |
| D4-03 | Spec says "Nog niet beschikbaar" and "2×" | **Open.** Spec lines 19, 283, 461 and 528 say "Nog niet beschikbaar"; lines 316–317 and 545 say "2×". Open for four rounds (D5-02) |
| D4-04 | Solid black offline glyph | **Partly fixed.** It is now `textMuted` grey, so it is no longer the heaviest mark. It is still a **filled** shape next to an outline icon, and the two header icons now differ in colour (D5-05) |
| D4-05 | White inner focus ring (`outline: auto`) | **Open.** Still `outline: auto rgb(30,122,76) 1px`. The white ring is clearly visible on "Lid worden" in dark mode (D5-03, `crop-join-dark`) |
| D4-06 | "Code vervangen" on the page | **Open** (D5-04). It is now 15/400 |
| D4-07 | Three red labels and mixed weights | **Partly fixed.** One weight (15/400) and 48 pt rows; "Ingelogd als" is 13. **Three red labels remain** (D5-06) |
| D4-08 | Centred 20/600 title under a 17/400 header | **Open** (D5-07) |
| D4-09 | Three-line route header | **Open** (D5-10) |
| D4-10 | Nested unlabelled `role=switch` | **Open.** Still a 358×48 labelled DIV switch containing a 40×20 INPUT switch with no label (D5-11) |
| D4-11 | "1 l" reads as "1 I" | **Open** (D5-12) |
| D4-12 | "kaa" → Kaart, Kaarsen | **Open** (D5-13) |
| D4-13 | Opt-in widow and extra sentence | **Open.** Still 4 centred lines ending in "eerlijk." (D5-14) |
| D4-14 | Tab icon reused on the empty list | **Fixed** (no icon). The spec's `EmptyState` still says "Lijnicoon", so the spec must follow (part of D5-02) |
| D4-15 | "(2)" reads like a count | **Open** (D5-15) |
| D4-16 | ⓘ sheet: 9 lines at 17 pt, "item" | **Open** (D5-16) |
| D4-17 | Three hairline styles; missing lines lack the requested amount | **Open** (D5-17) |
| D4-18 | Generic route icon; people icon clipped | **Open.** At 2× the people glyph's shoulders are visibly cut flat at the bottom (`crop-offline-zoom`) (D5-18) |
| D4-19 | No Apple/Google on web | Open (web limitation; device check) (D5-19) |

**Summary: 2 fixed, 2 partly fixed, 15 open** (one of the open ones, D4-19, is a web limitation).
Round 4 fixed many backend and flow defects ("list order, auth, membership, prices and undo"), but
most visual Minors were not addressed.

## 5. Defect list (round 5)

Severity:

- **Major:** visibly broken, misleading, or a spec rule broken in a way users hit.
- **Minor:** a visible polish, consistency, accessibility or copy problem.
- **Nit:** taste or cleanup.

"Web-only?" means the defect may not reproduce natively; verify it on a device before fixing.

| ID | Sev | Screen | Defect | Evidence | Fix direction |
|---|---|---|---|---|---|
| D5-01 | Minor | Sign-in | **The legal links are 16 pt tall tap targets** ("voorwaarden" 81×16, "privacybeleid" 83×16). Spec 2.3 asks for at least 44×44. This is the third round in a row | 01; measured | `hitSlop` to ≥44 pt, or put the links on their own 44 pt line |
| D5-02 | Minor (doc) | Spec | **design-spec is still stale.** It says "Nog niet beschikbaar" (lines 19, 283, 461, 528), while the app shows "Geen geverifieerde prijzen beschikbaar". 4.5 and P9 still show "2×", while the app shows "2 stuks". `EmptyState` still says "Lijnicoon", while the app dropped the icon (D4-14). The next "fix to spec" will revert good work | spec | Owner: design. Update §0 line 19, 4.5, §3 `EmptyState`, F31 and P9 |
| D5-03 | Minor (web-only?) | Join; invite-code input | **The white focus ring is still there.** Chromium draws `outline: auto` as an accent ring with a white inner ring, so "Lid worden" gets a bright white border on the dark sheet. The ring also appears on programmatic autofocus | 15 dark (both devices), `crop-join-dark`; measured | `outline: 2px solid accent; outline-offset: 2px`, only on `:focus-visible` |
| D5-04 | Minor | Household | **"Code vervangen" is still on the page.** Spec 4.2 says it is owner-only and lives in the share sheet. Next to "Code: SVWH3B" it invites a destructive tap on the screen people open to share | 10 | Move it into the share/confirm flow. Keep only "Code: …" on the page, and make it tappable to copy |
| D5-05 | Minor | List header (offline) | **The header icons do not match.** The offline glyph is a *filled* cloud in `textMuted` with a cut-out slash. The people icon is a 1.5 px *outline* in `text`. At 1× the slash reads as a white gap in a grey blob. Spec principle 6 asks for a quiet, clear state | 12, `crop-offline-zoom` | Outline `cloud-off` at the same stroke width and colour as the people icon |
| D5-06 | Minor | Household | **Three red labels on one screen**: the member "Verwijderen", "Huishouden verlaten" and "Account verwijderen". The two account actions are stacked red lines directly under "Uitloggen", so the most dangerous actions are the most colourful thing below the fold | 09, 10, 22 | Keep `danger` for the confirm dialog only, and use `text` for the labels. Or keep red only on "Account verwijderen" |
| D5-07 | Minor | Route no-data, route opt-in, empty list | **The hierarchy is inverted and the alignment changes.** The screen header is 17/400 and left-aligned. The content title below it is 20/600, centred, and on the route wraps to two lines ("Geen geverifieerde prijzen / beschikbaar"). The page's loudest text is its least actionable, and these are the only centred blocks in the app | 04, 14, 16 | Left-align the block on the 16 pt margin (as on sign-in and the join sheet), or drop the 20/600 title to 17/600 |
| D5-08 | Minor | Store sheet (iPhone) | **New: the store sheet's top edge slices through the page header.** On iPhone the complete-basket sheet (Noord) starts at about y=66 pt, which cuts the meta line "12 producten · oudste prijs 9 dagen oud" in half. A half-line of text shows above the sheet. The Oost sheet sits about 14 pt lower, so the sheet height jumps between stores. On Android both sheets start below the first store row | 18 vs 19 (iPhone, both schemes), `crop-store-sheet-top`; Android 18/19 | Use a fixed sheet snap point (for example 90% of the height, or start below the header), so it never lands on a text line and is the same for every store |
| D5-09 | Nit | Sign-in | **"Ik heb een uitnodigingscode" is 17/500 accent with a 358×48 target.** That makes it as loud as "Stuur code"'s path and louder than the legal text. Spec 4.1 calls it a "kleine tekstlink". "Ander e-mailadres" on the code step has the same weight | 01, 02 | 15/400 accent; keep the 48 pt target |
| D5-10 | Nit | Route result | **The header is still three lines** (title, subtitle question, "12 producten · oudste prijs 9 dagen oud"), so the first store starts at y=112. Spec 4.5's result mock has no subtitle | 17 | Drop the subtitle once results show; keep the meta line |
| D5-11 | Nit (web-only?) | Household | **Nested switch:** the labelled 358×48 `role=switch` contains an unlabelled 40×20 `role=switch` input, so screen readers may announce two switches | measured | Hide the inner input from accessibility |
| D5-12 | Nit | List rows | "Yoghurt **1 l**" still reads as "1 I" in the web font (open since round 1) | 05 | Check with SF Pro/Roboto on a device; if it is still ambiguous, render "1 L" |
| D5-13 | Nit | Suggestions | **"kaa" suggests Kaart and Kaarsen (non-food)** in slots 3 and 4 (open since round 2). Listonic's speed comes from history-first suggestions | 07 | Rank history and checked items first, then food; push non-food stems out of the top 4 |
| D5-14 | Nit (copy) | Route opt-in | The body is **4 centred lines with a one-word widow** ("eerlijk."). It adds a sentence that is not in spec 4.5 ("We tellen per winkel je hele lijst op, met prijzen van <bron>.") | 16 | Spec copy only ("Ontbrekende prijzen tonen we eerlijk."). The source belongs in the ⓘ sheet |
| D5-15 | Nit (copy) | Quick-add | "**‘kaa’ toevoegen (2)**": the "(2)" reads like a result count, not a quantity (the spec prescribes this format) | 07 | "2 × ‘kaa’ toevoegen"; update spec 4.3 |
| D5-16 | Nit (copy) | ⓘ sheet | The sheet is a **9-line block at 17 pt** with no paragraph break, and it says "Voor elk **item**" while the rest of the app says "producten" | 20 | Two short paragraphs at 15 pt; "Voor elk product"; update the spec text |
| D5-17 | Nit | Store sheet | **A third hairline style.** The list uses full-bleed rules, Household uses rules inset on both sides, and the store sheet uses rules inset only on the left. "Geen prijs" lines show only the list name ("Koffiebonen"), not the amount asked for ("1 kg") | 18, 19 | One rule style. Show the requested amount in muted text on missing lines |
| D5-18 | Nit | Header / tab bar | The route tab icon is a generic document/receipt. The people icon's shoulders are clipped flat by its viewBox | 05, `crop-offline-zoom` | A scale or tag icon for the route; widen the people glyph's viewBox |
| D5-19 | Nit (web limitation) | Sign-in | Web shows only the e-mail path (no Apple/Google, no "of" divider), so the platform order cannot be checked | 01 | Device check (section 7) |
| D5-20 | Nit (copy) | Join | **Both households are called "Thuis".** Tim is in his own auto-created "Thuis" and sees "Word je lid van ‘Thuis’?", which reads as a no-op. Silent defaults make this the common case | 15 | Add the owner when the names collide: "Word je lid van ‘Thuis’ van Jan?" (the subline already names Jan) |
| D5-21 | Nit | Item detail | The name field is **600 weight inside an input**, while every other input is 17/400. It looks like a title rather than something editable | 08 | 17/400 like the other fields, or a borderless title-style field with a visible edit affordance |

### Defect count

**0 Major, 8 Minor (D5-01 … D5-08), 13 Nits (D5-09 … D5-21). No blocker.**

- New in round 5: D5-08 (sheet top cuts the header), D5-09, D5-20 and D5-21.
- Everything else carries over from round 4.

**Price rules: nothing seen breaks them.**

- The no-data state shows no € anywhere, no button and no toggle.
- The incomplete basket (Oost) shows **no total** even though it would be cheapest, and it never carries
  "Goedkoopste". Its sheet header says "Onvolledig · 10 van 12 prijzen".
- Missing prices show "? Geen prijs" in `textMuted`, never €0.
- The stale price shows "9 dagen oud" in `warning` with a clock, and it counts towards the total.
- "Goedkoopste" appears only on the top complete basket. Ranking is per single store, with no 2- or
  3-store route.
- Package matching is visible in the sheet:
  - "Koffiebonen 500 g · 2 stuks" covers the 1 kg that was asked for.
  - "Spinazie 400 g · 100 g meer" shows the overage.
- Checked items (Pindakaas, Appels, Brood) count in the basket, as spec 4.5 rule 8 requires.

**What passed** (spot-checked against the spec):

- The one-line header with 48×48 "Huishouden" and sync targets.
- 57 pt rows with a 48×48 checkbox zone.
- A 48 pt quick-add bar with "Voeg iets toe…" and a 48×48 clear button.
- "Afgevinkt (n)" collapsed by default, with "Wissen" at 68×48.
- ≤4 suggestions, with "+ ‘kaa’ toevoegen (2)" first.
- The item detail matches 4.4.
- The offline sheet copy matches 4.3 exactly.
- The 56 pt tab bar.
- The join sheet matches 4.2.
- Store rows match 4.5; amounts are 17/600.
- Household text actions are one weight with 48 pt rows.
- Light and dark tokens match 2.1/2.2; dark sheets separate visibly from the scrim.

## 6. Benchmark notes

- **Listonic.** Sources: the App Store feature text and reviews, and its own product page.
  - Its speed comes from history-first suggestions, one-tap popular items and real-time shared lists.
  - Its clutter comes from aisle/category grouping, sort modes, per-item price fields, per-store lists
    and ads on the free tier.
  - Goedboodschap's list beats it on noise.
  - Goedboodschap loses on suggestion ranking (D5-13) and on the account wall for invitees.
- **Mandje.** Sources: the ten screenshot captions only.
  - The first screen is deals ("All supermarket deals"), and the list is one of about ten destinations.
  - Screenshot 3, "List cost per supermarket", is the layout we borrow: one total per store with
    per-item availability.
  - Goedboodschap shows the same information as flat rows, with no logos, loyalty cards, price-per-kilo
    or store picker.
  - Unlike Mandje (leaflet data, per ID.nl), it shows no total for an incomplete basket.

## 7. Must be checked on device (iOS + Android): not covered by this round

No iOS simulator, Android emulator or physical device was available, so **native rendering was not
run**. Everything below is unverified:

- **Tab bar:** 56 pt plus the iOS home indicator, and Android gesture and 3-button navigation. Check at
  font scale 100/135/200%.
- **Real fonts** (SF Pro / Roboto):
  - "1 l" legibility (D5-12).
  - Wrapping of long item and store names.
  - Tabular euro amounts.
  - The two-line route title (D5-07).
- **Icons at real densities:** the filled offline glyph next to the outline people icon (D5-05), and the
  clipped people icon (D5-18).
- **Safe areas:** notch/Dynamic Island, the home indicator under bottom sheets, Android edge-to-edge, the
  status-bar style, and the Android navigation-bar colour in dark mode.
- **Bottom sheets:**
  - The snap height of the store sheet on real screen sizes (D5-08).
  - Swipe down and tap outside to close.
  - Scrolling a long store sheet under the pinned header.
  - The Android back button.
- **Focus and screen readers:**
  - Whether the white focus ring (D5-03) exists natively.
  - VoiceOver/TalkBack labels and focus order (spec 7).
  - The nested switch (D5-11).
  - Announcement of the undo snackbar and of sync transitions.
- **Native `Switch`:** colours, thumb, and the whole-row hit area. Also the dark-mode scrim on OLED.
- **Keyboard:**
  - Autofocus only on an empty list.
  - Enter keeps focus; scrolling dismisses the keyboard.
  - Sheets and the snackbar lift above the keyboard.
  - OTP autofill (`oneTimeCode`, Android autofill).
- **Gestures:** swipe left to delete + the undo snackbar, haptics (light on check, medium on delete), and
  reduced motion.
- **The 1.5 s "nothing moves under your finger" rule**, with real touches and realtime inserts from a
  second phone.
- **Sharing:** the native share sheet for "Deel lijst" (web used the clipboard fallback). The universal
  link / App Link `/j/<code>` on cold and warm start, and before sign-in (pending code).
- **Apple and Google sign-in** buttons and their order per platform (D5-19).
- **Offline:**
  - NetInfo detection (airplane mode, captive portal).
  - Outbox survival after kill + restart.
  - The "Geen internet" first-start state.
- **Performance:** cold start ≤ 1.5 s on a mid-range Android; suggestions < 16 ms per keystroke.

## Sources

- Mandje screenshot captions and image URLs (images blocked by the proxy): https://mwm.ai/apps/mandje/6758279445
- Mandje in ID.nl, October 2026: https://id.nl/huis-en-entertainment/mobiel/smartphone-en-tablet/6-apps-voor-oktober-2026-van-boodschappen-vergelijken-tot-zelf-muziek-maken-2
- Listonic App Store listing (feature text and reviews; screenshots not served): https://apps.apple.com/us/app/-/id331302745
- Listonic screenshot index (images blocked by the proxy): https://appgoblin.info/apps/331302745
- Listonic product page (vendor, not independent): https://cf.listonic.com/
