import SwiftUI

/// The pocket point of sale: pick a place, a client and what they're buying, then tap to pay.
struct ChargeView: View {
    @EnvironmentObject var session: Session
    @ObservedObject private var tap = TapToPay.shared
    @State private var clientId = ""
    @State private var cart: [String: Int] = [:]
    @State private var method = "tap_to_pay"
    @State private var saveCard = true
    @State private var stage: Stage = .idle
    @State private var message: String?

    enum Stage: Equatable { case idle, starting, waiting(String), done(String), failed(String) }

    private var client: ClientSummary? { session.clients.first { $0.id == clientId } }
    private var total: Int { cart.reduce(0) { t, e in t + (session.products.first { $0.id == e.key }?.priceCents ?? 0) * e.value } }
    private var busy: Bool { if case .starting = stage { return true }; if case .waiting = stage { return true }; return false }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Panel {
                        Picker("Where", selection: $session.locationId) {
                            ForEach(session.locations) { Text($0.name).tag($0.id) }
                        }
                        Picker("Who", selection: $clientId) {
                            Text("Walk-in").tag("")
                            ForEach(session.clients) { c in Text(c.sessionCredits > 0 ? "\(c.name) · \(c.sessionCredits) left" : c.name).tag(c.id) }
                        }
                    }
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(session.products) { p in
                            Button { cart[p.id, default: 0] += 1 } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(p.name).font(.subheadline.bold()).foregroundStyle(Theme.steel).multilineTextAlignment(.leading)
                                    Text(money(p.priceCents)).font(Theme.display(22)).foregroundStyle(Theme.greenBright)
                                    if p.kind == "pack" { Text("\(p.sessions) sessions").font(.caption).foregroundStyle(Theme.muted) }
                                }
                                .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
                                .padding(12).background(Theme.surface)
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(cart[p.id] != nil ? Theme.greenBright : Theme.line))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .accessibilityLabel("Add \(p.name), \(money(p.priceCents))")
                        }
                    }
                    if !cart.isEmpty { cartPanel }
                    statusPanel
                }
                .padding(16)
            }
            .background(Theme.ground)
            .navigationTitle("Charge")
            .refreshable { await session.refresh() }
            .task(id: session.locationId) {
                // Connect Tap to Pay in the background so the first tap is quick.
                if session.payments?.provider == "stripe" { await tap.prepare(locationRef: session.location?.stripeLocationId) }
            }
        }
    }

    private var cartPanel: some View {
        Panel {
            ForEach(cart.keys.sorted(), id: \.self) { id in
                if let p = session.products.first(where: { $0.id == id }) {
                    HStack {
                        Text(p.name).foregroundStyle(Theme.steel)
                        Spacer()
                        Stepper("\(cart[id] ?? 0)", value: Binding(get: { cart[id] ?? 0 }, set: { cart[id] = $0 > 0 ? $0 : nil }), in: 0...99).fixedSize()
                    }
                }
            }
            HStack { Text("Total").foregroundStyle(Theme.muted); Spacer(); Text(money(total)).font(Theme.display(40)).foregroundStyle(Theme.steel) }
            Picker("Payment", selection: $method) {
                Text("Tap to Pay").tag("tap_to_pay")
                if client?.hasCard == true { Text("Card on file").tag("card_on_file") }
                Text("Cash").tag("cash")
            }.pickerStyle(.segmented)
            if method == "tap_to_pay", let c = client {
                Toggle("Save card for \(c.firstName)'s future payments", isOn: $saveCard).font(.callout)
            }
            Button(method == "tap_to_pay" ? "Charge \(money(total))" : method == "cash" ? "Record \(money(total)) cash" : "Charge card on file") { Task { await charge() } }
                .buttonStyle(PrimaryButton()).disabled(busy || total == 0 || session.location == nil)
        }
    }

    @ViewBuilder private var statusPanel: some View {
        switch stage {
        case .idle: EmptyView()
        case .starting:
            Panel { ProgressView(tap.progress.map { _ in tap.status } ?? "Starting payment…", value: tap.progress) }
        case .waiting(let saleId):
            Panel {
                Image(systemName: "wave.3.right").font(.system(size: 44)).foregroundStyle(Theme.greenBright).frame(maxWidth: .infinity)
                Text(tap.prompt ?? "Hold card or phone near the top of this iPhone").font(.headline).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                if session.payments?.canSimulate == true {
                    Button("Simulate approved tap") { Task { await simulate(saleId, approved: true) } }
                    Button("Simulate decline") { Task { await simulate(saleId, approved: false) } }.foregroundStyle(Theme.muted)
                }
            }
        case .done(let text):
            Panel {
                Label(text, systemImage: "checkmark.seal.fill").font(.headline).foregroundStyle(Theme.greenBright)
                Button("New sale") { stage = .idle }.foregroundStyle(Theme.steel)
            }
        case .failed(let text):
            Panel {
                Label(text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.amber)
                Text("Nothing was charged.").font(.caption).foregroundStyle(Theme.muted)
                Button("Dismiss") { stage = .idle }.foregroundStyle(Theme.steel)
            }
        }
    }

    private func charge() async {
        guard let loc = session.location else { return }
        stage = .starting
        var body: [String: Any] = [
            "location_id": loc.id, "method": method,
            "items": cart.map { ["product_id": $0.key, "quantity": $0.value] }
        ]
        if !clientId.isEmpty { body["client_id"] = clientId; body["save_card"] = saveCard && method == "tap_to_pay" }
        var saleId: String?
        do {
            let sale: Sale = try await API.shared.request("POST", "v1/sales", body: body)
            saleId = sale.id
            guard sale.status == "pending", let info = sale.tapToPay else { return await finish(sale) }
            if session.payments?.provider != "stripe" {
                stage = .waiting(sale.id)          // server is in built-in test mode: use the simulate buttons
                return
            }
            guard let locationRef = info.locationRef else { throw APIError(message: "Add an address to \(loc.name) to take cards there.", status: 0) }
            stage = .waiting(sale.id)
            try await tap.collect(clientSecret: info.clientSecret, locationRef: locationRef)
            await finish(try await API.shared.sync(sale.id))
        } catch {
            if let saleId { _ = try? await API.shared.cancel(saleId) }
            stage = .failed(error.localizedDescription)
        }
    }

    private func simulate(_ saleId: String, approved: Bool) async {
        do { await finish(try await API.shared.simulate(saleId, approved: approved)) } catch { stage = .failed(error.localizedDescription) }
    }

    private func finish(_ sale: Sale, attempt: Int = 0) async {
        switch sale.status {
        case "succeeded":
            let card = sale.cardLast4.map { " with card ending \($0)" } ?? ""
            stage = .done("\(money(sale.amountCents)) paid\(card)")
            cart = [:]
            await session.refresh()
        case "pending":
            // The server hasn't heard from Stripe yet; check again shortly.
            guard attempt < 10 else { stage = .failed("Still waiting on the payment. Check Point of sale on the dashboard before charging again."); return }
            try? await Task.sleep(for: .seconds(2))
            if let latest = try? await API.shared.sync(sale.id) { await finish(latest, attempt: attempt + 1) }
        default:
            stage = .failed(sale.failureReason ?? "The payment was canceled.")
        }
    }
}
