# Visual review, round 4

Date: 2026-10-23 · Build: `5803386` ("Fix round 3"). The working tree is clean apart from untracked docs.
Scope: every v1 screen, light and dark, at 390×844 (iPhone) and 412×915 (Android)
Benchmarks: `design-spec.md` (authoritative for UX), Listonic (simplicity), Mandje (list-comparison layout)
Screenshots: `docs/screenshots/round-4/` (92 PNGs: 23 screens × 2 devices × 2 schemes, plus 2 `crop-*` detail crops, named
`NN-screen--device--scheme.png`). They are also copied to the shared folder `screenshots/round-4/`.

## 1. How this was run (and what it does NOT prove)

- **Rendering: React Native Web in headless Chromium** (`/opt/pw-browsers/chromium`). This is not iOS or
  Android. **No simulator, emulator or device was run.** The font is the browser's `-apple-system`
  fallback, not SF Pro or Roboto. Safe areas, tab-bar insets, the keyboard, sheet gestures, the native
  share sheet, the native `Switch`, haptics, focus rendering and screen readers all behave differently on a
  device. Defects marked "web-only?" may not occur natively. Section 7 lists what still has to be
  checked on real hardware.
- **Backend: the real local Supabase stack** (`npx supabase start`, then `supabase db reset` to the
  current migrations). The app used the **real sync engine** (expo-sqlite wasm). The web export normally
  uses the in-memory demo backend, so three changes were made **temporarily** and reverted after the
  capture:
  1. `createBackend.web.ts` returned the Supabase backend.
  2. A temporary `metro.config.js` added `.wasm` as an asset and routed `expo-secure-store` to a
     localStorage shim.
  3. The shim itself lived in `.review-shims/`.

  `dist/` was then re-exported with the demo backend. Nothing was committed.
- **Seed data** (local DB only), created through the real RPCs `create_household`, `create_invite`,
  `accept_invite` and `apply_mutations`:
  - Household "Thuis" with owner Jan and member Sanne.
  - 12 items: 9 open and 3 checked (Brood, Appels, Pindakaas), with notes and g/kg/l units.
  - Eva has an empty list.
  - Tim is alone in his own household. He opens the invite link `/j/<code>`.
- **Sign-in:** each session came from an admin magic link followed by `verifyOtp` (the e-mail code). It
  was injected into the chunked session storage. `POST /auth/v1/otp` was stubbed to reach the code step.
- **Price fixture:** the "Goedkoopste route" data states were rendered by intercepting the price-table
  GETs in Playwright. **No price row was written to any database.**
  - The fictional chains are "Testwinkel Noord", "Testwinkel Zuid" and "Testwinkel Oost". The source is
    "Screenshotfixture (geen echte prijzen)".
  - Noord and Zuid are complete baskets. Noord has one price that is 9 days old.
  - Oost is incomplete: 10 of 12 prices, with Koffiebonen and Wc-papier missing. If it were ranked, Oost
    would be the cheapest.
  - Product names such as "Melk 1000 ml" and "Bananen 1 st" come from the fixture, not from the app.
- **Measurements** (font size, line height, colour, tap-target size, focus style) were read from the DOM
  in a separate iPhone pass. The numbers are CSS px, which equal pt/dp at these viewports. Pixel colours
  were sampled from the PNGs.
- **Benchmark material:** I **still could not view the Listonic and Mandje store screenshots.**
  - `curl` to `is1-ssl.mzstatic.com` returns `CONNECT tunnel failed, response 403` from the egress proxy.
    WebFetch on the image URL fails with a server error.
  - The comparison therefore relies on three text sources: Mandje's ten screenshot captions (mwm.ai
    lists them with their image URLs), the ID.nl review, and Listonic's own product page and FAQ.
  - **A pixel-level comparison with either app was not possible.** Rounds 1–3 and design-spec 1.4 have
    the same limitation.
- The capture runs logged **no page errors and no console errors**.

## 2. Screens captured (all viewed)

