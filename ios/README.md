# DP Coach: the iPhone app

Your pocket point of sale. Sign in, pick where you are and who you're with, tap the products, and hand the client your iPhone to tap their card or phone. Sessions land on their account, the card can be saved for their membership, and everything shows up in the web dashboard.

**Screens:**
- **Today:** today's sessions (or any day). Open one for its roster: tap to check athletes in, medical flags, parent phone numbers, and Collect for unpaid bookings by Tap to Pay, card on file or cash. Team sessions show the team roster with "Everyone's here".
- **Charge:** Tap to Pay, card on file, cash.
- **Testing:** testing days from the dashboard. A big stopwatch saves the time to the athlete's next attempt (marked hand-timed) and moves to the next athlete; type in gate times, jumps and measurements; left and right sides; Undo for a stray tap.
- **Clients:** search by name, Athlete ID or email, and check in.
- **Settings:** your role, payment mode, simulated reader, sign out.

Staff added with a one-time password choose their own on first sign-in, right in the app. What each person can do follows their role (Owner, Coach, Front desk).

The app hasn't been compiled yet. `test/ios-contract.test.js` checks every field it reads against the real server, so the first build should only need Swift fixes, not server changes.

## Build it

You need a Mac with Xcode 16 or newer and an Apple Developer account.

1. Install XcodeGen: `brew install xcodegen`
2. In this `ios` folder, run `xcodegen`. This creates `DiamondCoach.xcodeproj` and pulls in Stripe's Terminal SDK.
3. Open the project. Under Signing & Capabilities, choose your team. If you change the bundle ID from `com.diamondprotocol.coach`, use the same one in your Tap to Pay entitlement request.
4. Set `DPServerURL` in `Info.plist` to your server's address, or type it on the sign-in screen under "Server".

This code follows Stripe Terminal iOS SDK 5.x but hasn't been compiled yet. If Xcode flags a Stripe method or delegate name on the first build, accept its suggested fix; the flow stays the same. Claude Code on your Mac can do this for you.

## Test without real money

- **With the server in built-in test mode (no Stripe key):** charges show "Simulate approved tap" and "Simulate decline" buttons. This works in the iOS Simulator.
- **With Stripe test keys (`sk_test_...`):** turn on Settings → "Use simulated reader". Stripe's simulated Tap to Pay reader runs in the Simulator or on your iPhone before Apple approves your entitlement.
- **Real taps:** need the Apple Tap to Pay entitlement, a physical iPhone XS or newer, and simulated reader turned off. With `sk_test_` keys, use Stripe's physical test card, or a real card that won't be charged in test mode.

## Talking to your computer while testing

If the server runs on your Mac, use its local address on the same Wi-Fi, like `http://192.168.1.20:3000`. The app allows local-network addresses for testing. Everywhere else it requires https.
