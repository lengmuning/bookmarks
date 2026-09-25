import Foundation

// Types of the sync API v2 (docs/SYNC-V2.md). Keys are mapped explicitly:
// an automatic snake_case strategy would also rewrite the URL keys of
// `canonical_map`.

public struct RemoteBookmark: Codable, Equatable, Sendable {
    public let url: String
    public let title: String?
    public let folderPath: [String]
    public let index: Int?
    public let owner: String
    public let removed: Bool
    public let seq: Int

    public init(url: String, title: String?, folderPath: [String], index: Int? = nil, owner: String = "browser", removed: Bool = false, seq: Int = 0) {
        self.url = url
        self.title = title
        self.folderPath = folderPath
        self.index = index
        self.owner = owner
        self.removed = removed
        self.seq = seq
    }
}

/// One bookmark as read from Safari's plist. `url` is sent exactly as Safari
/// stores it; the server canonicalizes it.
public struct SnapshotItem: Codable, Equatable, Sendable {
    public let url: String
    public let title: String?
    public let folderPath: [String]
    public let index: Int

    public init(url: String, title: String?, folderPath: [String], index: Int) {
        self.url = url
        self.title = title
        self.folderPath = folderPath
        self.index = index
    }
}

public struct SafariSnapshotRequest: Encodable, Equatable, Sendable {
    public let bookmarks: [SnapshotItem]
    public let unconfirmedImports: [String]
    /// Imports deleted in Safari: the server deletes them in the browsers.
    public var deletedImports: [String] = []
    public let confirmDeletions: Bool

    enum CodingKeys: String, CodingKey {
        case bookmarks
        case unconfirmedImports = "unconfirmed_imports"
        case deletedImports = "deleted_imports"
        case confirmDeletions = "confirm_deletions"
    }
}

public struct SnapshotStats: Codable, Equatable, Sendable {
    public let received: Int
    public let accepted: Int
    public let skipped: Int
    public let inserted: Int
    public let updated: Int
    public let restored: Int
    public let unchanged: Int
    public let deleted: Int

    public init(received: Int, accepted: Int, skipped: Int, inserted: Int, updated: Int, restored: Int, unchanged: Int, deleted: Int) {
        self.received = received
        self.accepted = accepted
        self.skipped = skipped
        self.inserted = inserted
        self.updated = updated
        self.restored = restored
        self.unchanged = unchanged
        self.deleted = deleted
    }
}

public struct DeletionConfirmation: Codable, Equatable, Sendable {
    public let count: Int
    public let sample: [String]
}

public struct SafariSnapshotResponse: Decodable, Equatable, Sendable {
    public let cursor: Int
    public let stats: SnapshotStats
    public let canonicalMap: [String: String]
    public let skippedSample: [String]
    public let needsConfirmation: DeletionConfirmation?
    public let pendingImports: [RemoteBookmark]
    /// Canonical URLs deleted in a browser, to remove from Safari. Absent
    /// from Workers older than two-way deletes.
    public var pendingDeletions: [String]? = nil

    enum CodingKeys: String, CodingKey {
        case cursor, stats
        case canonicalMap = "canonical_map"
        case skippedSample = "skipped_sample"
        case needsConfirmation = "needs_confirmation"
        case pendingImports = "pending_imports"
        case pendingDeletions = "pending_deletions"
    }
}

public struct PendingResponse: Decodable, Equatable, Sendable {
    public let cursor: Int
    public let pendingImports: [RemoteBookmark]
    public var pendingDeletions: [String]? = nil

    enum CodingKeys: String, CodingKey {
        case cursor
        case pendingImports = "pending_imports"
        case pendingDeletions = "pending_deletions"
    }
}

/// Answer to `POST /v2/connect`: the access key's group was created (with a
/// first pairing code) or already existed and this Mac joined it.
public struct ConnectResponse: Decodable, Equatable, Sendable {
    public let pairId: String
    public let deviceId: String
    public let token: String
    public let created: Bool
    public let code: String?
    public let codeExpiresAt: Double?

    enum CodingKeys: String, CodingKey {
        case pairId = "pair_id"
        case deviceId = "device_id"
        case token, created, code
        case codeExpiresAt = "code_expires_at"
    }
}

public struct PairingCode: Decodable, Equatable, Sendable {
    public let code: String
    public let codeExpiresAt: Double

    public init(code: String, codeExpiresAt: Double) {
        self.code = code
        self.codeExpiresAt = codeExpiresAt
    }

    enum CodingKeys: String, CodingKey {
        case code
        case codeExpiresAt = "code_expires_at"
    }

    public var expiresAt: Date { Date(timeIntervalSince1970: codeExpiresAt / 1000) }
}

public struct Device: Decodable, Equatable, Sendable {
    public let id: String
    public let platform: String
    public let name: String?
    public let createdAt: Double
    public let lastSeenAt: Double?
    public let isSelf: Bool

    enum CodingKeys: String, CodingKey {
        case id, platform, name
        case createdAt = "created_at"
        case lastSeenAt = "last_seen_at"
        case isSelf = "self"
    }
}

public struct DevicesResponse: Decodable, Sendable {
    public let devices: [Device]
}

public struct WebSocketTicket: Decodable, Equatable, Sendable {
    public let ticket: String
    public let expiresIn: Int
    public let path: String

    enum CodingKeys: String, CodingKey {
        case ticket, path
        case expiresIn = "expires_in"
    }
}

/// Everything needed to talk to the Worker as this Mac. Stored in the Keychain.
public struct Credentials: Codable, Equatable, Sendable {
    public let workerURL: URL
    public let pairId: String
    public let deviceId: String
    public let token: String

    public init(workerURL: URL, pairId: String, deviceId: String, token: String) {
        self.workerURL = workerURL
        self.pairId = pairId
        self.deviceId = deviceId
        self.token = token
    }
}