| # | Screen | State |
|---|---|---|
| 01 / 02 / 03 | Sign-in | E-mail form; 6-box code step with countdown; "Uitnodigingscode" sheet (empty field) |
| 04 | Empty list | Eva, with autofocus in the bar |
| 05 / 06 | List with items | 9 open + "Afgevinkt (3)", collapsed and expanded |
| 07 | Quick-add | "2 kaa" with suggestions |
| 08 | Item detail | Melk, in a bottom sheet |
| 09 / 10 / 11 | Household / invite | Before and after "Deel lijst" (web clipboard fallback). 11 is identical to 10 because the page fits |
| 12 / 13 | Offline | Sync icon in the header; explanation sheet |
| 14 | Goedkoopste route, **no verified source** | "Geen geverifieerde prijzen beschikbaar" |
| 15 | Join | Tim opens `/j/<code>` |
| 16 / 17 | Route fixture | Opt-in; ranked result (2 complete baskets, 1 incomplete) |
| 18 / 23 | Route fixture, **complete basket** | Noord sheet, top and scrolled |
| 19 / 21 | Route fixture, **incomplete basket** | Oost sheet, top and scrolled. 21 is identical to 19 because all 12 lines fit |
| 20 | Route fixture | ⓘ sheet "Hoe we vergelijken" |
| 22 | Household | With the price switch (opt-in on) |

How I looked at them:

- Every iPhone light screenshot at full size.
- All iPhone dark and all Android light and dark screenshots as contact sheets.
- Full-size crops where detail mattered: the offline icon, the OTP boxes, and the join button in both
  themes.

Android matches iPhone in every screen. I found no defect that appears on only one device.

## 3. Side-by-side comparison

| Aspect | Listonic | Mandje | Goedboodschap (observed, round 4) | Verdict |
|---|---|---|---|---|
| First screen | The list, with categories/aisle sort and an optional price total. Ads on the free tier ("ad-free experience" is a premium feature) | Promo-first home: "All supermarket deals", supermarket logos, featured bonus offers | The list: a one-line header "Thuis" + people icon, the quick-add bar and the rows. No promos, logos or totals | The calmest of the three. Still the app's strongest screen |
| Navigation chrome | Bottom bar plus menus; ad slots | Many destinations: deals, list, favourites, loyalty cards, search, categories, store picker | Two tabs in a 56 pt bar with 13/16 labels. The list empty state reuses the "Mijn lijst" tab icon. The route tab icon is a generic document | Right concept. The icons are generic |
| Adding an item | Auto-complete, "popular products", history ("what you buy most first"), voice/photo AI | "Type list, get prices" notepad | Type + Enter, or tap one of ≤4 suggestions. "kaa" still offers **Kaart** and **Kaarsen** (non-food) | As fast as Listonic. Listonic's history-first ranking is still better |
| Row anatomy | Checkbox, name, quantity, note; optional price and category | Product row with a price per store | 24 pt round checkbox, 17 pt name, 15 pt muted quantity, 13 pt note, full-bleed hairlines, 57 pt rows with a 48×48 check zone | Matches spec 3. The cleanest row of the three. "1 l" still reads as "1 I" |
| Alignment | – | – | **Fixed.** Row names, suggestion text and "Afgevinkt (3)" all start at x=56. "Wissen" and the bar end on the 16 pt margin. The suggestion "+" sits under the bar "+" | No longer an issue on the main screen |
| Visual noise | Low in the core, high with ads and upsells | High (deals, alerts, cards, categories, filters, price per kilo) | Very low on the list and the route. Household is calmer than round 3 (one "Account" group, 15 pt actions) but still shows **three red labels** and a **double rule** under the members. The offline icon is now a **solid black** glyph next to an outline icon, so it is the heaviest mark in the header | Meets principle 0.7 on the main screens. Household and the header icon need one more pass |
| Typography | – | – | The 20/17/15/13 scale is used consistently. The remaining inversions: on route no-data and opt-in, the **centred 20/600 content title outweighs the 17/400 screen header**; the member "Verwijderen" is 17/500, while the account actions are 15 | Good tokens; mostly good use |
| Sharing | Link, no account needed | Account, max. 4 people | "Deel lijst" is the primary button. Afterwards the page shows "Code: GBVGF5" (17) and an accent "Code vervangen" (15/500, 48 pt). The web build shows the snackbar "Uitnodiging gekopieerd" | Clear. "Code vervangen" still lives on the page rather than in the share sheet (spec 4.2) |
| Joining | Open the link | Account | Sheet "Word je lid van ‘Thuis’?" / "Uitgenodigd door Jan · 2 leden" / one button | **Matches spec 4.2 now.** On web there is a white focus ring on the button in dark mode |
| Offline | Users complain about sync | Unknown | A filled cloud-off icon in the header. A tap opens a one-sentence sheet with exactly the spec copy | The glyph is now unambiguous (fixes D3-01). Its weight and fill do not match the outline icon set |
| Price comparison | User-entered prices and an estimated list total | Central: "List cost per supermarket", with per-item availability and a supermarket picker; loyalty cards | Separate opt-in tab with flat store rows: name left, bold total right; "Goedkoopste · 1 verouderd"; "+€3,13". Under "Onvolledig", Oost shows "10 van 12 prijzen" and **no amount** | Takes Mandje's one useful idea (total per store + coverage) without the clutter. More honest than either app |
| No-data honesty | n/a | n/a (leaflet data) | "Geen geverifieerde prijzen beschikbaar" + one muted paragraph. No icon, button, toggle or € anywhere | Correct and calm. The spec text is still out of date |
| Per-store detail | n/a | Per-item availability on the comparison screen | The sheet pins the title and the summary ("€44,67 · 12 van 12 prijzen · 1 verouderd") with a hairline. Lines are 51 pt, so all 12 fit on an iPhone. "2 stuks €2,38", "9 dagen oud" in warning colour with a clock, "? Geen prijs" in muted | **D3-02 and D3-15 are fixed.** This now reads well |
| Settings / account | Settings menu | Account | One screen: share, name, members, price switch (only after opt-in), and the "Account" group | Compact. Spacing and weights are uneven (section 5) |
| Account wall | None for people who receive a list | Account | Web shows only the e-mail code; Apple and Google are not rendered on web | A higher barrier than Listonic, as accepted in spec risk 4 |

