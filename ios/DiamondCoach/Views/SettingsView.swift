import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var session: Session
    @ObservedObject private var tap = TapToPay.shared

    var body: some View {
        NavigationStack {
            Form {
                Section("Signed in") {
                    Text(session.user?.name ?? "")
                    Text(session.user?.roleName ?? "").foregroundStyle(Theme.muted)
                    Text(session.user?.email ?? "").foregroundStyle(Theme.muted)
                    Text(API.shared.baseURL.absoluteString).font(.caption).foregroundStyle(Theme.muted)
                }
                Section("Payments") {
                    LabeledContent("Mode", value: session.payments.map { $0.provider == "stripe" ? ($0.live ? "Live" : "Stripe test") : "Built-in test" } ?? "—")
                    LabeledContent("Tap to Pay", value: tap.status)
                    Toggle("Use simulated reader", isOn: $tap.simulated)
                    Text("Turn this on to test with Stripe test keys or in the Simulator. Turn it off to take real taps.").font(.caption).foregroundStyle(Theme.muted)
                }
                Section { Button("Sign out", role: .destructive) { session.signOut() } }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle("Settings")
        }
    }
}
