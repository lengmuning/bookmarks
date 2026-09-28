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

/// Watches Safari starting and quitting: a Safari launch after an import
/// matters for confirming it, and imports Safari saved over wait for it to quit.
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

/// Gets the change entries this app wrote into the plist uploaded to iCloud
/// (docs/SYNC-V2.md, "iCloud"). Safari's sync agent uploads only after Safari
/// saves a bookmark change of its own, so Safari is asked to add the
/// `ICloudTrigger` Reading List item again, until `Sync.Changes` is empty.
/// When Safari is not running it is opened hidden and quit afterwards, unless
/// the user started using it in the meantime.
@MainActor
final class ICloudUploader {
    enum Status: Equatable {
        case idle
        case uploading
        /// The user has not allowed this app to control Safari.
        case notAllowed
        /// The last attempt ended before iCloud took the changes.
        case failed
    }

    /// Writes this close together are uploaded in one go.
    static let debounce: TimeInterval = 60
    private static let timeout: TimeInterval = 120
    /// Safari saves about 10 seconds after a change and the agent uploads
    /// right after; a nudge that got no upload by then is sent again.
    private static let nudgeInterval: TimeInterval = 30
    private static let pollInterval: TimeInterval = 5
    /// Time for a Safari opened by the app to load its bookmarks.
    private static let launchDelay: TimeInterval = 8
    private static let retryDelays: [TimeInterval] = [10 * 60, 30 * 60, 2 * 60 * 60]
    /// After this many failed attempts in a row, Safari is no longer opened
    /// for retries (only a Safari the user started is nudged).
    private static let maxFailuresOpeningSafari = 5

    private let file: SecurityScopedBookmarksFile
    private let changed: () -> Void
    private let finished: (_ uploaded: Bool) -> Void
    private(set) var status: Status = .idle
    private var scheduled: Task<Void, Never>?
    private var running = false
    private var failures = 0
    private var notBefore: Date?

    init(file: SecurityScopedBookmarksFile, changed: @escaping () -> Void, finished: @escaping (_ uploaded: Bool) -> Void) {
        self.file = file
        self.changed = changed
        self.finished = finished
    }

    /// Starts an attempt after `delay` (later after failed attempts), replacing
    /// one that is waiting to start. `openSafari`: whether Safari may be
    /// opened when it is not running.
    func schedule(after delay: TimeInterval, openSafari: Bool) {
        guard !running else { return }
        let wait = max(delay, notBefore?.timeIntervalSinceNow ?? 0)
        scheduled?.cancel()
        scheduled = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled else { return }
            await self?.run(openSafari: openSafari)
        }
    }

    /// New changes: the next attempt does not wait for earlier failures.
    func resetRetries() {
        failures = 0
        notBefore = nil
    }

    /// The user asked: tries right away, opening Safari if needed, also after
    /// Automation was not allowed (the user may have allowed it since).
    func uploadNow() {
        guard !running else { return }
        resetRetries()
        status = .idle
        schedule(after: 0, openSafari: true)
    }

    func cancel() {
        scheduled?.cancel()
        scheduled = nil
        if !running { status = .idle }
    }

    private func run(openSafari: Bool) async {
        guard let pending = await pendingChanges() else { return }
        guard pending > 0 else {
            // Uploaded meanwhile (Safari or another device saved a change).
            status = .idle
            changed()
            finished(true)
            return
        }
        var safari = Self.runningSafari()
        let mayOpen = openSafari && status != .notAllowed && failures < Self.maxFailuresOpeningSafari
        guard safari != nil || mayOpen else { return }
        running = true
        status = .uploading
        changed()

        var opened: NSRunningApplication?
        var usedByUser = false
        let observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated {
                if let opened, app?.processIdentifier == opened.processIdentifier { usedByUser = true }
            }
        }
        defer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }

        if safari == nil {
            opened = await Self.openHidden()
            safari = opened
            if let opened {
                opened.hide()
                try? await Task.sleep(for: .seconds(Self.launchDelay))
            }
        }
        var result = Status.failed
        if let safari { result = await nudgeUntilUploaded(safari) }
        if let opened, !usedByUser { await quit(opened) }

        running = false
        status = result
        if result == .idle {
            resetRetries()
        } else {
            notBefore = Date().addingTimeInterval(Self.retryDelays[min(failures, Self.retryDelays.count - 1)])
            failures += 1
        }
        changed()
        finished(result == .idle)
    }

    /// Nudges Safari until the plist has no pending change entries left.
    private func nudgeUntilUploaded(_ safari: NSRunningApplication) async -> Status {
        let deadline = Date().addingTimeInterval(Self.timeout)
        while Date() < deadline, !safari.isTerminated {
            switch await SafariScript.addTrigger(to: safari.processIdentifier) {
            case .sent:
                break
            case .notAllowed:
                return .notAllowed
            case let .failed(message):
                NSLog("BookmarksSync: could not nudge Safari: %@", message)
            }
            let next = min(Date().addingTimeInterval(Self.nudgeInterval), deadline)
            while Date() < next {
                try? await Task.sleep(for: .seconds(Self.pollInterval))
                if await pendingChanges() == 0 { return .idle }
            }
        }
        return .failed
    }

    /// Quits a Safari this app opened, unless the user has brought it forward.
    private func quit(_ safari: NSRunningApplication) async {
        // Safari reloads the file after the sync agent writes it.
        try? await Task.sleep(for: .seconds(3))
        guard !safari.isTerminated, safari.isHidden, !safari.isActive else { return }
        safari.terminate()
    }

    /// Change entries in the plist waiting for upload; nil when it cannot be read.
    private func pendingChanges() async -> Int? {
        let file = self.file
        return await Task.detached {
            guard let data = try? file.read().data, let document = try? SafariBookmarksDocument(data: data) else { return nil }
            return document.pendingChangeCount
        }.value
    }

    private static func runningSafari() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: SafariMonitor.bundleIdentifier).first { !$0.isTerminated }
    }

    private static func openHidden() async -> NSRunningApplication? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: SafariMonitor.bundleIdentifier) else { return nil }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        configuration.addsToRecentItems = false
        do {
            return try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        } catch {
            NSLog("BookmarksSync: could not open Safari: %@", error.localizedDescription)
            return nil
        }
    }
}

/// Safari's `add reading list item` command, sent as an Apple Event so the
/// main thread does not wait for Safari.
enum SafariScript {
    enum Result: Equatable {
        case sent
        case notAllowed
        case failed(String)
    }

    /// Adds `ICloudTrigger` to the Reading List of the Safari process `pid`.
    /// Safari replaces the item if it is already there.
    static func addTrigger(to pid: pid_t) async -> Result {
        await Task.detached {
            let event = NSAppleEventDescriptor(
                eventClass: code("sfri"),
                eventID: code("arli"),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                returnID: -1, // kAutoGenerateReturnID
                transactionID: 0 // kAnyTransactionID
            )
            event.setParam(NSAppleEventDescriptor(string: ICloudTrigger.url), forKeyword: code("----"))
            event.setParam(NSAppleEventDescriptor(string: ICloudTrigger.title), forKeyword: code("rlit"))
            do {
                _ = try event.sendEvent(options: [.waitForReply, .canInteract], timeout: 60)
                return .sent
            } catch {
                // -1743: the user has not allowed this app to control Safari.
                if (error as NSError).code == -1743 { return .notAllowed }
                return .failed(error.localizedDescription)
            }
        }.value
    }

    private static func code(_ text: String) -> FourCharCode {
        text.utf8.reduce(0) { $0 << 8 | FourCharCode($1) }
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