## 4. Round-3 defects: status

| ID | Round-3 defect | Status in round 4 |
|---|---|---|
| D3-01 | Offline icon unreadable | **Fixed** (a clean slashed cloud in the text colour, 24 px in a 48 target). New: solid fill against the outline icon set (D4-04) |
| D3-02 | "2× €2,38" ambiguous | **Fixed:** "2 stuks" in muted, then the bold line total. Spec 4.5 still shows "2×" (D4-03) |
| D3-03 | Orange UA focus ring | **Partly fixed.** The outline is now accent (`outline: auto rgb(30,122,76) 1px`), but Chromium draws `auto` as a double ring with a **white inner ring**. That ring is clearly visible in dark mode (D4-05) |
| D3-04 | Price switch 40×20, dark thumb | **Fixed visually:** the whole 358×48 row is the switch, with a white thumb in both themes. New: a second, unlabelled `role=switch` (the 40×20 input) is nested inside it (D4-10) |
| D3-05 | Disabled button looks active in dark | **Fixed** (neutral surface + muted label in both themes) |
| D3-06 | "Code vervangen" looks disabled; on the page | **Partly fixed.** The code is now 17 pt in `text`, and "Code vervangen" is 15/500 accent with a 48 pt target. It is still on the page, not in the share sheet (D4-06) |
| D3-07 | Account block loud and ungrouped | **Partly fixed.** There is an "Account" heading, a divider and 15 pt actions, with "Uitloggen" in `text`. Three red labels remain, and a double rule appeared (D4-01, D4-07) |
| D3-08 | Legal links duplicated | **Fixed:** inline underlined links in the footnote. New: the links are 81×16 and 83×16 tap targets (D4-02) |
| D3-09 | Alignment jump on sign-in | **Fixed** (both steps left-aligned at the same top) |
| D3-10 | Join title | **Fixed** (matches spec 4.2) |
| D3-11 | "items", "9 d" | **Fixed** ("12 producten · oudste prijs 9 dagen oud"). The header is still three lines (D4-09) |
| D3-12 | Spec says "Nog niet beschikbaar" | **Open** (design-spec lines 19, 283, 461, 528) (D4-03) |
| D3-13 | Four left edges | **Fixed** (all at x=56; "Wissen" ends at 374) |
| D3-14 | "1 l" reads as "1 I" | **Open** (D4-11) |
| D3-15 | Store-sheet summary scrolls away | **Fixed** (pinned with a hairline; 51 pt lines) |
| D3-16 | "kaa" → Kaart, Kaarsen | **Open** (D4-12) |
| D3-17 | Opt-in widow and inset | **Partly fixed.** The button is on the 16 pt margin. The body is still 4 centred lines ending in the widow "eerlijk." (D4-13) |
| D3-18 | Header weights, sign-in margin | **Fixed** (all headers 17/400; sign-in on 16) |
| D3-19 | Tab icon reused in the route empty states | **Fixed** on the route (no icon now). The same pattern remains on the list empty state (D4-14) |
| D3-20 | No Apple/Google on web | Open (web limitation; device check) |

