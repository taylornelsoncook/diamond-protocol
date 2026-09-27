import SwiftUI

/// Testing days. Pick one to run it from the field.
struct TestingView: View {
    @State private var days: [TestingDaySummary] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(Theme.amber).listRowBackground(Theme.surface) }
                if days.isEmpty && error == nil { Text("No testing days yet. Create one on the dashboard under Testing.").foregroundStyle(Theme.muted).listRowBackground(Theme.surface) }
                ForEach(days) { d in
                    NavigationLink(value: d.id) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.name).font(.headline)
                            Text("\(Day.pretty(d.date)) · \(d.athletesCount) athletes · \(d.resultsCount) results").font(.caption).foregroundStyle(Theme.muted)
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle("Testing")
            .navigationDestination(for: String.self) { TestingDayView(dayId: $0) }
            .refreshable { await load() }
            .task { await load() }
        }
    }
    private func load() async {
        do { days = try await API.shared.testingDays(); error = nil } catch { self.error = error.localizedDescription }
    }
}

/// Run one test at a time. Timed tests get a big stopwatch; everything else is typed in.
/// Stopping the clock saves the time to the athlete's next open attempt and moves to the next athlete.
struct TestingDayView: View {
    let dayId: String
    @State private var day: TestingDay?
    @State private var testKey = ""
    @State private var athleteIndex = 0
    @State private var side = "L"
    @State private var startedAt: Date?
    @State private var lastSaved: (id: String, text: String)?
    @State private var typed = ""
    @State private var message: String?
    @FocusState private var typing: Bool

