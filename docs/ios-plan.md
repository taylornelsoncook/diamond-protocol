# The iPhone app in a month: the plan

The owner is cleared for the Apple Developer Program and wants the app on iOS, fully working, within a month, with a simpler and more streamlined experience. This is the plan, written so the owner can decide the few things only they can decide, and so the work can start the day they answer.

## The recommendation in one paragraph

Ship **one app for families and athletes first**, called **Diamond Protocol**: a native Swift shell around the portal and the athlete app that already run on phones, with the things a website can't do on an iPhone added natively: real push notifications (no "add to home screen" dance), the camera for form checks and sprint clips, Face ID to reopen, the app icon on the home screen and a place on the App Store. It opens straight on today's workout with four tabs: **Today, Progress, Book, Family**. The coach's Tap to Pay app (`ios/`, already written in Swift) is the **second** app, after this one is live, because it needs a Mac for every test and Apple's Tap to Pay entitlement, and only staff use it.

Why a shell and not a from-scratch native app: everything athletes and parents do already works in the web app, is tested (875 tests) and changes weekly as the owner asks. A native rewrite would mean building and keeping two copies of every screen. The shell gives the native feel where it matters (the icon, notifications, the camera, speed) and keeps one codebase. Many gym and team apps on the App Store are built exactly this way.

The honest risk: Apple's reviewers reject apps that are "just a website" (guideline 4.2). The shell avoids that by being a real client of a real business with native notifications, camera, Face ID, offline loading of the shell, a native tab bar and a demo account for the reviewer, which is what gets these apps approved. If a reviewer still objects, the answer is a native Today tab (one screen, built in Swift against the same API), which is the week-5 fallback, not the plan.

## What the owner decides or does (the rest is on me)

1. **Which app first.** The recommendation above is the family and athlete app. Say "coach app first" to flip it.
2. **The name and the icon.** "Diamond Protocol" with the diamond mark (`public/brand/logo.png`); Apple needs it at 1024×1024 with no transparency. Bundle ID `com.diamondprotocol.app` (the coach app keeps `com.diamondprotocol.coach`).
3. **In App Store Connect** (a browser, 15 minutes): create the app record with that bundle ID, and turn on **Xcode Cloud** for the GitHub repository. Xcode Cloud is Apple's own build service: it builds from the repo, signs with your team's certificates automatically, and puts builds on TestFlight. That means **no Mac is needed to build or ship**, and I can fix compile errors from here by pushing to the repo and reading the build log. (A GitHub Actions macOS job will also compile the app on every push, without signing, so I get fast compile feedback.)
4. **Push notifications key:** in the developer portal, Keys → make an APNs key (.p8). Put it in Render as `APNS_KEY` (the file's text), `APNS_KEY_ID` and `APNS_TEAM_ID`. Never paste it in chat.
5. **A demo account for Apple's reviewer**: a family on production with made-up names (I'll make it; you approve the names) so the reviewer can sign in without a code arriving at a real inbox. Reviewers refuse apps they can't get into.
6. **Who tests on TestFlight:** your own phone, the coaches, and three or four families who'll tell you the truth.
7. **For the coach app later:** a Mac with Xcode (CHECKLIST.md already lists it) and the Tap to Pay entitlement request.

## The month

**Week 1: foundations.** Decisions above; the app record and Xcode Cloud; the Swift shell in `ios/DiamondProtocol/` (SwiftUI, zero packages): a tab bar whose tabs open the right pages, a web view with the session cookie kept between launches, pull-to-refresh, the offline "no signal" screen, external links (Stripe's card page, YouTube) opening in Safari's sheet, universal links so `app.diamondprotocol.org/client`, pay links and open-spot links open in the app. The web side gets a `native` mode: the pages hide the duplicated top bar and tab bar when inside the app and send the shell the page title and badge counts. Compile check in CI. First TestFlight build to the owner by the end of the week.

**Week 2: the native pieces.** Push notifications through Apple (APNs) on the server: a device table, `POST /app/api/push/apns` and the portal equivalent to register a phone, an APNs sender in plain Node (HTTP/2, token signed with the .p8), and the same privacy rule as today's web push: nothing personal travels through Apple, the app fetches what's new when the notification is tapped. The camera and photo library for form checks, sprint clips and the whiteboard photo (the web view's file picker, with the camera offered first). Face ID to reopen the app (optional, on by default for athletes under a parent's account). The streamlined home: open on today's workout, one tap to start, the week strip, the game-week banner; everything else a tab away. Second TestFlight build to coaches and the first families.

**Week 3: polish and the listing.** Fix what the testers find. App Store listing: name, subtitle, description, keywords, 6.7" and 6.1" screenshots (I'll produce them from the app), the privacy "nutrition label" (what we collect, from the privacy policy), age rating, support and privacy URLs (`/privacy` is already live), review notes with the demo account. Accessibility pass (Dynamic Type, VoiceOver labels on the tab bar). Third TestFlight build.

**Week 4: submit.** Submit for review early in the week; Apple usually answers in one to three days. If they ask for changes, the week absorbs one round. Release. Then the coach app starts: compile `ios/DiamondCoach` on a Mac, the Tap to Pay entitlement, TestFlight to staff only.

## What "simpler and more streamlined" means here

- The app opens on **today's workout**, not a menu. Start workout is the one big button. The week strip, game-day banner and coach's note sit above it; everything else (games, form checks, sign-in, devices) stays under Profile as the owner already asked.
- **Four tabs** for a family: Today (the athlete's workout; a switcher at the top when there are two athletes), Progress (the Performance tab: tests, maxes, volume, timeline), Book (the schedule and the family's sessions), Family (membership, card, payments, parents, the waiver). An athlete signing in on their own sees Today, Progress, Profile.
- **Sign in once.** The emailed code is still the first sign-in; after that the app keeps the session and Face ID reopens it. No password to remember.
- **Notifications that mean something:** the morning workout reminder, a coach's message or form-check answer, a spot opening up, a payment that didn't go through. Each opens the right screen.
- **No duplicated chrome:** inside the app the pages drop their own tab bars and brand header; the native bar carries them.

## What stays as it is

The web portal keeps working for everyone without the app (and on Android). The coach dashboard stays a website: it's used on laptops and iPads, and the coach's phone app is the Tap to Pay one. The server keeps zero dependencies; the Swift shell has none either (Stripe Terminal is only in the coach app).

## The order of work on my side, once the owner answers 1 to 3

1. `ios/DiamondProtocol/` Swift shell + `project.yml` + the GitHub Actions compile job (macOS runner, no signing).
2. The web pages' `native` mode (a query flag the shell adds; hides duplicated chrome, posts titles and badges).
3. Xcode Cloud workflow file and the first TestFlight build.
4. APNs on the server (tables, routes, sender, tests), the shell's registration and notification routing.
5. Camera, Face ID, universal links, the no-signal screen.
6. Listing assets and the review notes.