## 5. Defect list (round 4)

Severity:

- **Major:** visibly broken, misleading, or a spec rule broken in a way users hit.
- **Minor:** a visible polish, consistency, accessibility or copy problem.
- **Nit:** taste or cleanup.

"Web-only?" means the defect may not reproduce natively; verify it on a device before fixing.

| ID | Sev | Screen | Defect | Evidence | Fix direction |
|---|---|---|---|---|---|
| D4-01 | Minor | Household | **Double rule under the members.** The last member row draws its bottom hairline, and the "Account" divider follows 24 pt lower. Without opt-in this gives two parallel grey lines with nothing between them. With opt-in, the price row floats in a ~100 pt band between two rules, although the row itself is 48 pt | 09, 10, 11, 22 (all 4) | No hairline after the last member; one section divider; 24 pt above and below each group |
| D4-02 | Minor | Sign-in | **The legal links are 16 pt tall tap targets** ("voorwaarden" 81×16, "privacybeleid" 83×16), below the 44×44 rule in spec 2.3 | 01; measured | `hitSlop` to ≥44 pt height, or line height 22 with vertical hit slop |
| D4-03 | Minor (doc) | Spec | design-spec still says **"Nog niet beschikbaar"** (lines 19, 283, 461, 528), and 4.5 still shows the "2×" line format that D3-02 replaced. Open for three rounds | spec | Owner: design. Update 4.5, 9 and the F31 row so nobody "fixes" the app back |
| D4-04 | Minor | List header (offline) | **The offline glyph is a solid black fill** next to the 1.5 px outline people icon. It is now the heaviest mark on the screen and reads as an alarm, while principle 0.6 asks for quiet. The icon set is mixed | 12, `crop-offline-zoom` | Outline `cloud-off` at the same stroke weight as the people icon, in `text`; check at 1× on a device |
| D4-05 | Minor (web-only?) | Join; invite-code input | Focus is drawn as `outline: auto`, which Chromium renders as an accent ring **plus a white inner ring**. On the dark sheet "Lid worden" gets a bright white border. The ring also appears on programmatic autofocus, not only on keyboard focus | 15 dark (both devices), `crop-join-dark`; measured | `outline-style: solid` 2 px accent with an offset, only on `:focus-visible` |
| D4-06 | Minor | Household | **"Code vervangen" is still on the page** (spec 4.2 and C15: owner only, inside the share sheet). Next to "Code: GBVGF5" it invites a destructive tap on a screen that people open to share | 10 | Move it into the share/confirm flow; keep only "Code: …" on the page |
| D4-07 | Minor | Household | **Three red labels and mixed weights remain.** The member "Verwijderen" is 17/500, "Huishouden verlaten" and "Account verwijderen" are 15/500, and "Uitloggen" is 15/400. "Ingelogd als …" is 15 pt, while spec 4.6 says footnote (13). The account actions sit 56 pt apart, which is airier than the 48 pt rows used everywhere else | 09, 22; measured | One weight (400) for text actions; member "Verwijderen" at 15; "Ingelogd als" at 13; 48 pt rows |
| D4-08 | Minor | Route no-data, route opt-in, list empty state | **Hierarchy inversion and alignment change.** The screen header is 17/400 and left-aligned, but the content title below it is 20/600, centred, and wraps to two lines ("Geen geverifieerde prijzen / beschikbaar"). The page's loudest text is its least actionable | 14, 16, 04 | Left-align the empty-state block on the 16 pt margin (as on sign-in), or make the header the title and drop the duplicate |
| D4-09 | Nit | Route result | The header is still **three lines** (title, subtitle question, "12 producten · oudste prijs 9 dagen oud"), so the first store starts at y=112 | 17 | Drop the subtitle once results show; keep the meta line |
| D4-10 | Nit (web-only?) | Household | The price row (`role=switch`, labelled) contains an **unlabelled 40×20 `role=switch` input**, so screen readers may announce two switches | measured | Hide the inner input from accessibility (`importantForAccessibility="no"` / `aria-hidden`) |
| D4-11 | Nit | List rows | "Yoghurt **1 l**" still reads as "1 I" in the web font (open since round 1) | 05 | Check with SF Pro/Roboto on a device; if it is still ambiguous, render "1 L" |
| D4-12 | Nit | Suggestions | "kaa" suggests **Kaart** and **Kaarsen** (non-food) before anything from the household's history (open since round 2) | 07 | History first, then the food catalogue; drop non-food stems from the top 3 |
| D4-13 | Nit (copy) | Route opt-in | The body is **4 centred lines with a one-word widow** ("eerlijk."). It also adds a sentence that is not in spec 4.5 ("We tellen per winkel je hele lijst op, met prijzen van <bron>.") | 16 | Spec copy only ("Ontbrekende prijzen tonen we eerlijk."); the source lives in the ⓘ sheet |
| D4-14 | Nit | List empty state | The empty-state illustration is the **"Mijn lijst" tab icon**, the same reuse that D3-19 removed from the route | 04 | No icon (as on the route), or its own line icon |
| D4-15 | Nit (copy) | Quick-add | "**‘kaa’ toevoegen (2)**": the "(2)" reads like a result count, not a quantity. The spec prescribes this format | 07 | "2 × ‘kaa’ toevoegen", or "‘kaa’ toevoegen · 2"; update spec 4.3 |
| D4-16 | Nit (copy) | ⓘ sheet | The sheet is a **9-line block at 17 pt** with no paragraph break, and it keeps "Voor elk **item**" after D3-11 replaced "items" with "producten" elsewhere. The copy follows the spec | 20 | Two short paragraphs at 15 pt; "Voor elk product"; update the spec text |
| D4-17 | Nit | Store sheet | **A third hairline style:** the main list uses full-bleed rules, Household uses rules inset on both sides, and the store sheet uses rules inset only on the left. "Geen prijs" lines are interleaved with priced ones and do not show what was asked for (e.g. "Koffiebonen 1 kg") | 18, 19 | One rule style (full-bleed, or left-inset to the text); show the requested amount in muted on missing lines |
| D4-18 | Nit | Header / tab bar | The route tab icon is a generic document/receipt, and the people icon's shoulders look cut flat at the bottom of the viewBox | 05, `crop-offline-zoom` | A scale/tag icon for the route; check the people glyph at 1× on a device |
| D4-19 | Nit | Sign-in | Web still shows only the e-mail path (no Apple/Google, no "of" divider), so the platform order cannot be checked here | 01 | Device check (section 7) |

