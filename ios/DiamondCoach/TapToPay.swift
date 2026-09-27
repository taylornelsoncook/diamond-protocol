import Foundation
import StripeTerminal

/// Turns the iPhone into a card reader with Stripe's Tap to Pay on iPhone.
///
/// Flow for one payment:
///   1. The server creates the sale and returns a PaymentIntent client secret and Stripe location.
///   2. `collect` connects Tap to Pay at that location (first time can take a minute while the phone configures).
///   3. The client taps their card or phone; Stripe authorizes it.
///   4. The app asks the server to sync, and the server confirms the result with Stripe before recording it.
///
/// Written against Stripe Terminal iOS SDK 5.x. If Xcode flags a delegate method name after an SDK update,
/// accept its suggested fix; the flow does not change.
@MainActor
final class TapToPay: NSObject, ObservableObject {
    static let shared = TapToPay()

    @Published var status: String = "Not connected"
    @Published var progress: Float?
    @Published var prompt: String?
    /// Use Stripe's simulated reader: works in the iOS Simulator and with Stripe test keys, no card needed.
    @Published var simulated: Bool = UserDefaults.standard.bool(forKey: "simulatedReader") {
        didSet { UserDefaults.standard.set(simulated, forKey: "simulatedReader") }
    }

    private var connectedLocation: String?
    private var discoverCancelable: Cancelable?
    private var discoveryContinuation: CheckedContinuation<Reader, Error>?
    private static var initialized = false

    func initialize() {
        guard !Self.initialized else { return }
        Terminal.initWithTokenProvider(API.shared)
        Self.initialized = true
    }

    var isConnected: Bool { Terminal.shared.connectedReader != nil }

    /// Connect ahead of time (for example when the Charge screen opens) so the first tap is fast.
    func prepare(locationRef: String?) async {
        guard let locationRef else { return }
        do { try await connect(locationRef: locationRef) } catch { status = error.localizedDescription }
    }

    func connect(locationRef: String) async throws {
        initialize()
        if Terminal.shared.connectedReader != nil {
            if connectedLocation == locationRef { return }
            try await disconnect()
        }
        status = "Getting Tap to Pay ready…"
        let config = try TapToPayDiscoveryConfigurationBuilder().setSimulated(simulated).build()
        let reader: Reader = try await withCheckedThrowingContinuation { cont in
            discoveryContinuation = cont
            discoverCancelable = Terminal.shared.discoverReaders(config, delegate: self) { [weak self] error in
                Task { @MainActor in
                    if let error { self?.finishDiscovery(.failure(error)) }
                }
            }
        }
        let connectionConfig = try TapToPayConnectionConfigurationBuilder(locationId: locationRef).delegate(self).build()
        _ = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Reader, Error>) in
            Terminal.shared.connectReader(reader, connectionConfig: connectionConfig) { reader, error in
                if let reader { cont.resume(returning: reader) } else { cont.resume(throwing: error ?? APIError(message: "Could not start Tap to Pay.", status: 0)) }
            }
        }
        connectedLocation = locationRef
        status = "Ready"
    }

    func disconnect() async throws {
        guard Terminal.shared.connectedReader != nil else { return }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            Terminal.shared.disconnectReader { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
        connectedLocation = nil
        status = "Not connected"
    }

    /// Collect a card for a PaymentIntent the server already created.
    func collect(clientSecret: String, locationRef: String) async throws {
        try await connect(locationRef: locationRef)
        prompt = "Hold card or phone near the top of this iPhone"
        defer { prompt = nil }
        let intent: PaymentIntent = try await withCheckedThrowingContinuation { cont in
            Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret) { intent, error in
                if let intent { cont.resume(returning: intent) } else { cont.resume(throwing: error ?? APIError(message: "Could not load the payment.", status: 0)) }
            }
        }
        let collectConfig = try CollectConfigurationBuilder().build()
        _ = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<PaymentIntent, Error>) in
            Terminal.shared.processPaymentIntent(intent, collectConfig: collectConfig) { processed, error in
                if let processed { cont.resume(returning: processed) } else { cont.resume(throwing: error ?? APIError(message: "The payment didn't go through.", status: 0)) }
            }
        }
    }

    private func finishDiscovery(_ result: Result<Reader, Error>) {
        guard let cont = discoveryContinuation else { return }
        discoveryContinuation = nil
        switch result {
        case .success(let reader): cont.resume(returning: reader)
        case .failure(let error): cont.resume(throwing: error)
        }
    }
}

// MARK: - Reader discovery

extension TapToPay: DiscoveryDelegate {
    nonisolated func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        Task { @MainActor in
            if let first = readers.first { self.finishDiscovery(.success(first)) }
        }
    }
}

// MARK: - Tap to Pay setup and connection events

extension TapToPay: TapToPayReaderDelegate {
    nonisolated func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        Task { @MainActor in self.status = "Setting up Tap to Pay on this iPhone…"; self.progress = 0 }
    }
    nonisolated func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        Task { @MainActor in self.progress = progress }
    }
    nonisolated func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        Task { @MainActor in self.progress = nil; self.status = error?.localizedDescription ?? "Ready" }
    }
    nonisolated func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        Task { @MainActor in self.prompt = Terminal.stringFromReaderDisplayMessage(displayMessage) }
    }
    nonisolated func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
        Task { @MainActor in self.prompt = Terminal.stringFromReaderInputOptions(inputOptions) }
    }
    nonisolated func reader(_ reader: Reader, didDisconnect reason: DisconnectReason) {
        Task { @MainActor in self.connectedLocation = nil; self.status = "Disconnected. It reconnects on the next charge." }
    }
}
