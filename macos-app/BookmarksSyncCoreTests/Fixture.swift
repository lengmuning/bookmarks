import Foundation
@testable import BookmarksSyncCore

/// A small bookmarks file with the same structure Safari writes: a History
/// proxy, the three special folders, nested folders, a bookmarklet, a reading
/// list item and top-level keys the app must keep.
enum Fixture {
    static func leaf(_ title: String?, _ url: String, uuid: String = UUID().uuidString, extra: [String: Any] = [:]) -> [String: Any] {
        var node: [String: Any] = [
            "URLString": url,
            "WebBookmarkType": "WebBookmarkTypeLeaf",
            "WebBookmarkUUID": uuid,
        ]
        if let title { node["URIDictionary"] = ["title": title] }
        return node.merging(extra) { $1 }
    }

    static func folder(_ title: String, _ children: [[String: Any]], extra: [String: Any] = [:]) -> [String: Any] {
        [
            "Title": title,
            "WebBookmarkType": "WebBookmarkTypeList",
            "WebBookmarkUUID": UUID().uuidString,
            "Children": children,
        ].merging(extra) { $1 }
    }

    static func root(favorites: [[String: Any]]? = nil) -> [String: Any] {
        [
            "Children": [
                [
                    "Title": "History",
                    "WebBookmarkIdentifier": "History",
                    "WebBookmarkType": "WebBookmarkTypeProxy",
                    "WebBookmarkUUID": UUID().uuidString,
                ],
                folder("BookmarksBar", favorites ?? [
                    leaf("GitHub", "https://github.com/", uuid: "GITHUB-UUID"),
                    folder(" Tech ", [
                        leaf("News", "https://news.example/"),
                        folder("Deep", [leaf(nil, "https://deep.example/")]),
                    ]),
                    leaf("Bookmarklet", "javascript:void(0)"),
                ]),
                folder("BookmarksMenu", [leaf("Menu item", "https://menu.example/")]),
                folder(
                    "com.apple.ReadingList",
                    [leaf("Read later", "https://read.example/", extra: ["ReadingList": ["DateAdded": Date(timeIntervalSince1970: 0)]])],
                    extra: ["ShouldOmitFromUI": true]
                ),
            ],
            "Title": "",
            "WebBookmarkFileVersion": 1,
            "WebBookmarkType": "WebBookmarkTypeList",
            "WebBookmarkUUID": "ROOT-UUID",
            "Sync": ["ServerData": Data([1, 2, 3])],
        ]
    }

    static func data(_ root: [String: Any] = root(), format: PropertyListSerialization.PropertyListFormat = .binary) -> Data {
        try! PropertyListSerialization.data(fromPropertyList: root, format: format, options: 0)
    }

    static func plist(_ data: Data) -> [String: Any] {
        try! PropertyListSerialization.propertyList(from: data, options: [], format: nil) as! [String: Any]
    }
}
