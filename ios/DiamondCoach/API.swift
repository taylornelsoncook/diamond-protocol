import Foundation
import Security
import StripeTerminal

// MARK: - Models (match the Diamond Protocol API; JSON keys are snake_case)

struct ListResponse<T: Decodable>: Decodable { let data: [T] }

struct User: Decodable {
    let id: String; let email: String; let name: String
    var role: String? = nil
    var mustChangePassword: Bool? = nil
    var roleName: String { ["owner": "Owner", "coach": "Coach", "front_desk": "Front desk"][role ?? ""] ?? "Staff" }
}
struct TokenResponse: Decodable { let token: String; let user: User }
struct Me: Decodable {
    let user: User
    let payments: Payments
    struct Payments: Decodable { let provider: String; let live: Bool; let canSimulate: Bool }
}

struct Location: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let cardReady: Bool
    let stripeLocationId: String?
}

struct Product: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let priceCents: Int
    let sessions: Int
}

struct ClientSummary: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let email: String?          // athletes with a parent account have no email of their own
    let athleteId: String?
    let status: String
    let sessionCredits: Int
    let hasCard: Bool
    var firstName: String { name.components(separatedBy: " ").first ?? name }
    var isMember: Bool { ["active", "trialing", "past_due"].contains(status) }
}

struct Sale: Decodable, Identifiable {
    let id: String
    let status: String
    let method: String
    let amountCents: Int
    let cardBrand: String?
    let cardLast4: String?
    let failureReason: String?
    let tapToPay: TapToPayInfo?
    struct TapToPayInfo: Decodable { let clientSecret: String; let locationRef: String? }
}

struct CheckInResult: Decodable { let coveredBy: String; let creditsLeft: Int }

// MARK: - Schedule and rosters

struct Agenda: Decodable { let date: String; let timezone: String; let sessions: [SessionDetail] }
struct SessionDetail: Decodable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let startsAt: String
    let endsAt: String
    let locationName: String
    let capacity: Int
    let bookedCount: Int
    let attendedCount: Int
    let unpaidCount: Int
    let status: String
    let dropInCents: Int?
    var coachName: String? = nil      // who leads it (empty when no coach is set)
    let roster: [RosterEntry]
    let team: TeamRoster?
    var start: Date { ISO.date(startsAt) ?? .now }
    var end: Date { ISO.date(endsAt) ?? .now }
}
struct RosterEntry: Decodable, Identifiable {
    let id: String
    let status: String          // booked, attended, no_show, waitlisted, canceled, late_canceled
    let coverage: String        // membership, credit, paid, registration, unpaid, none
    let clientId: String
    let name: String
    let age: Int?
    let hasMedicalNotes: Bool
    let parentPhone: String?
    var isActive: Bool { ["booked", "attended", "no_show"].contains(status) }
}
struct TeamRoster: Decodable {
    let contractId: String
    let teamName: String
    let orgName: String
    let athletes: [TeamAthlete]
    struct TeamAthlete: Decodable, Identifiable { let id: String; let name: String; let athleteId: String?; let position: String?; let present: Bool }
}

// MARK: - Testing

struct TestDef: Decodable, Identifiable, Hashable {
    let id: String
    let key: String
    let name: String
    let category: String
    let sides: String           // none or lr
    let attempts: Int
    let timed: Bool
    let metrics: [Metric]
    struct Metric: Decodable, Hashable { let key: String; let name: String; let unit: String; let better: String; let decimals: Int }
    var headline: Metric { metrics[0] }
    var shortName: String { name.replacingOccurrences(of: #"\s*\(.*\)$"#, with: "", options: .regularExpression) }
}
struct TestingDaySummary: Decodable, Identifiable { let id: String; let name: String; let date: String; let tests: [String]; let athletesCount: Int; let resultsCount: Int }
struct TestingDay: Decodable {
    let id: String
    let name: String
    let date: String
    let tests: [TestDef]
    let athletes: [DayAthlete]
    struct DayAthlete: Decodable, Identifiable {
        let clientId: String?
        let rosterId: String?
        let name: String
        let athleteId: String?
        let results: [DayResult]
        var id: String { clientId ?? rosterId ?? name }
        var ref: [String: Any] { clientId.map { ["client_id": $0] } ?? ["roster_id": rosterId ?? ""] }
    }
    struct DayResult: Decodable, Identifiable { let id: String; let testId: String; let metric: String; let side: String?; let attempt: Int?; let value: Double; let timing: String? }
}
struct RecordResponse: Decodable {
    let created: Int
    let errors: [Problem]
    let prs: [PR]
    let results: [Saved]
    struct Problem: Decodable { let message: String }
    struct PR: Decodable { let value: Double }
    struct Saved: Decodable { let id: String }
}

func formatResult(_ value: Double, unit: String, decimals: Int) -> String {
    if unit == "in" && value >= 48 { let ft = Int(value / 12); let inch = value - Double(ft * 12); return "\(ft)′ \(String(format: inch.truncatingRemainder(dividingBy: 1) == 0 ? "%.0f" : "%.1f", inch))″" }
    let n = String(format: "%.\(decimals)f", value)
    return ["ratio", "level", ""].contains(unit) ? n : "\(n) \(unit)"
}

enum ISO {
    private static let withFraction: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let plain = ISO8601DateFormatter()
    static func date(_ s: String) -> Date? { withFraction.date(from: s) ?? plain.date(from: s) }
    static func string(_ d: Date) -> String { withFraction.string(from: d) }
}
enum Day {
    static func string(_ d: Date) -> String { let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.dateFormat = "yyyy-MM-dd"; return f.string(from: d) }
    static func pretty(_ s: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: String(s.prefix(10))) else { return s }
        return d.formatted(date: .abbreviated, time: .omitted)
    }
}
struct ConnectionToken: Decodable { let secret: String }

func money(_ cents: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    f.maximumFractionDigits = cents % 100 == 0 ? 0 : 2
    return f.string(from: NSNumber(value: Double(cents) / 100)) ?? "$\(cents / 100)"
}

// MARK: - API client

struct APIError: LocalizedError {
    let message: String
    let status: Int
    var errorDescription: String? { message }
}

final class API: NSObject {
    static let shared = API()

