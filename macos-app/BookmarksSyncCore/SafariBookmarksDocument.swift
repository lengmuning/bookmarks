import Foundation

/// Safari's Bookmarks.plist, edited as a property list so that every key this
/// app does not know about (iCloud metadata, UUIDs, reading list data) is kept
/// as it was. The file format (binary or XML) is kept too.
///
/// Safari's iCloud sync uploads only what is listed in the top-level
/// `Sync.Changes` array, so every edit also records a change entry there, in
/// the form Safari writes (docs/SYNC-V2.md, "iCloud").
public struct SafariBookmarksDocument {
    /// Top-level folders: plist title and the name used in folder paths.
    static let specialFolders: [(plistTitle: String, name: String)] = [
        ("BookmarksBar", "Favorites"),
        ("BookmarksMenu", "Bookmarks Menu"),
        ("com.apple.ReadingList", "Reading List"),
    ]
    static let fallbackTopLevel = "Bookmarks Menu"
    static let readingList = "Reading List"

    private var root: [String: Any]
    public let format: PropertyListSerialization.PropertyListFormat

    public init(data: Data) throws {
        var format = PropertyListSerialization.PropertyListFormat.binary
        let object: Any
        do {
            object = try PropertyListSerialization.propertyList(from: data, options: [], format: &format)
        } catch {
            throw SyncError.bookmarksFormat("Bookmarks.plist could not be read: \(error.localizedDescription)")
        }
        guard let dict = object as? [String: Any], dict["Children"] is [Any] else {
            throw SyncError.bookmarksFormat("Bookmarks.plist does not look like Safari's bookmarks file.")
        }
        root = dict
        self.format = format == .openStep ? .binary : format
    }

    public func data() throws -> Data {
        do {
            return try PropertyListSerialization.data(fromPropertyList: root, format: format, options: 0)
        } catch {
            throw SyncError.bookmarksFormat("Bookmarks.plist could not be encoded: \(error.localizedDescription)")
        }
    }

    // MARK: Reading

    /// Every bookmark in document order, with its folder path from the top
    /// ("Favorites", "Bookmarks Menu", "Reading List", then folder names).
    public func items() -> [SnapshotItem] {
        var out: [SnapshotItem] = []
        Self.collect(Self.children(of: root), path: [], topLevel: true, into: &out)
        return out
    }

    private static func collect(_ children: [[String: Any]], path: [String], topLevel: Bool, into out: inout [SnapshotItem]) {
        for (index, child) in children.enumerated() {
            switch child["WebBookmarkType"] as? String {
            case "WebBookmarkTypeLeaf":
                guard let url = child["URLString"] as? String, !url.isEmpty else { continue }
                out.append(SnapshotItem(url: url, title: leafTitle(child), folderPath: path, index: index))
            case "WebBookmarkTypeList":
                let title = child["Title"] as? String
                let name = topLevel ? displayName(forTopLevel: title) : trimmed(title)
                collect(Self.children(of: child), path: name.map { path + [$0] } ?? path, topLevel: false, into: &out)
            default:
                continue // History proxy and anything else that is not a bookmark or folder
            }
        }
    }

    // MARK: Writing

    /// Adds bookmarks that came from other browsers and returns the URLs that
    /// were written. URLs already in the document are skipped. Each new leaf
    /// and each folder created for it gets an Add change.
    @discardableResult
    public mutating func add(_ rows: [RemoteBookmark], now: Date) -> [String] {
        var present = Set(items().map(\.url))
        var children = Self.children(of: root)
        var added: [String] = []
        var changes: [[String: Any]] = []

        for row in rows where !present.contains(row.url) {
            let (top, rest) = Self.placement(for: row.folderPath)
            let plistTitle = Self.plistTitle(forTopLevel: top)
            let topIndex: Int
            if let found = children.firstIndex(where: { Self.isFolder($0) && ($0["Title"] as? String) == plistTitle }) {
                topIndex = found
            } else {
                // Top-level folders have fixed iCloud identities; no change entry.
                children.append(Self.makeFolder(title: plistTitle))
                topIndex = children.count - 1
            }
            let leaf = Self.makeLeaf(row, readingList: top == Self.readingList, now: now)
            // The Reading List has no subfolders.
            let path = top == Self.readingList ? [] : rest
            children[topIndex] = Self.insert(leaf, path: path, into: children[topIndex], changes: &changes)
            changes.append(Self.change("Add", for: leaf))
            present.insert(row.url)
            added.append(row.url)
        }

        root["Children"] = children
        record(changes)
        return added
    }

