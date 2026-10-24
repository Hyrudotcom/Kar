# Kar v1: stand van zaken

Datum: 23 oktober 2026 · Branch: `integration/v1` (code-stand `ad3116f`, "Fix round 4") · Nog **niet** samengevoegd met `main`.

Kort gezegd: de app werkt volledig in tests tegen een echte lokale Supabase. Alle tests slagen: **623 geslaagd, 0 mislukt**. Wat nog ontbreekt is een test op een echte iPhone of Android-telefoon, echt inloggen met Apple en Google, en echte prijzen. Daarvoor zijn toestellen, inloggegevens of een licentie nodig die hier niet beschikbaar zijn.

---

## 1. Wat werkt

**Inloggen en account**
- Inloggen met een 6-cijferige code per e-mail (geen magische links). Apple en Google zijn ingebouwd (ID-token naar Supabase), maar niet echt getest (zie 4).
- De sessie staat versleuteld in de beveiligde opslag van het toestel (`expo-secure-store`, opgeknipt in stukjes).
- Uitloggen, huishouden verlaten, uit een huishouden verwijderd worden en account verwijderen wissen de lijst op het toestel. Staan er nog onverstuurde wijzigingen, dan waarschuwt de app eerst.
- Accounts worden nooit op e-mailadres samengevoegd. Onder Huishouden staat "Ingelogd als …".

**Huishouden en uitnodigen**
- Na de eerste keer inloggen krijgt iedereen stil een eigen huishouden "Thuis".
- "Deel lijst" maakt een link (`/j/<code>`) met een code van 6 tekens. De code is 7 dagen geldig, het aantal pogingen is beperkt, en de eigenaar kan de code vervangen.
- Lid worden via de link of door de code in te typen. De app vraagt eerst "Word je lid van ‘Thuis’?". Wie de link opent vóór het inloggen, komt na het inloggen meteen bij die vraag.
- De eigenaar kan leden verwijderen. Een verwijderd lid merkt dat binnen enkele seconden (Realtime) en ziet welke wijzigingen niet meer zijn opgeslagen.

**Mijn lijst**
- Snel toevoegen in één balk: "2 melk", "melk 2", "500 g gehakt", "3x brood", "1,5 l melk".
- Suggesties tijdens het typen (maximaal 4) uit je eigen geschiedenis, afgevinkte items en een Nederlandse productlijst die zonder internet werkt.
- Eigen items toevoegen, hoeveelheden en eenheden (stuks, g, kg, ml, l), een notitie, afvinken, "Afgevinkt (n)" ingeklapt, "Wissen" voor alle afgevinkte items, en verwijderen met "Ongedaan maken".
- Dubbel toevoegen telt op ("Melk +1"). Een afgevinkt item dat je opnieuw typt, komt terug ("Melk teruggezet").
- Niets verspringt onder je vinger: nieuwe items van een ander verschijnen pas na 1,5 seconde rust.

**Synchronisatie (ook offline)**
- Elke wijziging gaat eerst naar een **blijvende wachtrij (outbox)** in een SQLite-bestand per gebruiker, en pas daarna naar het scherm. De wachtrij overleeft het afsluiten of crashen van de app.
- Elke wijziging heeft een eigen id. De server voert dezelfde wijziging nooit twee keer uit, ook niet als het antwoord onderweg verloren ging (**idempotent**).
- De **server bepaalt de volgorde** bij conflicten: verwijderen wint, "+1" van twee mensen wordt "+2", en bij een exacte hoeveelheid wint de wijziging die de server als laatste verwerkte.
- Realtime geeft alleen een seintje. Het toestel haalt de echte gegevens daarna zelf op, zodat een gemist seintje geen gaten veroorzaakt.
- Offline zie je een stil wolkje in de kop. Een tik erop geeft één zin uitleg.

