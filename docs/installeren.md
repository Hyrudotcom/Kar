# Kar op jullie telefoons krijgen

Twee telefoons, twee routes: een Android-APK voor Jamie (direct te installeren) en TestFlight voor de iPhone (daar is een Apple Developer-account voor nodig). Dit document is de volgorde om het voor elkaar te krijgen.

## Stap 1: een echte Supabase (de backend, gratis)

De app praat nu alleen met een lokale testdatabase. Voor telefoons is een gehoste Supabase nodig.

1. Maak een account op [supabase.com](https://supabase.com) en maak een nieuw project (regio West-EU, gratis tier is genoeg). Bewaar het databasewachtwoord.
2. Zet het schema erop vanaf een computer met deze repo:
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>   # ref staat in de project-URL
   npx supabase db push                            # zet alle migraties op het project
   ```
3. In het Supabase-dashboard, onder **Authentication → Providers**: e-mail aanzetten, en "Confirm email" via een 6-cijferige OTP-code (de mailtemplate staat in `supabase/templates/otp.html`). Apple en Google kunnen later (stap 4).
4. Noteer uit **Settings → API**: de **Project URL** en de **anon key**. Die zijn niet geheim (ze zitten in elke app-build), maar hoor bij elkaar.

## Stap 2: Expo-account en EAS (de app-builds, gratis tier volstaat)

1. Maak een account op [expo.dev](https://expo.dev).
2. Vanaf een computer met deze repo:
   ```bash
   npm install
   npx eas login
   npx eas init          # koppelt dit project aan je Expo-account (schrijft projectId in app.json)
   ```
3. Vul in `eas.json` bij beide profielen de twee lege velden in: `EXPO_PUBLIC_SUPABASE_URL` en `EXPO_PUBLIC_SUPABASE_ANON_KEY` uit stap 1 (of zet ze als EAS-omgevingsvariabelen in het Expo-dashboard, dan blijven ze uit git).

## Stap 3: builds maken

**Android (Jamie):**
```bash
npx eas build --profile preview --platform android
```
Dit bouwt in de cloud van Expo een APK. Na afloop krijg je een link; die stuur je naar Jamie. Op de Android-telefoon: link openen, APK downloaden en installeren ("onbekende apps toestaan" eenmalig aanzetten). Klaar.

**iPhone (hyru), nette route — TestFlight:**
1. Dit vereist een [Apple Developer-account](https://developer.apple.com/programs/) (99 dollar per jaar, goedkeuring kan 1 à 2 dagen duren).
2. Daarna:
   ```bash
   npx eas build --profile production --platform ios
   npx eas submit --platform ios
   ```
   EAS regelt certificaten en profielen zelf (inloggen met je Apple ID als het erom vraagt).
3. In [App Store Connect](https://appstoreconnect.apple.com) verschijnt de build onder TestFlight. Voeg jezelf (en Jamie's e-mail desnoods) toe als interne tester; je krijgt een uitnodiging in de TestFlight-app.

**iPhone zonder Developer-account (tijdelijke smaak):** met een Mac en Xcode kan een gratis Apple ID de app via een kabel installeren, maar die verloopt elke 7 dagen. Of test eerst samen via **Expo Go**: `npx expo start` op een computer in hetzelfde wifi-netwerk, QR-code scannen met de Expo Go-app. Let op: in Expo Go werkt inloggen met e-mailcode, maar Apple-login en de echte deep links niet.

## Stap 4: later (niet nodig voor de eerste test)

- **Apple- en Google-login:** client-id's aanmaken (Apple Services ID, Google OAuth voor iOS/Android) en invullen in Supabase Auth en als `EXPO_PUBLIC_GOOGLE_*`-variabelen. Tot die tijd werkt de 6-cijferige e-mailcode.
- **E-mail:** het gratis Supabase-mailkanaal is beperkt (ca. 2 per uur). Voor echt gebruik een SMTP-provider koppelen (bijv. Resend of Postmark) onder Authentication → SMTP.
- **Domein:** `getkar.nl` is nu een placeholder voor uitnodigingslinks. Zodra er een echt domein is: aanpassen in `app.json`, `src/contracts/domain.ts`, `src/lib/legal.ts` en de invite-RPC, en de AASA/assetlinks-bestanden hosten voor universal links. De code in de uitnodiging intypen werkt ook zonder domein.

## Wat Claude hiervan kan overnemen

Vanuit de cloudsessie zijn expo.dev en supabase.com nu niet bereikbaar (netwerkbeleid van de standaardomgeving). Met een eigen cloudomgeving met ruimere netwerktoegang plus een `EXPO_TOKEN` en `SUPABASE_ACCESS_TOKEN` als secrets kan Claude stap 1 t/m 3 (behalve de Apple-betaling en het installeren zelf) uitvoeren.