    /// Removes, from every folder, the bookmarks whose URL maps through
    /// `canonical` into `urls` (bookmarks deleted in another browser). Folders
    /// and everything else stay. Returns the canonical URLs that were removed.
    /// A bookmark in iCloud gets a Delete change; one that never reached
    /// iCloud only loses its pending changes.
    @discardableResult
    public mutating func remove(_ urls: Set<String>, canonical: (String) -> String) -> Set<String> {
        guard !urls.isEmpty else { return [] }
        var removed = Set<String>()
        var changes: [[String: Any]] = []
        var dropped = Set<String>()
        func prune(_ node: [String: Any]) -> [String: Any] {
            guard let children = node["Children"] as? [Any] else { return node }
            var node = node
            node["Children"] = children.compactMap { item -> Any? in
                guard let child = item as? [String: Any] else { return item }
                if (child["WebBookmarkType"] as? String) == "WebBookmarkTypeLeaf", let url = child["URLString"] as? String {
                    let key = canonical(url)
                    guard urls.contains(key) else { return child }
                    removed.insert(key)
                    if Self.serverID(of: child) != nil {
                        changes.append(Self.change("Delete", for: child))
                    } else if let uuid = child["WebBookmarkUUID"] as? String {
                        dropped.insert(uuid)
                    }
                    return nil
                }
                return Self.isFolder(child) ? prune(child) : child
            }
            return node
        }
        root = prune(root)
        if !dropped.isEmpty {
            pendingChanges.removeAll { dropped.contains($0["BookmarkUUID"] as? String ?? "") }
        }
        record(changes)
        return removed
    }

    // MARK: iCloud change entries

    /// Whether Safari syncs bookmarks with iCloud on this Mac (it keeps its
    /// CloudKit state at the top of the file). Without it no changes are recorded.
    public var usesICloud: Bool {
        (root["Sync"] as? [String: Any])?["CloudKitMigrationState"] != nil
    }

    /// Change entries Safari's sync agent has not uploaded yet (written by
    /// Safari or by this app).
    public var pendingChangeCount: Int { pendingChanges.count }

    /// Adds an Add change for every bookmark and folder that is neither in
    /// iCloud nor waiting to be uploaded: ones written by earlier versions of
    /// this app, which never told iCloud. Parents come before their children.
    /// Returns how many were registered.
    @discardableResult
    public mutating func registerUnsyncedItems() -> Int {
        guard usesICloud else { return 0 }
        let waiting = Set(pendingChanges.compactMap { $0["BookmarkUUID"] as? String })
        var changes: [[String: Any]] = []
        func visit(_ node: [String: Any]) {
            for child in Self.children(of: node) {
                let type = child["WebBookmarkType"] as? String
                guard type == "WebBookmarkTypeLeaf" || type == "WebBookmarkTypeList" else { continue }
                if Self.serverID(of: child) == nil, let uuid = child["WebBookmarkUUID"] as? String, !waiting.contains(uuid) {
                    changes.append(Self.change("Add", for: child))
                }
                visit(child)
            }
        }
        // Top-level folders (Favorites, Bookmarks Menu, Reading List) are not items.
        Self.children(of: root).filter(Self.isFolder).forEach(visit)
        record(changes)
        return changes.count
    }