**Goedkoopste route**
- Het tabblad toont vandaag eerlijk: **"Geen geverifieerde prijzen beschikbaar"**. Er staat geen bedrag, geen knop en geen schakelaar.
- De vergelijkingsmotor is af en getest met testgegevens. Hij koppelt op EAN, variant en verpakkingsgrootte, rekent met de gevraagde hoeveelheid (bijvoorbeeld 2 × 500 g voor 1 kg), en markeert ontbrekende en verouderde prijzen. Een onbekende prijs telt **nooit** als € 0. Alleen **complete** mandjes bij **één** winkel krijgen een totaal en een plek in de ranglijst.
- Prijsvergelijking staat standaard uit (opt-in). Er zijn geen aanbiedingen of reclame.

**Alleen twee tabbladen:** "Mijn lijst" en "Goedkoopste route". Alle teksten zijn Nederlands.

---

## 2. Testresultaten (vandaag gedraaid, 23 oktober 2026)

Werkwijze: eerst de tests die geen database nodig hebben. Daarna de Docker-daemon starten, `npx supabase start` (zonder studio, storage, logflare en dergelijke; met de echte Kong-gateway, Auth, PostgREST en Realtime) en `npx supabase db reset`, waarmee alle 9 migraties en `seed.sql` zijn toegepast. Daarna alle databasetests en tests met echte gebruikers, en tot slot `npx supabase stop`. Na afloop draaide er geen enkele container meer.

| Onderdeel | Commando | Resultaat |
|---|---|---|
| Typecontrole | `npm run typecheck` | 0 fouten |
| Lint | `npm run lint` | 0 fouten, 0 waarschuwingen |
| App, prijsmotor, sync (zonder database) | `npm test` | 38 testbestanden (37 geslaagd, 1 overgeslagen); **467 geslaagd**, 9 overgeslagen, 0 mislukt |
| &nbsp;&nbsp;waarvan app (schermen, UI) | project `app` | 144 geslaagd |
| &nbsp;&nbsp;waarvan prijsmotor en hulpfuncties | project `unit` | 206 geslaagd |
| &nbsp;&nbsp;waarvan sync-engine (nep-server) | project `sync` | 117 geslaagd, 9 overgeslagen (die 9 hebben Postgres nodig, zie de volgende regel) |
| Sync-engine tegen echte Postgres-RPC's | `GB_SYNC_PG=1 npx jest --selectProjects sync` | 12 bestanden; **126 geslaagd**, 0 overgeslagen, 0 mislukt |
| Database: RLS, RPC's, Realtime, prijzen | `npm run test:db` | 8 bestanden; **127 geslaagd**, 0 mislukt |
| Integratie: echte gebruikers, API, Realtime, sync | `npm run test:integration` | 5 bestanden; **19 geslaagd**, 0 mislukt |
| End-to-end in de browser (web-export, Playwright) | `npm run export:web && npm run test:e2e` | **1 geslaagd**, 0 mislukt |

**Totaal: 623 verschillende tests geslaagd, 0 mislukt.** Elke test is één keer geteld: de 9 Postgres-synctests die in `npm test` worden overgeslagen, zitten in de 126 van de Postgres-run.

Bij `npm test` meldt Jest één keer "A worker process has failed to exit gracefully". Dat is een opruimwaarschuwing (een timer die niet netjes stopt) en geen mislukte test.

---

## 3. Wat is gecontroleerd, en hoe

