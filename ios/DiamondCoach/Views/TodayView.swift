import SwiftUI

/// Today's sessions. Tap one to check athletes in.
struct TodayView: View {
    @State private var date = Date()
    @State private var agenda: Agenda?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                DatePicker("Day", selection: $date, displayedComponents: .date)
                    .listRowBackground(Theme.surface)
                if let error { Text(error).foregroundStyle(Theme.amber).listRowBackground(Theme.surface) }
                if let agenda {
                    if agenda.sessions.isEmpty {
                        Text("Nothing on the schedule.").foregroundStyle(Theme.muted).listRowBackground(Theme.surface)
                    }
                    ForEach(agenda.sessions) { s in
                        NavigationLink(value: s.id) { SessionRow(session: s) }
                            .listRowBackground(Theme.surface)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle("Today")
            .navigationDestination(for: String.self) { RosterView(sessionId: $0) }
            .refreshable { await load() }
            .task(id: date) { await load() }
        }
    }

    private func load() async {
        do { agenda = try await API.shared.agenda(date: date); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct SessionRow: View {
    let session: SessionDetail
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(session.start.formatted(date: .omitted, time: .shortened))
                .font(Theme.display(20)).foregroundStyle(Theme.steel).frame(width: 84, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.name).font(.headline)
                Text("\(session.locationName) · \(session.team != nil ? "\(session.team!.athletes.filter(\.present).count)/\(session.team!.athletes.count) here" : "\(session.attendedCount)/\(session.bookedCount) here")")
                    .font(.caption).foregroundStyle(Theme.muted)
            }
            Spacer()
            if session.unpaidCount > 0 { Text("\(session.unpaidCount) unpaid").font(.caption.bold()).foregroundStyle(Theme.amber) }
        }
        .padding(.vertical, 4)
    }
}

/// One session: check athletes in, see medical flags, collect for anyone unpaid.
struct RosterView: View {
    let sessionId: String
    @EnvironmentObject var session: Session
    @ObservedObject private var tap = TapToPay.shared
    @State private var detail: SessionDetail?
    @State private var message: String?
    @State private var collecting: RosterEntry?
    @State private var waitingSale: Sale?

    var body: some View {
        List {
            if let d = detail {
                Section {
                    Text("\(d.start.formatted(date: .omitted, time: .shortened))–\(d.end.formatted(date: .omitted, time: .shortened)) · \(d.locationName)").foregroundStyle(Theme.muted)
                }.listRowBackground(Theme.surface)
                if let team = d.team {
                    Section {
                        ForEach(team.athletes) { a in
                            CheckRow(name: a.name, detail: [a.athleteId, a.position].compactMap { $0 }.joined(separator: " · "), present: a.present) {
                                await run { try await API.shared.setTeamAttendance(sessionId: d.id, rosterId: a.id, present: !a.present) }
                            }
                        }
                        if team.athletes.contains(where: { !$0.present }) {
                            Button("Everyone's here") { Task { await everyoneHere(team) } }.foregroundStyle(Theme.greenBright)
                        }
                    } header: { Text("\(team.orgName) \(team.teamName)") }
                    .listRowBackground(Theme.surface)
                }
                let active = d.roster.filter(\.isActive)
                if !active.isEmpty || d.team == nil {
                    Section {
                        ForEach(active) { r in
                            CheckRow(name: r.name,
                                     detail: [r.age.map { "Age \($0)" }, coverageLabel(r.coverage), r.parentPhone].compactMap { $0 }.joined(separator: " · "),
                                     present: r.status == "attended", warning: r.hasMedicalNotes ? "Medical notes on file" : nil,
                                     trailing: r.coverage == "unpaid" ? AnyView(Button("Collect") { collecting = r }.buttonStyle(.bordered).tint(Theme.amber)) : nil) {
                                await run { try await API.shared.setAttendance(bookingId: r.id, present: r.status != "attended") }
                            }
                        }
                        if active.isEmpty { Text("Nobody booked yet.").foregroundStyle(Theme.muted) }
                    } header: { Text("Roster · \(d.bookedCount)/\(d.capacity)") }
                    .listRowBackground(Theme.surface)
                }
                let waiting = d.roster.filter { $0.status == "waitlisted" }
                if !waiting.isEmpty {
                    Section("Waitlist") { ForEach(waiting) { Text($0.name) } }.listRowBackground(Theme.surface)
                }
            } else {
                ProgressView().listRowBackground(Theme.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .navigationTitle(detail?.name ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Collect for \(collecting?.name ?? "")", isPresented: Binding(get: { collecting != nil }, set: { if !$0 { collecting = nil } }), titleVisibility: .visible) {
            Button("Tap to Pay") { if let r = collecting { Task { await collect(r, method: "tap_to_pay") } } }
            Button("Card on file") { if let r = collecting { Task { await collect(r, method: "card_on_file") } } }
            Button("Cash") { if let r = collecting { Task { await collect(r, method: "cash") } } }
        }
        .sheet(item: $waitingSale) { sale in TapSheet(sale: sale) { await finish(sale) } }
        .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) { Button("OK") {} }
    }

    private func coverageLabel(_ c: String) -> String {
        ["membership": "Member", "credit": "Credit", "paid": "Paid", "registration": "Registered", "unpaid": "Unpaid", "none": ""][c] ?? c
    }
    private func load() async {
        do { detail = try await API.shared.session(sessionId) } catch { message = error.localizedDescription }
    }
    private func run(_ action: () async throws -> Void) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do { try await action(); await load() } catch { message = error.localizedDescription }
    }
    private func everyoneHere(_ team: TeamRoster) async {
        guard let d = detail else { return }
        for a in team.athletes where !a.present { try? await API.shared.setTeamAttendance(sessionId: d.id, rosterId: a.id, present: true) }
        await load()
    }
    // The booking is marked paid on the server when the sale completes.
    private func collect(_ r: RosterEntry, method: String) async {
        collecting = nil
        do {
            let sale = try await API.shared.payBooking(r.id, method: method)
            switch sale.status {
            case "succeeded": message = "\(money(sale.amountCents)) collected from \(r.name)."; await load()
            case "pending": waitingSale = sale
            default: message = sale.failureReason ?? "The payment didn't go through."
            }
        } catch { message = error.localizedDescription }
    }
    private func finish(_ sale: Sale) async {
        waitingSale = nil
        if let latest = try? await API.shared.sync(sale.id), latest.status == "succeeded" { message = "\(money(latest.amountCents)) paid." }
        await load()
    }
}

/// A tap-to-check-in row: the big button is the whole left side, easy to hit at a busy session.
struct CheckRow: View {
    let name: String
    let detail: String
    let present: Bool
    var warning: String? = nil
    var trailing: AnyView? = nil
    let toggle: () async -> Void
    @State private var busy = false

