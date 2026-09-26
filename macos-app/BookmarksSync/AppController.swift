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
    private let iCloudNudge = ICloudNudge()
    private var toldAboutAutomation = false

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
        // Give Safari time to load its bookmarks before nudging it.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            self?.nudgeICloudIfNeeded()
        }
    }

    /// Changes this app wrote reach iCloud only after Safari saves a change of
    /// its own; the nudge makes it do that.
    private func nudgeICloudIfNeeded() {
        guard state.iCloudUploadPending, let result = iCloudNudge.nudge() else { return }
        switch result {
        case .sent:
            break
        case .notAllowed:
            guard !toldAboutAutomation else { return }
            toldAboutAutomation = true
            notifier.post(
                title: "Allow controlling Safari",
                body: "To send bookmarks from your other browsers to iCloud, allow Safari Bookmarks Sync to control Safari in System Settings > Privacy & Security > Automation."
            )
        case let .failed(message):
            NSLog("BookmarksSync: could not nudge Safari: %@", message)
        }
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
            if outcome.safariBusy { automaticSync(after: 5) }
            nudgeICloudIfNeeded()
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

    /// Asks before deleting, in the other browsers, bookmarks that a held-back
    /// Safari snapshot no longer has.
    func confirmPendingDeletions() {
        guard let confirmation = state.deletionConfirmation else { return }
        NSApp.activate()
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Delete \(confirmation.count) bookmarks in your other browsers?"
        let examples = confirmation.sample.prefix(10).map { "• \($0)" }.joined(separator: "\n")
        alert.informativeText = """
            These bookmarks are no longer in Safari's bookmarks file. If you deleted them in Safari, \
            delete them everywhere. If Safari's bookmarks look wrong (for example after iCloud replaced them), \
            cancel and check Safari first; nothing is deleted until you confirm.

            \(examples)
            """
        alert.addButton(withTitle: "Delete Everywhere")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await syncNow(confirmDeletions: true) }
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
        state.lastStats = SnapshotStats(received: 261, accepted: 259, skipped: 2, inserted: 0, updated: 0, restored: 0, unchanged: 259, deleted: 0)
        let notices = ProcessInfo.processInfo.arguments.contains("-notices")
        state.waitingForSafariToQuit = notices ? 2 : 0
        state.lastError = nil
        state.deletionConfirmation = notices ? DeletionConfirmation(count: 34, sample: []) : nil
        let now = Date().timeIntervalSince1970 * 1000
        let json = """
            [{"id":"a","platform":"safari","name":"Eric's Mac mini","created_at":0,"last_seen_at":\(now),"self":true},
             {"id":"b","platform":"firefox","name":"Firefox","created_at":0,"last_seen_at":\(now - 7_200_000),"self":false},
             {"id":"c","platform":"chrome","name":"Chrome","created_at":0,"last_seen_at":\(now - 300_000),"self":false}]
            """
        devices = (try? JSONDecoder().decode([Device].self, from: Data(json.utf8))) ?? []
        changed()
    }

    /// In-memory "not connected" state for rendering the setup layout.
    func debugPreviewUnpaired() {
        credentials = nil
        state = SyncState()
        changed()
    }
    #endif

    private static var deviceName: String {
        Host.current().localizedName ?? "Mac"
    }
}
