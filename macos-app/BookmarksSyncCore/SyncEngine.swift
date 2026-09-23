import CryptoKit
import Foundation

public protocol SafariActivity: Sendable {
    var isSafariRunning: Bool { get }
}

public struct SyncOutcome: Equatable, Sendable {
    public var uploaded = false
    public var imported = 0
    public var waitingForSafariToQuit = 0
    public var newlyParked = 0
    public var needsConfirmation: DeletionConfirmation?
    public var stats: SnapshotStats?

    public init() {}
}

/// One sync cycle for Safari (docs/SYNC-V2.md): upload the plist as a
/// snapshot, then write bookmarks added in other browsers into the plist while
/// Safari is not running. Runs are serialized.
public actor SyncEngine {
    /// An import still present this long after writing it counts as kept even
    /// if Safari never rewrote the file.
    static let confirmationFallback: TimeInterval = 7 * 24 * 60 * 60
    static let modificationTolerance: TimeInterval = 0.5

    private let api: SafariSyncAPI
    private let file: BookmarksFileStore
    private let safari: SafariActivity
    private let store: SyncStateStore
    private let now: @Sendable () -> Date
    private var state: SyncState

    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(
        api: SafariSyncAPI,
        file: BookmarksFileStore,
        safari: SafariActivity,
        store: SyncStateStore,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.api = api
        self.file = file
        self.safari = safari
        self.store = store
        self.now = now
        state = store.load()
    }

    public func currentState() -> SyncState { state }

    public func noteSafariLaunched() {
        guard !state.pendingImports.isEmpty, !state.safariLaunchedSinceImport else { return }
        state.safariLaunchedSinceImport = true
        store.save(state)
    }

    /// Lets parked imports be written into Safari again on the next sync.
    public func retryParkedImports() {
        state.parkedImports = []
        store.save(state)
    }

    public func sync(confirmDeletions: Bool = false) async throws -> SyncOutcome {
        await acquire()
        defer { release() }
        do {
            let outcome = try await cycle(confirmDeletions: confirmDeletions)
            state.lastSyncAt = now()
            state.lastError = nil
            store.save(state)
            return outcome
        } catch {
            state.lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            store.save(state)
            throw error
        }
    }

    private func acquire() async {
        if !busy {
            busy = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty {
            busy = false
        } else {
            waiters.removeFirst().resume()
        }
    }

    // MARK: Cycle

    private func cycle(confirmDeletions: Bool) async throws -> SyncOutcome {
        var outcome = SyncOutcome()
        let (data, modified) = try file.read()
        let document = try SafariBookmarksDocument(data: data)
        let items = document.items()
        let present = Set(items.map(\.url))

        outcome.newlyParked = reconcilePendingImports(present: present, modified: modified)
        let unconfirmed = state.pendingImports.map(\.url)
        let digest = Self.digest(data, unconfirmed)

        var pending: [RemoteBookmark]
        var canonicalMap: [String: String] = [:]
        if digest == state.lastUploadDigest, state.deletionConfirmation == nil, !confirmDeletions {
            pending = try await api.safariPending().pendingImports
        } else {
            let response = try await api.safariSnapshot(
                SafariSnapshotRequest(bookmarks: items, unconfirmedImports: unconfirmed, confirmDeletions: confirmDeletions)
            )
            record(response, digest: digest)
            outcome.uploaded = true
            outcome.stats = response.stats
            outcome.needsConfirmation = response.needsConfirmation
            pending = response.pendingImports
            canonicalMap = response.canonicalMap
        }

        let presentCanonical = Set(present.map { canonicalMap[$0] ?? $0 })
        let parked = Set(state.parkedImports)
        let toImport = pending.filter { !presentCanonical.contains($0.url) && !parked.contains($0.url) }
        guard !toImport.isEmpty else {
            state.waitingForSafariToQuit = 0
            return outcome
        }
        guard !safari.isSafariRunning else {
            state.waitingForSafariToQuit = toImport.count
            outcome.waitingForSafariToQuit = toImport.count
            return outcome
        }

        var updated = document
        let added = updated.add(toImport, now: now())
        let newData = try updated.data()
        _ = try file.backup(data)
        guard !safari.isSafariRunning else {
            state.waitingForSafariToQuit = toImport.count
            outcome.waitingForSafariToQuit = toImport.count
            return outcome
        }
        let written = try file.write(newData)
        try verifyWrite(added: added, original: data)

        state.lastOwnWrite = written
        state.safariLaunchedSinceImport = false
        state.pendingImports += added.map { PendingImport(url: $0, importedAt: now()) }
        state.waitingForSafariToQuit = 0
        outcome.imported = added.count

        // Tell the server that Safari has them now, still owned by the browsers.
        let nowUnconfirmed = state.pendingImports.map(\.url)
        let response = try await api.safariSnapshot(
            SafariSnapshotRequest(bookmarks: updated.items(), unconfirmedImports: nowUnconfirmed, confirmDeletions: false)
        )
        record(response, digest: Self.digest(newData, nowUnconfirmed))
        outcome.needsConfirmation = response.needsConfirmation
        return outcome
    }

    private func record(_ response: SafariSnapshotResponse, digest: String) {
        state.lastStats = response.stats
        state.deletionConfirmation = response.needsConfirmation
        // A snapshot held back by the delete guard is sent again next time.
        state.lastUploadDigest = response.needsConfirmation == nil ? digest : nil
    }

    private func verifyWrite(added: [String], original: Data) throws {
        let reread = try? file.read()
        let urls = reread.flatMap { try? SafariBookmarksDocument(data: $0.data) }.map { Set($0.items().map(\.url)) }
        guard let urls, urls.isSuperset(of: added) else {
            _ = try? file.write(original)
            throw SyncError.bookmarksWrite("Safari's bookmarks did not read back correctly after writing, so the previous version was restored.")
        }
    }

    /// Decides which earlier imports Safari kept (confirmed), dropped (parked)
    /// or has not looked at yet (still unconfirmed). Returns how many were
    /// parked now.
    private func reconcilePendingImports(present: Set<String>, modified: Date) -> Int {
        guard !state.pendingImports.isEmpty else { return 0 }
        let rewrittenSinceImport = state.lastOwnWrite.map { abs(modified.timeIntervalSince($0)) > Self.modificationTolerance } ?? true
        var stillPending: [PendingImport] = []
        var newlyParked = 0
        for item in state.pendingImports {
            if present.contains(item.url) {
                let old = now().timeIntervalSince(item.importedAt) > Self.confirmationFallback
                if !(rewrittenSinceImport || old) { stillPending.append(item) }
            } else if rewrittenSinceImport || state.safariLaunchedSinceImport {
                if !state.parkedImports.contains(item.url) {
                    state.parkedImports.append(item.url)
                    newlyParked += 1
                }
            } else {
                stillPending.append(item)
            }
        }
        state.pendingImports = stillPending
        if stillPending.isEmpty { state.safariLaunchedSinceImport = false }
        return newlyParked
    }

    static func digest(_ data: Data, _ unconfirmed: [String]) -> String {
        var hasher = SHA256()
        hasher.update(data: data)
        hasher.update(data: Data(unconfirmed.sorted().joined(separator: "\n").utf8))
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
