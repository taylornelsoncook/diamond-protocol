import SwiftUI

struct ClientsView: View {
    @EnvironmentObject var session: Session
    @State private var search = ""
    @State private var result: String?

    private var shown: [ClientSummary] {
        search.isEmpty ? session.clients : session.clients.filter { $0.name.localizedCaseInsensitiveContains(search) || ($0.email ?? "").localizedCaseInsensitiveContains(search) || ($0.athleteId ?? "").localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            List(shown) { c in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.name).font(.headline)
                        if let id = c.athleteId { Text(id).font(.caption.monospaced()).foregroundStyle(Theme.muted) }
                        Text(c.isMember ? "Member" + (c.sessionCredits > 0 ? " · \(c.sessionCredits) banked" : "") : "\(c.sessionCredits) sessions left")
                            .font(.caption).foregroundStyle(c.isMember || c.sessionCredits > 0 ? Theme.muted : Theme.amber)
                    }
                    Spacer()
                    Button("Check in") { Task { await checkIn(c) } }
                        .buttonStyle(.bordered).disabled(session.location == nil)
                }
                .listRowBackground(Theme.surface)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .searchable(text: $search, prompt: "Name, athlete ID or email")
            .navigationTitle(session.location?.name ?? "Clients")
            .refreshable { await session.refresh() }
            .alert(result ?? "", isPresented: Binding(get: { result != nil }, set: { if !$0 { result = nil } })) { Button("OK") {} }
        }
    }

    private func checkIn(_ c: ClientSummary) async {
        guard let loc = session.location else { return }
        do {
            let r = try await API.shared.checkIn(clientId: c.id, locationId: loc.id)
            result = r.coveredBy == "membership" ? "\(c.firstName) checked in." : "\(c.firstName) checked in. \(r.creditsLeft) sessions left."
            await session.refresh()
        } catch { result = error.localizedDescription }
    }
}