### Defect count

**0 Major, 8 Minor (D4-01 … D4-08), 11 Nits (D4-09 … D4-19). No blocker.**

This is the first round without a Major. Of the 20 round-3 defects, **12 are fixed, 5 are partly
fixed, and 3 are open** (D3-12, D3-14, D3-16), plus D3-20, which is a web limitation.

**Price rules: nothing seen breaks them.**

- The no-data state shows no € anywhere, and no button or toggle.
- The incomplete basket (Oost) shows **no total** even though it would be cheapest, and it never carries
  "Goedkoopste".
- Missing prices show "? Geen prijs" in `textMuted`, never €0.
- The stale price shows "9 dagen oud" in `warning` with a clock, and it counts towards the total.
- "Goedkoopste" appears only on the top complete basket. Ranking is per single store only, with no
  2- or 3-store route.
- Package matching is visible in the sheet: "Koffiebonen 500 g · 2 stuks" covers 1 kg, and
  "Spinazie 400 g · 100 g meer" shows the overage.

**What passed** (spot-checked against the spec):

- The one-line header with 48×48 "Huishouden" and sync targets.
- 57 pt rows with a 48×48 checkbox zone.
- A 48 pt quick-add bar with the placeholder "Voeg iets toe…" (a real ellipsis) and a 48×48 clear
  button.