    private var test: TestDef? { day?.tests.first { $0.key == testKey } }
    private var athletes: [TestingDay.DayAthlete] { day?.athletes ?? [] }
    private var current: TestingDay.DayAthlete? { athletes.indices.contains(athleteIndex) ? athletes[athleteIndex] : nil }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let day, let test {
                    Picker("Test", selection: $testKey) { ForEach(day.tests) { Text($0.shortName).tag($0.key) } }
                        .pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
                    if test.sides == "lr" {
                        Picker("Side", selection: $side) { Text("Left").tag("L"); Text("Right").tag("R") }.pickerStyle(.segmented)
                    }
                    entryPanel(test)
                    if let lastSaved {
                        HStack {
                            Label(lastSaved.text, systemImage: "checkmark.circle.fill").foregroundStyle(Theme.greenBright).font(.callout)
                            Spacer()
                            Button("Undo") { Task { await undo(lastSaved.id) } }.foregroundStyle(Theme.amber)
                        }
                        .padding(.horizontal, 4)
                    }
                    Panel {
                        Text("Athletes").font(.headline)
                        ForEach(Array(athletes.enumerated()), id: \.element.id) { i, a in
                            Button { if startedAt == nil { athleteIndex = i } } label: { athleteRow(a, test: test, selected: i == athleteIndex) }
                                .buttonStyle(.plain)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .padding(16)
        }
        .background(Theme.ground)
        .navigationTitle(day?.name ?? "Testing")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: testKey) { athleteIndex = 0; typed = "" }
        .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) { Button("OK") {} }
    }

    @ViewBuilder private func entryPanel(_ test: TestDef) -> some View {
        Panel {
            Text(current.map { "Up: \($0.name)" } ?? "Add athletes on the dashboard").font(.headline)
            if let a = current {
                Text("\(test.headline.name) · attempt \(min(results(a, test).count + 1, test.attempts)) of \(test.attempts)\(test.sides == "lr" ? " · \(side == "L" ? "left" : "right")" : "")")
                    .font(.caption).foregroundStyle(Theme.muted)
            }
            if test.timed {
                TimelineView(.animation(minimumInterval: 0.01, paused: startedAt == nil)) { _ in
                    Text(String(format: "%.2f", startedAt.map { Date().timeIntervalSince($0) } ?? 0))
                        .font(.system(size: 64, weight: .bold, design: .monospaced)).foregroundStyle(Theme.steel)
                        .frame(maxWidth: .infinity)
                }
                Button(startedAt == nil ? "Start" : "Stop") { Task { await startStop(test) } }
                    .buttonStyle(BigButton(color: startedAt == nil ? Theme.green : Theme.amber))
                    .disabled(current == nil)
                Text("Hand-timed. Times are saved as hand-timed so they're never mixed up with electronic gates.").font(.caption2).foregroundStyle(Theme.muted)
            }
            HStack {
                TextField(test.timed ? "Or type a time from gates" : "\(test.headline.name) (\(test.headline.unit))", text: $typed)
                    .keyboardType(.decimalPad).focused($typing)
                    .padding(12).background(Theme.ground).clipShape(RoundedRectangle(cornerRadius: 8))
                Button("Save") { Task { await saveTyped(test) } }.buttonStyle(.borderedProminent).disabled(Double(typed) == nil || current == nil)
            }
        }
    }

    private func athleteRow(_ a: TestingDay.DayAthlete, test: TestDef, selected: Bool) -> some View {
        let rs = results(a, test)
        let best: Double? = rs.isEmpty ? nil : (test.headline.better == "lower" ? rs.map(\.value).min() : rs.map(\.value).max())
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(a.name).font(.subheadline.bold()).foregroundStyle(selected ? Theme.greenBright : Theme.steel)
                Text(rs.isEmpty ? (a.athleteId ?? "") : rs.map { formatResult($0.value, unit: test.headline.unit, decimals: test.headline.decimals) + ($0.timing == "hand" ? "ʰ" : "") }.joined(separator: "  "))
                    .font(.caption).foregroundStyle(Theme.muted)
            }
            Spacer()
            if let best { Text(formatResult(best, unit: test.headline.unit, decimals: test.headline.decimals)).font(.headline) }
            if rs.count >= test.attempts { Image(systemName: "checkmark").foregroundStyle(Theme.greenBright) }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private func results(_ a: TestingDay.DayAthlete, _ test: TestDef) -> [TestingDay.DayResult] {
        a.results.filter { $0.testId == test.id && $0.metric == test.headline.key && (test.sides == "lr" ? $0.side == side : true) }
    }

    private func load() async {
        do {
            day = try await API.shared.testingDay(dayId)
            if testKey.isEmpty || !(day?.tests.contains { $0.key == testKey } ?? false) { testKey = day?.tests.first?.key ?? "" }
        } catch { message = error.localizedDescription }
    }

    private func startStop(_ test: TestDef) async {
        let haptic = UIImpactFeedbackGenerator(style: .heavy)
        if let start = startedAt {
            let secs = (Date().timeIntervalSince(start) * 100).rounded() / 100
            startedAt = nil
            haptic.impactOccurred()
            await save(test, value: secs, timing: "hand")
        } else {
            startedAt = Date()
            haptic.impactOccurred()
        }
    }
    private func saveTyped(_ test: TestDef) async {
        guard let v = Double(typed.replacingOccurrences(of: ",", with: ".")) else { return }
        await save(test, value: v, timing: test.timed ? "electronic" : nil)
        typed = ""; typing = false
    }
    private func save(_ test: TestDef, value: Double, timing: String?) async {
        guard let day, let a = current else { return }
        var r: [String: Any] = a.ref
        r["test"] = test.key; r["metric"] = test.headline.key; r["value"] = value; r["attempt"] = results(a, test).count + 1
        r["recorded_at"] = "\(day.date)T\(ISO.string(Date()).dropFirst(11))"
        if let timing { r["timing"] = timing }
        if test.sides == "lr" { r["side"] = side }
        do {
            let out = try await API.shared.recordResult(["session_id": day.id, "results": [r]])
            if let e = out.errors.first { message = e.message; return }
            let text = "\(a.name.components(separatedBy: " ").first ?? a.name): \(formatResult(value, unit: test.headline.unit, decimals: test.headline.decimals))\(out.prs.isEmpty ? "" : " · New PR!")"
            lastSaved = out.results.first.map { (id: $0.id, text: text) }
            UINotificationFeedbackGenerator().notificationOccurred(out.prs.isEmpty ? .success : .warning)
            let done = results(a, test).count + 1 >= test.attempts
            await load()
            if done, athleteIndex < athletes.count - 1 { athleteIndex += 1 }
        } catch { message = error.localizedDescription }
    }
    private func undo(_ id: String) async {
        do { try await API.shared.deleteResult(id); lastSaved = nil; await load() } catch { message = error.localizedDescription }
    }
}

struct BigButton: ButtonStyle {
    let color: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 30, weight: .bold))
            .frame(maxWidth: .infinity, minHeight: 96)
            .background(color.opacity(configuration.isPressed ? 0.75 : 1))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}
