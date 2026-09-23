import Foundation

/// A bookmark this app wrote into Safari's plist that Safari has not yet been
/// seen keeping (docs/SYNC-V2.md, "Safari import").
public struct PendingImport: Codable, Equatable, Sendable {
    public let url: String
    public let importedAt: Date
}

public struct SyncState: Codable, Equatable, Sendable {
    public var pendingImports: [PendingImport] = []
    /// Imports Safari dropped (for example when iCloud replaced the file).
    /// They are not imported again until the user retries.
    public var parkedImports: [String] = []
    /// Modification date of the plist right after this app last wrote it.
    public var lastOwnWrite: Date?
    public var safariLaunchedSinceImport = false
    /// Digest of the last snapshot the server accepted, to skip re-uploads.
    public var lastUploadDigest: String?
    public var deletionConfirmation: DeletionConfirmation?
    public var waitingForSafariToQuit = 0
    public var lastSyncAt: Date?
    public var lastStats: SnapshotStats?
    public var lastError: String?

    public init() {}
}

public protocol SyncStateStore: Sendable {
    func load() -> SyncState
    func save(_ state: SyncState)
}

public final class FileSyncStateStore: SyncStateStore, @unchecked Sendable {
    private let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func load() -> SyncState {
        guard let data = try? Data(contentsOf: url),
              let state = try? JSONDecoder().decode(SyncState.self, from: data)
        else { return SyncState() }
        return state
    }

    public func save(_ state: SyncState) {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(state).write(to: url, options: [.atomic])
        } catch {
            NSLog("BookmarksSync: could not save state: %@", error.localizedDescription)
        }
    }
}

public final class MemorySyncStateStore: SyncStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state: SyncState

    public init(_ state: SyncState = SyncState()) {
        self.state = state
    }

    public func load() -> SyncState {
        lock.withLock { state }
    }

    public func save(_ state: SyncState) {
        lock.withLock { self.state = state }
    }
}