    var body: some View {
        HStack(spacing: 12) {
            Button { Task { busy = true; await toggle(); busy = false } } label: {
                Image(systemName: present ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 30)).foregroundStyle(present ? Theme.greenBright : Theme.muted)
            }
            .buttonStyle(.plain).disabled(busy)
            .accessibilityLabel(present ? "\(name), checked in. Tap to undo." : "Check in \(name)")
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.headline)
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(Theme.muted) }
                if let warning { Label(warning, systemImage: "cross.case.fill").font(.caption).foregroundStyle(Theme.amber) }
            }
            Spacer()
            if let trailing { trailing }
        }
        .padding(.vertical, 4)
    }
}

/// Waiting for the athlete's parent to tap a card on this iPhone.
struct TapSheet: View {
    let sale: Sale
    let done: () async -> Void
    @EnvironmentObject var session: Session
    @ObservedObject private var tap = TapToPay.shared
    @State private var error: String?

    var body: some View {
        VStack(spacing: 20) {
            Text(money(sale.amountCents)).font(Theme.display(48)).foregroundStyle(Theme.steel).padding(.top, 32)
            Image(systemName: "wave.3.right").font(.system(size: 56)).foregroundStyle(Theme.greenBright)
            Text(tap.prompt ?? "Hold card or phone near the top of this iPhone").font(.headline).multilineTextAlignment(.center)
            if let error { Text(error).foregroundStyle(Theme.amber) }
            if session.payments?.canSimulate == true {
                Button("Simulate approved tap") { Task { _ = try? await API.shared.simulate(sale.id, approved: true); await done() } }.buttonStyle(PrimaryButton())
            }
            Button("Cancel") { Task { _ = try? await API.shared.cancel(sale.id); await done() } }.foregroundStyle(Theme.muted)
            Spacer()
        }
        .padding(20)
        .background(Theme.ground.ignoresSafeArea())
        .task {
            guard session.payments?.provider == "stripe", let info = sale.tapToPay, let ref = info.locationRef else { return }
            do { try await tap.collect(clientSecret: info.clientSecret, locationRef: ref); await done() }
            catch { self.error = error.localizedDescription; _ = try? await API.shared.cancel(sale.id) }
        }
    }
}

extension Sale: Hashable {
    static func == (a: Sale, b: Sale) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}