    /// Server address. Defaults to DPServerURL in Info.plist; can be changed on the sign-in screen.
    var baseURL: URL {
        get {
            let saved = UserDefaults.standard.string(forKey: "serverURL")
            let fallback = Bundle.main.object(forInfoDictionaryKey: "DPServerURL") as? String ?? "http://localhost:3000"
            return URL(string: saved ?? fallback)!
        }
        set { UserDefaults.standard.set(newValue.absoluteString, forKey: "serverURL") }
    }
    var token: String? {
        get { Keychain.read("dp_app_token") }
        set { if let newValue { Keychain.write("dp_app_token", newValue) } else { Keychain.delete("dp_app_token") } }
    }

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    func request<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil, query: [String: String] = [:]) async throws -> T {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct Wrapper: Decodable { let error: Inner; struct Inner: Decodable { let message: String } }
            let message = (try? decoder.decode(Wrapper.self, from: data))?.error.message ?? "Something went wrong (\(status)). Try again."
            if status == 401 && path != "auth/token" { NotificationCenter.default.post(name: .signedOut, object: nil) }
            if status == 403 && message.hasPrefix("Choose a new password") { NotificationCenter.default.post(name: .passwordChangeRequired, object: nil) }
            throw APIError(message: message, status: status)
        }
        return try decoder.decode(T.self, from: data)
    }

    // Convenience calls
    func signIn(email: String, password: String) async throws -> User {
        let r: TokenResponse = try await request("POST", "auth/token", body: ["email": email, "password": password])
        token = r.token
        return r.user
    }
    func me() async throws -> Me { try await request("GET", "auth/me") }
    func locations() async throws -> [Location] { (try await request("GET", "v1/locations") as ListResponse<Location>).data }
    func products() async throws -> [Product] { (try await request("GET", "v1/products") as ListResponse<Product>).data }
    func clients() async throws -> [ClientSummary] { (try await request("GET", "v1/clients") as ListResponse<ClientSummary>).data }
    func sync(_ saleId: String) async throws -> Sale { try await request("POST", "v1/sales/\(saleId)/sync") }
    func cancel(_ saleId: String) async throws -> Sale { try await request("POST", "v1/sales/\(saleId)/cancel") }
    func simulate(_ saleId: String, approved: Bool) async throws -> Sale { try await request("POST", "v1/sales/\(saleId)/simulate", body: ["outcome": approved ? "approved" : "declined"]) }
    func changePassword(current: String, new: String) async throws {
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await request("POST", "auth/password", body: ["current_password": current, "new_password": new])
    }
    func agenda(date: Date) async throws -> Agenda { try await request("GET", "v1/agenda", query: ["date": Day.string(date)]) }
    func session(_ id: String) async throws -> SessionDetail { try await request("GET", "v1/sessions/\(id)") }
    func setAttendance(bookingId: String, present: Bool) async throws {
        struct B: Decodable { let id: String }
        let _: B = try await request("POST", "v1/bookings/\(bookingId)/attendance", body: ["status": present ? "attended" : "booked"])
    }
    func setTeamAttendance(sessionId: String, rosterId: String, present: Bool) async throws {
        let _: TeamRoster = try await request("POST", "v1/sessions/\(sessionId)/team-attendance", body: ["roster_id": rosterId, "present": present])
    }
    func payBooking(_ bookingId: String, method: String) async throws -> Sale {
        struct Out: Decodable { let sale: Sale }
        return (try await request("POST", "v1/bookings/\(bookingId)/pay", body: ["method": method]) as Out).sale
    }
    func testingDays() async throws -> [TestingDaySummary] { (try await request("GET", "v1/testing-sessions") as ListResponse<TestingDaySummary>).data }
    func testingDay(_ id: String) async throws -> TestingDay { try await request("GET", "v1/testing-sessions/\(id)") }
    func recordResult(_ body: [String: Any]) async throws -> RecordResponse { try await request("POST", "v1/results", body: body) }
    func deleteResult(_ id: String) async throws {
        struct Out: Decodable { let voided: Bool }
        let _: Out = try await request("DELETE", "v1/results/\(id)")
    }
    func checkIn(clientId: String, locationId: String) async throws -> CheckInResult {
        try await request("POST", "v1/clients/\(clientId)/check-ins", body: ["location_id": locationId])
    }
}

// Stripe's SDK asks for a fresh connection token whenever it connects to a reader.
extension API: ConnectionTokenProvider {
    func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        Task {
            do {
                let t: ConnectionToken = try await request("POST", "v1/terminal/connection-token", body: [:])
                completion(t.secret, nil)
            } catch {
                completion(nil, error)
            }
        }
    }
}

extension Notification.Name {
    static let signedOut = Notification.Name("dp.signedOut")
    static let passwordChangeRequired = Notification.Name("dp.passwordChangeRequired")
}

// MARK: - Keychain (stores the sign-in token securely on the device)

enum Keychain {
    static func write(_ key: String, _ value: String) {
        delete(key)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        SecItemAdd(q as CFDictionary, nil)
    }
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func delete(_ key: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key] as CFDictionary)
    }
}
