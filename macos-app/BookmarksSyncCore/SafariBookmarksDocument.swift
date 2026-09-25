import Foundation

/// Safari's Bookmarks.plist, edited as a property list so that every key this
/// app does not know about (iCloud metadata, UUIDs, reading list data) is kept
/// as it was. The file format (binary or XML) is kept too.
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
    /// were written. URLs already in the document are skipped.
    @discardableResult
    public mutating func add(_ rows: [RemoteBookmark], now: Date) -> [String] {
        var present = Set(items().map(\.url))
        var children = Self.children(of: root)
        var added: [String] = []

        for row in rows where !present.contains(row.url) {
            let (top, rest) = Self.placement(for: row.folderPath)
            let plistTitle = Self.plistTitle(forTopLevel: top)
            let topIndex: Int
            if let found = children.firstIndex(where: { Self.isFolder($0) && ($0["Title"] as? String) == plistTitle }) {
                topIndex = found
            } else {
                children.append(Self.makeFolder(title: plistTitle))
                topIndex = children.count - 1
            }
            let leaf = Self.makeLeaf(row, readingList: top == Self.readingList, now: now)
            // The Reading List has no subfolders.
            let path = top == Self.readingList ? [] : rest
            children[topIndex] = Self.insert(leaf, path: path, into: children[topIndex])
            present.insert(row.url)
            added.append(row.url)
        }

        root["Children"] = children
        return added
    }

    /// Removes, from every folder, the bookmarks whose URL maps through
    /// `canonical` into `urls` (bookmarks deleted in another browser). Folders
    /// and everything else stay. Returns the canonical URLs that were removed.
    @discardableResult
    public mutating func remove(_ urls: Set<String>, canonical: (String) -> String) -> Set<String> {
        guard !urls.isEmpty else { return [] }
        var removed = Set<String>()
        func prune(_ node: [String: Any]) -> [String: Any] {
            guard let children = node["Children"] as? [Any] else { return node }
            var node = node
            node["Children"] = children.compactMap { item -> Any? in
                guard let child = item as? [String: Any] else { return item }
                if (child["WebBookmarkType"] as? String) == "WebBookmarkTypeLeaf", let url = child["URLString"] as? String {
                    let key = canonical(url)
                    guard urls.contains(key) else { return child }
                    removed.insert(key)
                    return nil
                }
                return Self.isFolder(child) ? prune(child) : child
            }
            return node
        }
        root = prune(root)
        return removed
    }

    static func placement(for folderPath: [String]) -> (top: String, rest: [String]) {
        guard let first = folderPath.first else { return (fallbackTopLevel, []) }
        if specialFolders.contains(where: { $0.name == first }) {
            return (first, Array(folderPath.dropFirst()))
        }
        return (fallbackTopLevel, folderPath)
    }

    private static func insert(_ leaf: [String: Any], path: [String], into folder: [String: Any]) -> [String: Any] {
        var folder = folder
        var children = Self.children(of: folder)
        if let next = path.first {
            let rest = Array(path.dropFirst())
            if let index = children.firstIndex(where: { isFolder($0) && trimmed($0["Title"] as? String) == next }) {
                children[index] = insert(leaf, path: rest, into: children[index])
            } else {
                children.append(insert(leaf, path: rest, into: makeFolder(title: next)))
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