Alle punten hieronder zijn gecontroleerd met **echte** Supabase-onderdelen (GoTrue-gebruikers, RPC's, RLS en Realtime via de lokale stack) en de **echte** sync-engine op SQLite-bestanden, aangestuurd vanuit Node. Dat is dezelfde code als in de app, maar niet op een telefoon.

**Gelijktijdig bewerken** (`tests/integration/convergence.test.ts`). Anna en Bram zitten in één huishouden en hebben elk een eigen toestel. Getest is:
- dat ze tegelijk verschillende items bewerken en Realtime de wijziging van de ander aflevert;
- tegelijk "+1" op hetzelfde item: er gaat geen ophoging verloren;
- tegelijk een exacte hoeveelheid: de laatste in serverbeurt wint;
- dat beiden offline "melk" toevoegen: één rij met de opgetelde hoeveelheid;
- afvinken en terugzetten door elkaar;
- verwijderen tegen bewerken: verwijderen wint en de bewerking wordt als mislukt gemeld;
- "Wissen" terwijl de ander iets terugzet: alleen wat op de server nog afgevinkt is, wordt gewist.

Na elke test zijn beide lijsten **exact gelijk** aan de serverstand.

**Offline herstel** (`convergence.test.ts` en `kill.test.ts`):
- 150 gemengde wijzigingen offline, met een herstart van de app tussendoor. Na het herverbinden is alles precies één keer verwerkt.
- Het proces is echt gedood (SIGKILL) op drie momenten: vóór het versturen, na het opslaan op de server maar vóór het antwoord, en na de eerste van meerdere batches. Ook is een verloren antwoord getest. In alle gevallen ging er niets verloren en werd niets dubbel verwerkt.
- Daarnaast zijn er tientallen sync-tests met een nep-server: het outbox-gedrag, het terugdraaien van een toevoeging en "Wissen", en het opnieuw beginnen als de server dat vraagt (`reset_required`).

**Rechten en scheiding tussen huishoudens** (`tests/integration/separation.test.ts`, `supabase/tests/security.test.ts` en andere):
- Een lid van huishouden B kan niets van A lezen via welke tabel dan ook.
- B kan niets van A wijzigen, niet direct en niet via de RPC's. Een geraden id lekt niets.
- B kan zich niet abonneren op A via Realtime. Als controle is getest dat een lid van A de gebeurtenissen wel krijgt.
- Een verwijderd lid verliest direct de toegang. Onverstuurde wijzigingen worden gemeld en de lokale gegevens worden gewist.
- `anon` heeft geen rechten. Elke `security definer`-functie controleert de gebruiker en het lidmaatschap.
- Een wachtwoord dat bij het aanmaken van een account is meegestuurd, werkt nooit om in te loggen (`auth.test.ts`).

**Gebruikersreizen**
- `tests/integration/journey.test.ts` doorloopt: aanmelden → "Thuis" → uitnodigen → partner wordt lid → beiden bewerken → partner vertrekt.
- `e2e/smoke.spec.ts` (browser): inloggen met een e-mailcode → item toevoegen → twee Nederlandse tabbladen → geen ongeverifieerde prijzen.
- Visuele ronde 5: elk scherm is in de browser doorlopen tegen de echte lokale stack, met de echte sync-engine (zie 5).

**Prijsregels** (`src/price/__tests__`, 137 tests, en `supabase/tests/prices.test.ts`):
- Een onbekende prijs is nooit € 0.
- Een onvolledig mandje krijgt geen totaal en geen plek in de ranglijst.
- Er wordt alleen op EAN gekoppeld: twee varianten van 350 g met verschillende EAN's worden nooit verwisseld.
- De verpakkingskeuze kiest de goedkoopste en bij gelijkspel de kleinste overmaat. Ook acties zijn getest.
- De grens van 7 en 14 dagen: tot 7 dagen is een prijs geverifieerd, van 7 tot 14 dagen "verouderd" (telt mee, met label), en daarna onbekend.
- Een prijs zonder datum is onbekend.
- Met 0 of 1 geverifieerde ketens toont het tabblad "Geen geverifieerde prijzen beschikbaar".

---

## 4. Wat NIET is gecontroleerd

- **Native iOS en Android.** Er was geen simulator, emulator of telefoon beschikbaar. De schermen zijn alleen in de browser getoond (React Native Web in Chromium), met een vervangend lettertype. De volgende onderdelen zijn dus nog nooit echt bekeken:
  - safe areas en de tabbalk boven de home-indicator;
  - het toetsenbord en automatisch invullen van de code;
  - bottom sheets, vegen, haptiek en de deelknop van het systeem;
  - VoiceOver en TalkBack;
  - NetInfo in vliegtuigmodus;
  - de opstarttijd op een gemiddelde Android-telefoon.

  De volledige checklist staat in `docs/visual-review-round-5.md`, sectie 7.
- **Echt inloggen met Apple en Google.** De code is er en de stappen eromheen zijn getest met nagebootste antwoorden. Een echte aanmelding vraagt om een Apple Developer-account (Sign in with Apple, Services ID, sleutel), Google OAuth-client-id's voor iOS, Android en web, en de providerinstellingen in Supabase. Die gegevens ontbreken (de velden in `.env.example` zijn leeg). Op het web worden de Apple- en Google-knoppen niet getoond.
- **Echte e-mail.** De code is in de tests via de beheer-API van de lokale stack opgehaald. Een echte mailserver (SMTP) is niet ingesteld en niet getest.
- **Echte prijzen.** Er is vandaag geen gelicenseerde bron (`price-provider-verdict.md`). De schermen met resultaten zijn alleen getoond met een testfixture (fictieve winkels "Testwinkel Noord", "Testwinkel Zuid" en "Testwinkel Oost"). Die fixture is in de browser onderschept en nooit in een database geschreven.
- **Universal links en App Links** (`https://getkar.nl/j/<code>`). Hiervoor moet het domein gehost worden en moet de app ondertekend zijn. Dat valt buiten deze repo.
- **Productie-Supabase, app-builds (EAS) en publicatie in de App Store en Play Store.** Niets daarvan is gedaan.
- **Een pixelvergelijking met Listonic en Mandje.** De screenshots in de app-winkels werden door de proxy geblokkeerd (zie 5).

---

## 5. Visuele vergelijking met Listonic en Mandje

- Laatste visuele review: [`docs/visual-review-round-5.md`](visual-review-round-5.md). Dat is ronde 5 op code-stand `ad3116f`.
- Laatste screenshots:
  - in de repo: [`docs/screenshots/round-5/`](screenshots/round-5/);
  - in de gedeelde map: `goedboodschap/screenshots/round-5/` (projectmap).

  Het zijn 95 PNG's: 23 schermen × iPhone (390×844) en Android (412×915) × licht en donker, plus 3 detailuitsneden.

**Uitkomst:**
- De lijst is de rustigste van de drie apps: geen reclame, logo's of totalen. Er is één kopregel, een balk om snel toe te voegen, en strakke rijen.
- Van Mandje is alleen het nuttige idee overgenomen: één totaal per winkel. Er komen geen aanbiedingen, klantenkaarten of een winkelkiezer bij. Anders dan Mandje toont Kar geen totaal bij een onvolledig mandje.
- Op twee punten is Listonic beter. De volgorde van de suggesties is minder slim: "kaa" geeft ook "Kaart" en "Kaarsen". En wie uitgenodigd wordt, moet bij ons een account hebben (een bewust geaccepteerd risico).
- Telling: **0 grote fouten, 8 kleine (Minor), 13 details (Nit). Geen blokkade.** Geen enkele bevinding breekt de prijsregels. De belangrijkste open punten:
  - de links naar de voorwaarden en het privacybeleid zijn te kleine tikdoelen (16 pt);
  - "Code vervangen" staat nog op de pagina Huishouden;
  - drie rode labels op Huishouden;
  - een witte focusring in donkere modus, mogelijk alleen op het web;
  - de bovenrand van het winkelvenster snijdt de kop door (iPhone);
  - de design-spec is op enkele teksten verouderd ("Nog niet beschikbaar", "2×").
- **Beperking:** de screenshots van Listonic en Mandje konden niet worden bekeken, omdat de afbeeldingsserver van Apple via de proxy een 403 gaf. De vergelijking is gebaseerd op tekstbronnen: de bijschriften bij de screenshots, de App Store-teksten en -reviews, en een review op ID.nl.

---

## 6. Bewust uitgesteld (niet in v1)

- Routes langs 2 of 3 winkels, en abonnementen.
- Echte prijsdata. De eerste kandidaat is een B2B-feed (bijvoorbeeld Supermarktscanner.nl) met EAN, inhoud, `observed_at` en het recht om door te leveren. Open Prices kan later als aanvullende bron dienen, maar dan met vermelding van datum en bron.
- Een specifiek product kiezen of een productcatalogus doorzoeken, een winkelkiezer, de instelling "Ik heb een bonuskaart", kaarten en afstanden.
- Meerdere lijsten of huishoudens per gebruiker, en meerdere eigenaren.
- Accounts koppelen (Apple en Google voor één persoon), magische links, en bewerken als gast zonder account.
- Categorieën en winkelvolgorde (kandidaat voor v1.1), slepen, een stepper in de rij, vegen om af te vinken, en lang drukken.
- Recepten, AI-lijsten, spraak, foto's en kassabonnen scannen.
- Aanbiedingen, prijsalerts en pushmeldingen.
- De HTTPS-pagina voor uitnodigingslinks (met de code en knoppen naar de app-winkels).
- De open visuele punten uit ronde 5 (8 Minor, 13 Nit). Ze zijn nog niet opgelost.

---

## 7. Besluiten en waarom

| Besluit | Waarom |
|---|---|
| **De server bepaalt de volgorde** bij conflicten. `apply_mutations` geeft elke wijziging een volgnummer. Verwijderen wint, "+1" telt als verschil, en voor elk veld wint de laatste wijziging in serverbeurt | Dit is voorspelbaar en hetzelfde op elk toestel. Klokken van telefoons lopen niet gelijk, dus "laatste tijd" zou willekeurig zijn. Er gaan geen ophogingen verloren |
| **Eerst de wachtrij, dan het scherm.** De outbox staat in SQLite, er is één bestand per gebruiker, en elke wijziging heeft een eigen uuid | Een offline wijziging kan zo niet verdwijnen bij een crash of herstart, en dubbel versturen is onschuldig |
| **Realtime is alleen een seintje**; de gegevens komen altijd uit `pull_changes` | Een gemist of dubbel bericht verandert de uitkomst niet. Realtime blijft gefilterd door RLS |
| **Geen directe schrijfrechten voor de app.** Alles loopt via RPC's, RLS staat op elke tabel en `anon` heeft geen rechten | Er is één plek waar regels en lidmaatschap worden gecontroleerd. Zo is de scheiding tussen huishoudens te bewijzen met tests |
| **Bij e-mail alleen een 6-cijferige code**, geen magische link | Een code werkt ook als je de mail op een ander apparaat leest en hoeft de app niet via een link te openen. Een link in een mail is ook makkelijker na te maken (phishing) |
| **Accounts nooit samenvoegen op e-mailadres** | Een overname via een gedeeld of hergebruikt e-mailadres wordt zo voorkomen. Koppelen kan later met een bevestiging |
| **Automatisch een huishouden "Thuis"** en uitnodigen met link en code (6 tekens, 7 dagen geldig, beperkt aantal pogingen) | Je hoeft nooit eerst iets in te stellen ("de gedeelde lijst eerst"). Wie lid wordt, neemt de items uit zijn eigen solo-lijst mee naar de gedeelde lijst |
| **Lokale gegevens wissen** bij uitloggen, vertrekken en verwijderd worden | Op een gedeelde of doorgegeven telefoon blijft geen lijst van een ander huishouden achter |
| **Geen prijzen tonen zonder licentie.** Open Prices staat erin als bron, maar als "niet geverifieerd". Scraping en onofficiële API's zijn uitgesloten | Een verkeerde vergelijking is erger dan geen vergelijking. Er is vandaag geen legale bron met een actuele Nederlandse dekking |
| **Alleen complete mandjes bij één winkel rangschikken.** Een prijs van 7 tot 14 dagen oud telt mee met een label; ouder is onbekend | Een onvolledig mandje lijkt anders goedkoper dan het is (in de testfixture zou "Oost" bovenaan staan). Een eerlijke vergelijking gaat boven een volledige |
| **Prijsvergelijking is opt-in** en er zijn geen aanbiedingen | De lijst is het product. De prijstab mag de lijst niet drukker maken |
| **De web-export gebruikt een demo-backend** en is alleen bedoeld om te kijken. Een build voor een toestel zonder Supabase-configuratie stopt met een foutmelding | Er is nooit stil een terugval op nepgegevens in een echte build |
| **Het werk staat op `integration/v1`, nog niet op `main`** | Samenvoegen is een keuze voor de eigenaar, na een test op een toestel |
