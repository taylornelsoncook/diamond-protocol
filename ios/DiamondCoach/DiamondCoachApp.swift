import SwiftUI

@main
struct DiamondCoachApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            Group {
                if session.user == nil { LoginView() }
                else if session.user?.mustChangePassword == true { ChangePasswordView() }
                else { MainTabs() }
            }
            .environmentObject(session)
            .preferredColorScheme(.dark)
            .tint(Theme.green)
            .task { TapToPay.shared.initialize(); await session.restore() }
            .onReceive(NotificationCenter.default.publisher(for: .signedOut)) { _ in session.signOut() }
            .onReceive(NotificationCenter.default.publisher(for: .passwordChangeRequired)) { _ in session.user?.mustChangePassword = true }
        }
    }
}

/// Who is signed in, plus the lists every screen needs.
@MainActor
final class Session: ObservableObject {
    @Published var user: User?
    @Published var payments: Me.Payments?
    @Published var locations: [Location] = []
    @Published var products: [Product] = []
    @Published var clients: [ClientSummary] = []
    @Published var locationId: String = UserDefaults.standard.string(forKey: "locationId") ?? "" {
        didSet { UserDefaults.standard.set(locationId, forKey: "locationId") }
    }
    var location: Location? { locations.first { $0.id == locationId } }

    func restore() async {
        guard API.shared.token != nil, user == nil else { return }
        if let me = try? await API.shared.me() { user = me.user; payments = me.payments; if me.user.mustChangePassword != true { await refresh() } }
    }
    func signIn(email: String, password: String) async throws {
        user = try await API.shared.signIn(email: email, password: password)
        if user?.mustChangePassword == true { return }
        payments = try? await API.shared.me().payments
        await refresh()
    }
    func passwordChanged() async {
        if let me = try? await API.shared.me() { user = me.user; payments = me.payments }
        user?.mustChangePassword = false
        await refresh()
    }
    func refresh() async {
        async let l = API.shared.locations(), p = API.shared.products(), c = API.shared.clients()
        locations = (try? await l) ?? locations
        products = (try? await p) ?? products
        clients = ((try? await c) ?? clients).filter { $0.status != "canceled" }
        if location == nil { locationId = locations.first?.id ?? "" }
    }
    func signOut() {
        API.shared.token = nil
        user = nil
        Task { try? await TapToPay.shared.disconnect() }
    }
}

struct MainTabs: View {
    var body: some View {
        TabView {
            TodayView().tabItem { Label("Today", systemImage: "calendar") }
            ChargeView().tabItem { Label("Charge", systemImage: "wave.3.right.circle") }
            TestingView().tabItem { Label("Testing", systemImage: "stopwatch") }
            ClientsView().tabItem { Label("Clients", systemImage: "person.2") }
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
