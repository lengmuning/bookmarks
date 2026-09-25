import CryptoKit
import Foundation

public protocol SafariActivity: Sendable {
    var isSafariRunning: Bool { get }
}

public struct SyncOutcome: Equatable, Sendable {
    public var uploaded = false
    public var imported = 0
    /// Bookmarks deleted in another browser and removed from Safari.
    public var removedFromSafari = 0
    /// Bookmarks from other browsers that the user deleted in Safari.
    public var deletedInSafari = 0
    public var waitingForSafariToQuit = 0
    public var needsConfirmation: DeletionConfirmation?
    public var stats: SnapshotStats?

    public init() {}
}

/// One sync cycle for Safari (docs/SYNC-V2.md): upload the plist as a
/// snapshot, then apply what changed in other browsers (additions and
/// deletions) to the plist while Safari is not running. Runs are serialized.
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

        outcome.deletedInSafari = reconcilePendingImports(present: present, modified: modified)

        var pending: [RemoteBookmark] = []
        var deletions: [String] = []
        var skipUpload = digest(data) == state.lastUploadDigest && state.deletionConfirmation == nil && !confirmDeletions
        if skipUpload {
            let quick = try await api.safariPending()
            pending = quick.pendingImports
            // Removing bookmarks needs the canonical map of a fresh snapshot.
            if !(quick.pendingDeletions ?? []).isEmpty { skipUpload = false }
        }
        if !skipUpload {
            let response = try await upload(items, data: data, confirmDeletions: confirmDeletions)
            outcome.uploaded = true
            outcome.stats = response.stats
            outcome.needsConfirmation = response.needsConfirmation
            pending = response.pendingImports
            deletions = response.pendingDeletions ?? []
        }

        let map = state.canonicalMap
        let canonical: (String) -> String = { map[$0] ?? $0 }
        let presentCanonical = Set(present.map(canonical))
        let deletedHere = Set(state.deletedImports)
        let toImport = pending.filter { !presentCanonical.contains($0.url) && !deletedHere.contains($0.url) }
        let toRemove = Set(deletions).intersection(presentCanonical)
        guard !toImport.isEmpty || !toRemove.isEmpty else {
            state.waitingForSafariToQuit = 0
            return outcome
        }
        guard !safari.isSafariRunning else {
            state.waitingForSafariToQuit = toImport.count + toRemove.count
            outcome.waitingForSafariToQuit = state.waitingForSafariToQuit
            return outcome
        }

        var updated = document
        let added = updated.add(toImport, now: now())
        let removed = updated.remove(toRemove, canonical: canonical)
        let newData = try updated.data()
        _ = try file.backup(data)
        guard !safari.isSafariRunning else {
            state.waitingForSafariToQuit = toImport.count + toRemove.count
            outcome.waitingForSafariToQuit = state.waitingForSafariToQuit
            return outcome
        }
        let written = try file.write(newData)
        try verifyWrite(added: added, removed: removed, canonical: canonical, original: data)

        state.lastOwnWrite = written
        if !added.isEmpty { state.safariLaunchedSinceImport = false }
        state.pendingImports.removeAll { removed.contains(canonical($0.url)) }
        state.pendingImports += added.map { PendingImport(url: $0, importedAt: now()) }
        state.waitingForSafariToQuit = 0
        outcome.imported = added.count
        outcome.removedFromSafari = removed.count

        // Tell the server what Safari has now: the imports (still owned by the
        // browsers) and the removals, which completes those deletes.
        let response = try await upload(updated.items(), data: newData, confirmDeletions: false)
        outcome.needsConfirmation = response.needsConfirmation
        return outcome
    }

    private func upload(_ items: [SnapshotItem], data: Data, confirmDeletions: Bool) async throws -> SafariSnapshotResponse {
        let sentDeletions = state.deletedImports
        let response = try await api.safariSnapshot(
            SafariSnapshotRequest(
                bookmarks: items,
                unconfirmedImports: state.pendingImports.map(\.url),
                deletedImports: sentDeletions,
                confirmDeletions: confirmDeletions
            )
        )
        state.canonicalMap = response.canonicalMap
        state.lastStats = response.stats
        state.deletionConfirmation = response.needsConfirmation
        if response.needsConfirmation == nil {
            state.deletedImports.removeAll { sentDeletions.contains($0) }
            state.lastUploadDigest = digest(data)
        } else {
            // A snapshot held back by the delete guard is sent again next time.
            state.lastUploadDigest = nil
        }
        return response
    }

    private func digest(_ data: Data) -> String {
        Self.digest(data, state.pendingImports.map(\.url), state.deletedImports)
    }

    private func verifyWrite(added: [String], removed: Set<String>, canonical: (String) -> String, original: Data) throws {
        let reread = try? file.read()
        let urls = reread.flatMap { try? SafariBookmarksDocument(data: $0.data) }.map { Set($0.items().map(\.url)) }
        guard let urls, urls.isSuperset(of: added), urls.allSatisfy({ !removed.contains(canonical($0)) }) else {
            _ = try? file.write(original)
            throw SyncError.bookmarksWrite("Safari's bookmarks did not read back correctly after writing, so the previous version was restored.")
        }
    }

    /// Decides which earlier imports Safari kept (confirmed), lost (deleted in
    /// Safari, to be deleted in the browsers too) or has not looked at yet
    /// (still unconfirmed). Returns how many were found deleted now.
    private func reconcilePendingImports(present: Set<String>, modified: Date) -> Int {
        guard !state.pendingImports.isEmpty else { return 0 }
        let rewrittenSinceImport = state.lastOwnWrite.map { abs(modified.timeIntervalSince($0)) > Self.modificationTolerance } ?? true
        var stillPending: [PendingImport] = []
        var deleted = 0
        for item in state.pendingImports {
            if present.contains(item.url) {
                let old = now().timeIntervalSince(item.importedAt) > Self.confirmationFallback
                if !(rewrittenSinceImport || old) { stillPending.append(item) }
            } else if rewrittenSinceImport || state.safariLaunchedSinceImport {
                if !state.deletedImports.contains(item.url) {
                    state.deletedImports.append(item.url)
                    deleted += 1
                }
            } else {
                stillPending.append(item)
            }
        }
        state.pendingImports = stillPending
        if stillPending.isEmpty { state.safariLaunchedSinceImport = false }
        return deleted
    }

    static func digest(_ data: Data, _ unconfirmed: [String], _ deletedImports: [String] = []) -> String {
        var hasher = SHA256()
        hasher.update(data: data)
        hasher.update(data: Data(unconfirmed.sorted().joined(separator: "\n").utf8))
        if !deletedImports.isEmpty {
            hasher.update(data: Data(("\u{0}" + deletedImports.sorted().joined(separator: "\n")).utf8))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
