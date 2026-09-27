import SwiftUI

struct LoginView: View {
    @EnvironmentObject var session: Session
    @State private var email = ""
    @State private var password = ""
    @State private var server = API.shared.baseURL.absoluteString
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image("Mark").resizable().scaledToFit().frame(width: 140).padding(.top, 40)
                Text("DIAMOND PROTOCOL").font(Theme.display(28)).tracking(2).foregroundStyle(Theme.steel)
                Text("BUILT UNDER PRESSURE").font(.caption).tracking(3).foregroundStyle(Theme.muted)
                Panel {
                    TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    Divider()
                    SecureField("Password", text: $password).textContentType(.password)
                }
                DisclosureGroup("Server") {
                    TextField("https://app.diamondprotocol.com", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }.foregroundStyle(Theme.muted)
                if let error { Text(error).foregroundStyle(Theme.amber).font(.callout) }
                Button(busy ? "Signing in…" : "Sign in") { Task { await signIn() } }
                    .buttonStyle(PrimaryButton()).disabled(busy || email.isEmpty || password.isEmpty)
            }
            .padding(20)
        }
        .background(Theme.black.ignoresSafeArea())
    }

    private func signIn() async {
        busy = true; error = nil
        defer { busy = false }
        guard let url = URL(string: server.trimmingCharacters(in: .whitespaces)), url.scheme != nil else { error = "Enter the full server address, starting with https://."; return }
        API.shared.baseURL = url
        do { try await session.signIn(email: email, password: password) } catch { self.error = error.localizedDescription }
    }
}