- "Afgevinkt (n)" collapsed by default, with "Wissen" at 68×48.
- ≤4 suggestions, with "+ ‘kaa’ toevoegen (2)" first.
- The item detail matches 4.4.
- The offline sheet copy matches 4.3 exactly.
- The 56 pt tab bar.
- The join sheet matches 4.2.
- The store and route rows match 4.5; amounts are 17/600.
- Light and dark tokens match 2.1/2.2; the dark sheets separate visibly from the scrim.

## 6. Benchmark notes

- **Listonic** (its own product page and FAQ): its speed comes from history-first suggestions ("what you buy most
  first"), one-tap popular items and real-time shared lists. Its clutter comes from categories, aisle
  sorting, price totals, an AI assistant and ads on the free tier. Goedboodschap's list beats it on noise.
  It loses on suggestion ranking (D4-12) and on the account wall for invitees.
- **Mandje** (screenshot captions only): the first screen is deals ("All supermarket deals"). The list is
  one of ten destinations. Screenshot 3, "List cost per supermarket", is the layout we borrow: one total
  per store with per-item availability. Goedboodschap shows the same information as flat rows, with no
  logos, no loyalty cards and no store picker. Unlike Mandje (leaflet data, per ID.nl), it shows no
  total for an incomplete basket.

## 7. Must be checked on device (iOS + Android): not covered by this round

No iOS simulator, Android emulator or physical device was available, so **native rendering was not
run**. Everything below is unverified:

- **Tab bar:** 56 pt plus the iOS home indicator, and Android gesture and 3-button navigation. Check at
  font scale 100/135/200%.
- **Real fonts** (SF Pro / Roboto):
  - "1 l" legibility (D4-11).
  - Wrapping of long item and store names.
  - Tabular euro amounts.
  - The two-line route title.
- **Icons at real densities:** the solid offline glyph next to the outline people icon (D4-04), and the
  people icon's cut shoulders (D4-18).
- **Safe areas:** notch/Dynamic Island, the home indicator under bottom sheets, Android edge-to-edge, the
  status-bar style, and the Android navigation-bar colour in dark mode.
- **Focus and screen readers:**
  - Whether the white focus ring (D4-05) exists natively.
  - VoiceOver/TalkBack labels and focus order (spec 7).
  - The nested switch (D4-10).
  - Announcement of the undo snackbar and of sync transitions.
- **Native `Switch`:** colours, thumb, and the whole-row hit area. Also the dark-mode scrim on OLED.
- **Keyboard:**
  - Autofocus only on an empty list.
  - Enter keeps focus; scrolling dismisses the keyboard.
  - Sheets and the snackbar lift above the keyboard.
  - OTP autofill (`oneTimeCode`, Android autofill).
- **Bottom sheets:** swipe down and tap outside to close, scrolling a long store sheet under the pinned
  header, and the Android back button.
- **Gestures:** swipe left to delete + the undo snackbar, haptics (light on check, medium on delete), and
  reduced motion.
- **The 1.5 s "nothing moves under your finger" rule**, with real touches and realtime inserts from a
  second phone.
- **Sharing:** the native share sheet for "Deel lijst" (web used the clipboard fallback). The universal
  link / App Link `/j/<code>` on cold and warm start, and before sign-in (pending code).
- **Apple and Google sign-in** buttons and their order per platform (D4-19).
- **Offline:**
  - NetInfo detection (airplane mode, captive portal).
  - Outbox survival after kill + restart.
  - The "Geen internet" first-start state.
  - A locked or full SQLite file.
- **Performance:** cold start ≤ 1.5 s on a mid-range Android; suggestions < 16 ms per keystroke.

## Sources

- Mandje screenshot captions and image URLs (images blocked by the proxy): https://mwm.ai/apps/mandje/6758279445
- Mandje in ID.nl, October 2026: https://id.nl/huis-en-entertainment/mobiel/smartphone-en-tablet/6-apps-voor-oktober-2026-van-boodschappen-vergelijken-tot-zelf-muziek-maken-2
- Listonic product page and FAQ (vendor, not independent): https://cf.listonic.com/
- Listonic screenshot index (images blocked by the proxy): https://appgoblin.info/apps/331302745
- Listonic App Store listing: https://apps.apple.com/app/grocery-shopping-list-listonic/id331302745
