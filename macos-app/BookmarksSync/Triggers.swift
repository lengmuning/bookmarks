import AppKit
import BookmarksSyncCore
import UserNotifications

/// Polls the plist's modification date. Polling works the same whether the
/// user granted the Safari folder or only the file, and survives Safari
/// replacing the file.
@MainActor
final class FileWatcher {
    private static let interval: TimeInterval = 15
    private let file: SecurityScopedBookmarksFile
    private let changed: () -> Void
    private var timer: Timer?
    private var lastSeen: Date?

    init(file: SecurityScopedBookmarksFile, changed: @escaping () -> Void) {
        self.file = file
        self.changed = changed
    }

    func start() {
        acknowledge()
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
        timer?.tolerance = 5
    }

    /// Records the current date so our own writes do not count as changes.
    func acknowledge() {
        lastSeen = try? file.modificationDate()
    }

    private func check() {
        guard file.hasGrant, let date = try? file.modificationDate() else { return }
        if let lastSeen, date == lastSeen { return }
        lastSeen = date
        changed()
    }
}

/// Watches Safari starting and quitting: imports wait for Safari to quit, and a
/// Safari launch after an import matters for confirming it.
@MainActor
final class SafariMonitor {
    nonisolated static let bundleIdentifier = "com.apple.Safari"
    private let launched: () -> Void
    private let terminated: () -> Void
    private var tokens: [NSObjectProtocol] = []

    init(launched: @escaping () -> Void, terminated: @escaping () -> Void) {
        self.launched = launched
        self.terminated = terminated
    }

    func start() {
        let center = NSWorkspace.shared.notificationCenter
        tokens.append(center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard Self.isSafari(note) else { return }
            MainActor.assumeIsolated { self?.launched() }
        })
        tokens.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard Self.isSafari(note) else { return }
            MainActor.assumeIsolated { self?.terminated() }
        })
    }

    private nonisolated static func isSafari(_ note: Notification) -> Bool {
        (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == bundleIdentifier
    }
}

/// Listens on the Worker's WebSocket so bookmarks added in other browsers are
/// imported without waiting for the periodic sync.
@MainActor
final class RealtimeListener {
    private static let pingInterval: TimeInterval = 25
    private let changed: () -> Void
    private var client: WorkerClient?
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var reconnect: Task<Void, Never>?
    private var attempt = 0
    private var generation = 0

    init(changed: @escaping () -> Void) {
        self.changed = changed
    }

    func start(client: WorkerClient) {
        stop()
        self.client = client
        connect()
    }

    func stop() {
        generation += 1
        client = nil
        reconnect?.cancel()
        reconnect = nil
        pingTimer?.invalidate()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func connect() {
        guard let client else { return }
        let current = generation
        Task { [weak self] in
            do {
                let ticket = try await client.webSocketTicket()
                guard let self, self.generation == current, let url = client.webSocketURL(for: ticket) else { return }
                let socket = URLSession.shared.webSocketTask(with: url)
                self.task = socket
                socket.resume()
                self.attempt = 0
                self.pingTimer?.invalidate()
                self.pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingInterval, repeats: true) { _ in
                    socket.send(.string(#"{"type":"ping"}"#)) { _ in }
                }
                self.receive(on: socket, generation: current)
            } catch let error as SyncError where error.needsUserAction {
                // The token is no longer valid; the next sync reports it.
            } catch {
                self?.retry(generation: current)
            }
        }
    }

    private func receive(on socket: URLSessionWebSocketTask, generation current: Int) {
        socket.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                switch result {
                case let .success(.string(text)) where text.contains(#""type":"changed""#):
                    self.changed()
                    self.receive(on: socket, generation: current)
                case .success:
                    self.receive(on: socket, generation: current)
                case .failure:
                    self.pingTimer?.invalidate()
                    self.retry(generation: current)
                }
            }
        }
    }

    private func retry(generation current: Int) {
        guard generation == current, client != nil else { return }
        attempt += 1
        let delay = min(2.0 * pow(2.0, Double(min(attempt - 1, 5))), 60) + Double.random(in: 0..<1)
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }
}

@MainActor
final class Notifier {
    private var authorized: Bool?

    func post(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        Task {
            if authorized == nil {
                authorized = (try? await center.requestAuthorization(options: [.alert])) ?? false
            }
            guard authorized == true else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
}
