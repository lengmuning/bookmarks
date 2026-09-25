import AppKit
import BookmarksSyncCore
import ServiceManagement

struct WorkspaceSafariActivity: SafariActivity {
    var isSafariRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: SafariMonitor.bundleIdentifier).isEmpty
    }
}

/// Owns the sync engine and everything that triggers it; the menu and the
/// settings window observe it.
@MainActor
final class AppController {
    static let keychainService = "com.lengmuning.bookmarks-sync"
    private static let workerURLKey = "workerURL"
    private static let autoSyncKey = "autoSync"
    private static let periodicInterval: TimeInterval = 10 * 60

    let file: SecurityScopedBookmarksFile
    private let credentialStore: CredentialStore
    private let stateStore: FileSyncStateStore
    private let notifier = Notifier()
    private lazy var fileWatcher = FileWatcher(file: file) { [weak self] in self?.plistChanged() }
    private lazy var safariMonitor = SafariMonitor(
        launched: { [weak self] in self?.safariLaunched() },
        terminated: { [weak self] in self?.automaticSync(after: 3) }
    )
    private lazy var realtime = RealtimeListener { [weak self] in self?.automaticSync(after: 2) }

    private(set) var credentials: Credentials?
    private var engine: SyncEngine?
    private(set) var state = SyncState()
    private(set) var isSyncing = false
    private(set) var pairingCode: PairingCode?
    private(set) var devices: [Device] = []
    private var pendingSync: Task<Void, Never>?
    private var periodic: Timer?
    private var observers: [() -> Void] = []
    private var settings: SettingsWindowController?

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BookmarksSync", isDirectory: true)
        file = SecurityScopedBookmarksFile(backupsDirectory: support.appendingPathComponent("Backups", isDirectory: true))
        stateStore = FileSyncStateStore(url: support.appendingPathComponent("state.json"))
        credentialStore = KeychainCredentialStore(service: Self.keychainService)
        credentials = credentialStore.load()
        state = stateStore.load()
        makeEngine()
    }

    // MARK: Observation

    func observe(_ observer: @escaping () -> Void) {
        observers.append(observer)
    }

    private func changed() {
        observers.forEach { $0() }
    }

    // MARK: Settings

    var isPaired: Bool { credentials != nil }
    var hasSafariAccess: Bool { file.hasGrant }
    var isReady: Bool { isPaired && hasSafariAccess }

    var workerURLText: String {
        get { credentials?.workerURL.absoluteString ?? UserDefaults.standard.string(forKey: Self.workerURLKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: Self.workerURLKey) }
    }

    var autoSync: Bool {
        get { UserDefaults.standard.object(forKey: Self.autoSyncKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.autoSyncKey)
            startRealtime()
            if newValue { scheduleSync(after: 0) }
            changed()
        }
    }

    var launchAtLogin: Bool {
        SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
        changed()
    }

    func showSettings() {
        if settings == nil { settings = SettingsWindowController(app: self) }
        settings?.present()
    }

    // MARK: Lifecycle

    func start() {
        fileWatcher.start()
        safariMonitor.start()
        periodic = Timer.scheduledTimer(withTimeInterval: Self.periodicInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.automaticSync(after: 0) }
        }
        periodic?.tolerance = 60
        startRealtime()
        if isReady {
            scheduleSync(after: 0)
        } else {
            showSettings()
        }
    }

    private func makeEngine() {
        guard let credentials else {
            engine = nil
            return
        }
        engine = SyncEngine(
            api: WorkerClient(credentials: credentials),
            file: file,
            safari: WorkspaceSafariActivity(),
            store: stateStore
        )
    }

    private func startRealtime() {
        guard let credentials, autoSync else {
            realtime.stop()
            return
        }
        realtime.start(client: WorkerClient(credentials: credentials))
    }

    // MARK: Triggers

    private func plistChanged() {
        automaticSync(after: 3)
    }

    private func safariLaunched() {
        guard let engine else { return }
        Task { await engine.noteSafariLaunched() }
    }

    private func automaticSync(after delay: TimeInterval) {
        guard autoSync else { return }
        scheduleSync(after: delay)
    }

    /// Coalesces bursts of triggers into one sync.
    func scheduleSync(after delay: TimeInterval) {
        guard isReady else { return }
        pendingSync?.cancel()
        pendingSync = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            await self?.syncNow()
        }
    }

    // MARK: Actions

    func syncNow(confirmDeletions: Bool = false) async {
        guard let engine else { return }
        guard hasSafariAccess else {
            state.lastError = SyncError.bookmarksAccess("Choose your Safari folder in Settings so the app can read Safari's bookmarks.").errorDescription
            changed()
            return
        }
        let before = state
        isSyncing = true
        changed()
        do {
            let outcome = try await engine.sync(confirmDeletions: confirmDeletions)
            state = await engine.currentState()
            notifyAbout(outcome, before: before)
        } catch let error as SyncError where error.needsUserAction {
            state = await engine.currentState()
            realtime.stop()
            notifier.post(title: "Bookmark sync stopped", body: error.errorDescription ?? "")
        } catch {
            state = await engine.currentState()
        }
        fileWatcher.acknowledge()
        isSyncing = false
        changed()
    }

    private func notifyAbout(_ outcome: SyncOutcome, before: SyncState) {
        if outcome.waitingForSafariToQuit > 0, before.waitingForSafariToQuit == 0 {
            notifier.post(
                title: "Changes waiting for Safari",
                body: "\(outcome.waitingForSafariToQuit) change(s) from your other browsers will be applied when you quit Safari."
            )
        }
        if let confirmation = outcome.needsConfirmation, before.deletionConfirmation == nil {
            notifier.post(
                title: "Confirm deleting bookmarks",
                body: "\(confirmation.count) bookmarks are missing from Safari. Open the menu to confirm before they are deleted in your other browsers."
            )
        }
    }

    /// Connects with the user's access key: creates their sync group the first
    /// time, joins it afterwards. Throws `SyncError.safariDeviceExists` when
    /// another Mac is the group's Safari device and `replaceSafari` is false.
    func connect(workerURL raw: String, accessKey: String, replaceSafari: Bool = false) async throws {
        guard let url = normalizedWorkerURL(raw) else { throw SyncError.invalidWorkerURL }
        workerURLText = url.absoluteString
        let response = try await WorkerClient(baseURL: url, token: nil)
            .connect(accessKey: accessKey, deviceName: Self.deviceName, replaceSafari: replaceSafari)
        try adopt(Credentials(workerURL: url, pairId: response.pairId, deviceId: response.deviceId, token: response.token))
        if let code = response.code, let expires = response.codeExpiresAt {
            pairingCode = PairingCode(code: code, codeExpiresAt: expires)
        }
        changed()
        scheduleSync(after: 0)
    }

    private func adopt(_ credentials: Credentials) throws {
        try credentialStore.save(credentials)
        self.credentials = credentials
        stateStore.save(SyncState())
        state = SyncState()
        devices = []
        makeEngine()
        startRealtime()
    }

    func newPairingCode() async throws {
        guard let credentials else { throw SyncError.notPaired }
        pairingCode = try await WorkerClient(credentials: credentials).newPairingCode()
        changed()
    }

    func refreshDevices() async {
        guard let credentials else { return }
        if let list = try? await WorkerClient(credentials: credentials).devices() {
            devices = list
            changed()
        }
    }

    func removeDevice(_ id: String) async throws {
        guard let credentials else { throw SyncError.notPaired }
        try await WorkerClient(credentials: credentials).revokeDevice(id)
        await refreshDevices()
    }

    /// Removes this Mac from the group. Bookmarks stay where they are.
    func leaveGroup() async {
        if let credentials {
            try? await WorkerClient(credentials: credentials).revokeDevice("self")
        }
        realtime.stop()
        pendingSync?.cancel()
        credentialStore.delete()
        credentials = nil
        engine = nil
        pairingCode = nil
        devices = []
        state = SyncState()
        stateStore.save(state)
        changed()
    }

    func grantSafariAccess(_ url: URL) throws {
        try file.grant(url)
        fileWatcher.acknowledge()
        changed()
        scheduleSync(after: 0)
    }

    #if DEBUG
    /// In-memory state for rendering the paired settings layout; nothing is saved.
    func debugPreviewPaired() {
        credentials = Credentials(workerURL: URL(string: "https://bookmarks.example.workers.dev")!, pairId: "3f2a9c1e-0000-4000-8000-000000000000", deviceId: "d", token: "t")
        pairingCode = PairingCode(code: "K7PM-3QXD", codeExpiresAt: Date().addingTimeInterval(1800).timeIntervalSince1970 * 1000)
        state.lastSyncAt = Date()
        state.lastStats = SnapshotStats(received: 812, accepted: 810, skipped: 2, inserted: 3, updated: 5, restored: 0, unchanged: 802, deleted: 1)
        state.waitingForSafariToQuit = 2
        changed()
    }
    #endif

    private static var deviceName: String {
        Host.current().localizedName ?? "Mac"
    }
}
