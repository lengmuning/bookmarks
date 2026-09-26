import Foundation

/// A bookmark this app wrote into Safari's plist that Safari has not yet been
/// seen keeping (docs/SYNC-V2.md, "Safari import").
public struct PendingImport: Codable, Equatable, Sendable {
    public let url: String
    public let importedAt: Date
}

public struct SyncState: Codable, Equatable, Sendable {
    public var pendingImports: [PendingImport] = []
    /// Imports that disappeared from Safari after Safari rewrote the file:
    /// deleted in Safari, so deleted in the browsers too. Kept until the
    /// server has applied them.
    public var deletedImports: [String] = []
    /// Raw Safari URL -> canonical URL, from the last snapshot the server
    /// answered. Used to find bookmarks the server asks to remove.
    public var canonicalMap: [String: String] = [:]
    /// Modification date of the plist right after this app last wrote it.
    public var lastOwnWrite: Date?
    public var safariLaunchedSinceImport = false
    /// Digest of the last snapshot the server accepted, to skip re-uploads.
    public var lastUploadDigest: String?
    public var deletionConfirmation: DeletionConfirmation?
    /// Changes from other browsers (additions and deletions) waiting for
    /// Safari to quit.
    public var waitingForSafariToQuit = 0
    /// This app wrote change entries into the plist that Safari's iCloud sync
    /// has not uploaded yet; Safari needs a nudge once it runs.
    public var iCloudUploadPending = false
    /// Bookmarks written by versions before 2.1 never reached iCloud; they are
    /// registered for upload once.
    public var registeredUnsyncedItems = false
    public var lastSyncAt: Date?
    public var lastStats: SnapshotStats?
    public var lastError: String?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case pendingImports, deletedImports, canonicalMap, lastOwnWrite, safariLaunchedSinceImport, lastUploadDigest
        case deletionConfirmation, waitingForSafariToQuit, iCloudUploadPending, registeredUnsyncedItems
        case lastSyncAt, lastStats, lastError
        /// Written by 2.0.1 and earlier: imports Safari "dropped", now treated
        /// as deleted in Safari.
        case parkedImports
    }

    // Every field is optional so a state file from an older version keeps
    // what it has instead of being discarded.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pendingImports = try c.decodeIfPresent([PendingImport].self, forKey: .pendingImports) ?? []
        deletedImports = try c.decodeIfPresent([String].self, forKey: .deletedImports) ?? []
        deletedImports += (try c.decodeIfPresent([String].self, forKey: .parkedImports) ?? []).filter { !deletedImports.contains($0) }
        canonicalMap = try c.decodeIfPresent([String: String].self, forKey: .canonicalMap) ?? [:]
        lastOwnWrite = try c.decodeIfPresent(Date.self, forKey: .lastOwnWrite)
        safariLaunchedSinceImport = try c.decodeIfPresent(Bool.self, forKey: .safariLaunchedSinceImport) ?? false
        lastUploadDigest = try c.decodeIfPresent(String.self, forKey: .lastUploadDigest)
        deletionConfirmation = try c.decodeIfPresent(DeletionConfirmation.self, forKey: .deletionConfirmation)
        waitingForSafariToQuit = try c.decodeIfPresent(Int.self, forKey: .waitingForSafariToQuit) ?? 0
        iCloudUploadPending = try c.decodeIfPresent(Bool.self, forKey: .iCloudUploadPending) ?? false
        registeredUnsyncedItems = try c.decodeIfPresent(Bool.self, forKey: .registeredUnsyncedItems) ?? false
        lastSyncAt = try c.decodeIfPresent(Date.self, forKey: .lastSyncAt)
        lastStats = try c.decodeIfPresent(SnapshotStats.self, forKey: .lastStats)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pendingImports, forKey: .pendingImports)
        try c.encode(deletedImports, forKey: .deletedImports)
        try c.encode(canonicalMap, forKey: .canonicalMap)
        try c.encodeIfPresent(lastOwnWrite, forKey: .lastOwnWrite)
        try c.encode(safariLaunchedSinceImport, forKey: .safariLaunchedSinceImport)
        try c.encodeIfPresent(lastUploadDigest, forKey: .lastUploadDigest)
        try c.encodeIfPresent(deletionConfirmation, forKey: .deletionConfirmation)
        try c.encode(waitingForSafariToQuit, forKey: .waitingForSafariToQuit)
        try c.encode(iCloudUploadPending, forKey: .iCloudUploadPending)
        try c.encode(registeredUnsyncedItems, forKey: .registeredUnsyncedItems)
        try c.encodeIfPresent(lastSyncAt, forKey: .lastSyncAt)
        try c.encodeIfPresent(lastStats, forKey: .lastStats)
        try c.encodeIfPresent(lastError, forKey: .lastError)
    }
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