    private var pendingChanges: [[String: Any]] {
        get { ((root["Sync"] as? [String: Any])?["Changes"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }
        set {
            var sync = root["Sync"] as? [String: Any] ?? [:]
            if newValue.isEmpty {
                sync.removeValue(forKey: "Changes")
            } else {
                sync["Changes"] = newValue
            }
            root["Sync"] = sync
        }
    }

    private mutating func record(_ changes: [[String: Any]]) {
        guard usesICloud, !changes.isEmpty else { return }
        pendingChanges += changes
    }

    /// A change entry as Safari writes it. Add carries only the item's UUID;
    /// Delete also names the iCloud record and hands back its sync data.
    static func change(_ type: String, for node: [String: Any]) -> [String: Any] {
        var entry: [String: Any] = [
            "Token": UUID().uuidString,
            "Type": type,
            "BookmarkType": isFolder(node) ? "Folder" : "Leaf",
            "BookmarkUUID": node["WebBookmarkUUID"] as? String ?? "",
        ]
        if type == "Delete", let sync = node["Sync"] as? [String: Any], let serverID = sync["ServerID"] as? String {
            entry["BookmarkServerID"] = serverID
            if let data = sync["Data"] as? Data { entry["DeletedBookmarkSyncData"] = data }
        }
        return entry
    }

    private static func serverID(of node: [String: Any]) -> String? {
        guard let id = (node["Sync"] as? [String: Any])?["ServerID"] as? String, !id.isEmpty else { return nil }
        return id
    }

    static func placement(for folderPath: [String]) -> (top: String, rest: [String]) {
        guard let first = folderPath.first else { return (fallbackTopLevel, []) }
        if specialFolders.contains(where: { $0.name == first }) {
            return (first, Array(folderPath.dropFirst()))
        }
        return (fallbackTopLevel, folderPath)
    }

    private static func insert(_ leaf: [String: Any], path: [String], into folder: [String: Any], changes: inout [[String: Any]]) -> [String: Any] {
        var folder = folder
        var children = Self.children(of: folder)
        if let next = path.first {
            let rest = Array(path.dropFirst())
            if let index = children.firstIndex(where: { isFolder($0) && trimmed($0["Title"] as? String) == next }) {
                children[index] = insert(leaf, path: rest, into: children[index], changes: &changes)
            } else {
                let created = makeFolder(title: next)
                changes.append(change("Add", for: created))
                children.append(insert(leaf, path: rest, into: created, changes: &changes))
            }
        } else {
            children.append(leaf)
        }
        folder["Children"] = children
        return folder
    }

    // MARK: Helpers

    private static func children(of node: [String: Any]) -> [[String: Any]] {
        (node["Children"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
    }

    private static func isFolder(_ node: [String: Any]) -> Bool {
        (node["WebBookmarkType"] as? String) == "WebBookmarkTypeList"
    }

    static func trimmed(_ title: String?) -> String? {
        guard let value = title?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private static func displayName(forTopLevel title: String?) -> String? {
        if let special = specialFolders.first(where: { $0.plistTitle == title }) { return special.name }
        return trimmed(title)
    }

    private static func plistTitle(forTopLevel name: String) -> String {
        specialFolders.first(where: { $0.name == name })?.plistTitle ?? name
    }

    private static func leafTitle(_ leaf: [String: Any]) -> String? {
        if let title = (leaf["URIDictionary"] as? [String: Any])?["title"] as? String { return title }
        return leaf["Title"] as? String
    }

    private static func makeFolder(title: String) -> [String: Any] {
        [
            "Title": title,
            "WebBookmarkType": "WebBookmarkTypeList",
            "WebBookmarkUUID": UUID().uuidString,
            "Children": [[String: Any]](),
        ]
    }

    private static func makeLeaf(_ row: RemoteBookmark, readingList: Bool, now: Date) -> [String: Any] {
        var leaf: [String: Any] = [
            "URIDictionary": ["title": row.title ?? row.url],
            "URLString": row.url,
            "WebBookmarkType": "WebBookmarkTypeLeaf",
            "WebBookmarkUUID": UUID().uuidString,
        ]
        if readingList { leaf["ReadingList"] = ["DateAdded": now] }
        return leaf
    }
}

/// Safari's iCloud sync agent uploads pending change entries only after Safari
/// itself saves a bookmark change; nothing outside Safari can ask it directly.
/// The app nudges Safari by adding this Reading List item again: Safari
/// replaces the existing item (no duplicate) and syncs everything pending.
/// The item is never synced to the other browsers.
public enum ICloudTrigger {
    public static let url = "https://github.com/lengmuning/bookmarks#safari-bookmarks-sync"
    public static let title = "Safari Bookmarks Sync"
}
