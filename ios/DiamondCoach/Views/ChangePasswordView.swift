import SwiftUI

/// Shown when staff sign in with a one-time password: they choose their own before doing anything else.
struct ChangePasswordView: View {
    @EnvironmentObject var session: Session
    @State private var current = ""
    @State private var new = ""
    @State private var again = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image("Mark").resizable().scaledToFit().frame(width: 100).padding(.top, 40)
                Text("CHOOSE YOUR PASSWORD").font(Theme.display(26)).tracking(1.5).foregroundStyle(Theme.steel)
                Text("You signed in with a one-time password. Choose one only you know, 10 or more characters.")
                    .font(.callout).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                Panel {
                    SecureField("One-time password", text: $current).textContentType(.password)
                    Divider()
                    SecureField("New password", text: $new).textContentType(.newPassword)
                    Divider()
                    SecureField("New password again", text: $again).textContentType(.newPassword)
                }
                if let error { Text(error).foregroundStyle(Theme.amber).font(.callout) }
                Button(busy ? "Saving…" : "Save password") { Task { await save() } }
                    .buttonStyle(PrimaryButton()).disabled(busy || new.count < 10 || current.isEmpty)
                Button("Sign out") { session.signOut() }.foregroundStyle(Theme.muted)
            }
            .padding(20)
        }
        .background(Theme.black.ignoresSafeArea())
    }

    private func save() async {
        guard new == again else { error = "The new passwords don't match."; return }
        busy = true; defer { busy = false }
        do { try await API.shared.changePassword(current: current, new: new); await session.passwordChanged() }
        catch { self.error = error.localizedDescription }
    }
}
