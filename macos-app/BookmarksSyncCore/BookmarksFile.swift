import Foundation

/// Reads and writes Safari's Bookmarks.plist.
public protocol BookmarksFileStore: Sendable {
    func read() throws -> (data: Data, modified: Date)
    func modificationDate() throws -> Date
    /// Replaces the file and returns its new modification date.
    func write(_ data: Data) throws -> Date
    /// Saves a copy of `data` outside Safari's folder and returns where.
    func backup(_ data: Data) throws -> URL
}

/// The sandbox only lets the app open what the user picked in an open panel.
/// The user picks either the Safari folder (preferred: the file can then be
/// replaced atomically) or Bookmarks.plist itself. The grant is stored as a
/// security-scoped bookmark and refreshed when macOS reports it as stale.
public final class SecurityScopedBookmarksFile: BookmarksFileStore, @unchecked Sendable {
    public static let defaultsKey = "safariAccessBookmark"
    private static let maxBackups = 20

    private let defaults: UserDefaults
    private let backupsDirectory: URL
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, backupsDirectory: URL) {
        self.defaults = defaults
        self.backupsDirectory = backupsDirectory
    }

    /// The real home folder; inside the sandbox NSHomeDirectory() points into
    /// the container.
    public static var userHome: URL {
        if let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return URL(fileURLWithPath: "/Users/\(NSUserName())", isDirectory: true)
    }

    public static var safariFolder: URL {
        userHome.appendingPathComponent("Library/Safari", isDirectory: true)
    }

    public var hasGrant: Bool { defaults.data(forKey: Self.defaultsKey) != nil }

    /// Stores access to `url` (the Safari folder or Bookmarks.plist) after
    /// checking that the bookmarks file can be read through it.
    public func grant(_ url: URL) throws {
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        let plist = Self.plistURL(for: url)
        guard FileManager.default.isReadableFile(atPath: plist.path) else {
            throw SyncError.bookmarksAccess("There is no readable Bookmarks.plist at \(plist.path). Choose the Safari folder inside your Library folder.")
        }
        do {
            let data = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            defaults.set(data, forKey: Self.defaultsKey)
        } catch {
            throw SyncError.bookmarksAccess("macOS did not allow keeping access to \(url.path): \(error.localizedDescription)")
        }
    }

    public func revokeGrant() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    /// Where access was granted, for display.
    public func grantedPath() -> String? {
        try? resolve().granted.path
    }

    public func grantIsFolder() -> Bool {
        (try? resolve().isFolder) ?? false
    }

    private static func plistURL(for granted: URL) -> URL {
        isDirectory(granted) ? granted.appendingPathComponent("Bookmarks.plist") : granted
    }

    private static func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? url.hasDirectoryPath
    }

    private func resolve() throws -> (granted: URL, plist: URL, isFolder: Bool) {
        guard let data = defaults.data(forKey: Self.defaultsKey) else {
            throw SyncError.bookmarksAccess("Choose your Safari folder in Settings so the app can read Safari's bookmarks.")
        }
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            throw SyncError.bookmarksAccess("Access to Safari's bookmarks was lost. Choose the Safari folder again in Settings.")
        }
        if stale {
            let started = url.startAccessingSecurityScopedResource()
            defer { if started { url.stopAccessingSecurityScopedResource() } }
            if let fresh = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) {
                defaults.set(fresh, forKey: Self.defaultsKey)
            }
        }
        let isFolder = Self.isDirectory(url)
        return (url, isFolder ? url.appendingPathComponent("Bookmarks.plist") : url, isFolder)
    }

    private func withAccess<T>(_ body: (_ plist: URL, _ isFolder: Bool) throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        let resolved = try resolve()
        let started = resolved.granted.startAccessingSecurityScopedResource()
        defer { if started { resolved.granted.stopAccessingSecurityScopedResource() } }
        return try body(resolved.plist, resolved.isFolder)
    }

    public func modificationDate() throws -> Date {
        try withAccess { plist, _ in try Self.modificationDate(of: plist) }
    }

    private static func modificationDate(of url: URL) throws -> Date {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard let date = attributes[.modificationDate] as? Date else { throw SyncError.bookmarksAccess("Bookmarks.plist has no modification date.") }
            return date
        } catch let error as SyncError {
            throw error
        } catch {
            throw SyncError.bookmarksAccess("Safari's bookmarks file cannot be read: \(error.localizedDescription). Choose the Safari folder again in Settings.")
        }
    }

    public func read() throws -> (data: Data, modified: Date) {
        try withAccess { plist, _ in
            var coordinationError: NSError?
            var result: Result<(Data, Date), Error> = .failure(SyncError.bookmarksAccess("Bookmarks.plist could not be read."))
            NSFileCoordinator().coordinate(readingItemAt: plist, options: [], error: &coordinationError) { url in
                result = Result { (try Data(contentsOf: url), try Self.modificationDate(of: url)) }
            }
            if let coordinationError { throw SyncError.bookmarksAccess(coordinationError.localizedDescription) }
            do {
                return try result.get()
            } catch let error as SyncError {
                throw error
            } catch {
                throw SyncError.bookmarksAccess("Safari's bookmarks file cannot be read: \(error.localizedDescription). Choose the Safari folder again in Settings.")
            }
        }
    }

    public func write(_ data: Data) throws -> Date {
        try withAccess { plist, isFolder in
            var coordinationError: NSError?
            var result: Result<Date, Error> = .failure(SyncError.bookmarksWrite("Bookmarks.plist could not be written."))
            NSFileCoordinator().coordinate(writingItemAt: plist, options: [.forReplacing], error: &coordinationError) { url in
                result = Result {
                    if isFolder {
                        // Temporary file + rename: needs write access to the folder.
                        try data.write(to: url, options: [.atomic])
                    } else {
                        // Only the file itself is accessible: overwrite in place.
                        let handle = try FileHandle(forWritingTo: url)
                        defer { try? handle.close() }
                        try handle.truncate(atOffset: 0)
                        try handle.write(contentsOf: data)
                        try handle.synchronize()
                    }
                    return try Self.modificationDate(of: url)
                }
            }
            if let coordinationError { throw SyncError.bookmarksWrite(coordinationError.localizedDescription) }
            do {
                return try result.get()
            } catch {
                throw SyncError.bookmarksWrite("Safari's bookmarks could not be written: \(error.localizedDescription)")
            }
        }
    }

    public func backup(_ data: Data) throws -> URL {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: backupsDirectory, withIntermediateDirectories: true)
            let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate, .withTime, .withColonSeparatorInTime])
                .replacingOccurrences(of: ":", with: "")
            let url = backupsDirectory.appendingPathComponent("Bookmarks-\(stamp).plist")
            try data.write(to: url, options: [.atomic])
            let backups = try fm.contentsOfDirectory(at: backupsDirectory, includingPropertiesForKeys: nil)
                .filter { $0.lastPathComponent.hasPrefix("Bookmarks-") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for old in backups.dropLast(Self.maxBackups) { try? fm.removeItem(at: old) }
            return url
        } catch {
            throw SyncError.bookmarksWrite("A backup of Safari's bookmarks could not be saved, so nothing was changed: \(error.localizedDescription)")
        }
    }
}
