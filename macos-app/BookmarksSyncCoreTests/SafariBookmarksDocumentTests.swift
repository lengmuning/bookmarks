import XCTest
@testable import BookmarksSyncCore

final class SafariBookmarksDocumentTests: XCTestCase {
    func testReadsBookmarksWithFolderPaths() throws {
        let items = try SafariBookmarksDocument(data: Fixture.data()).items()
        XCTAssertEqual(items, [
            SnapshotItem(url: "https://github.com/", title: "GitHub", folderPath: ["Favorites"], index: 0),
            SnapshotItem(url: "https://news.example/", title: "News", folderPath: ["Favorites", "Tech"], index: 0),
            SnapshotItem(url: "https://deep.example/", title: nil, folderPath: ["Favorites", "Tech", "Deep"], index: 0),
            SnapshotItem(url: "javascript:void(0)", title: "Bookmarklet", folderPath: ["Favorites"], index: 2),
            SnapshotItem(url: "https://menu.example/", title: "Menu item", folderPath: ["Bookmarks Menu"], index: 0),
            SnapshotItem(url: "https://read.example/", title: "Read later", folderPath: ["Reading List"], index: 0),
        ])
    }

    func testAddsBookmarksIntoSafariFolders() throws {
        var document = try SafariBookmarksDocument(data: Fixture.data())
        let added = document.add([
            RemoteBookmark(url: "https://a.example/", title: "A", folderPath: ["Favorites", "Tech"]),
            RemoteBookmark(url: "https://b.example/", title: "B", folderPath: ["Favorites", "New", "Sub"]),
            RemoteBookmark(url: "https://c.example/", title: nil, folderPath: ["Work"]),
            RemoteBookmark(url: "https://d.example/", title: "D", folderPath: []),
            RemoteBookmark(url: "https://e.example/", title: "E", folderPath: ["Reading List", "ignored"]),
            RemoteBookmark(url: "https://github.com/", title: "dup", folderPath: ["Favorites"]),
        ], now: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(added, ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/", "https://e.example/"])

        let reread = try SafariBookmarksDocument(data: document.data())
        let paths = Dictionary(uniqueKeysWithValues: reread.items().map { ($0.url, $0.folderPath) })
        XCTAssertEqual(paths["https://a.example/"], ["Favorites", "Tech"])
        XCTAssertEqual(paths["https://b.example/"], ["Favorites", "New", "Sub"])
        XCTAssertEqual(paths["https://c.example/"], ["Bookmarks Menu", "Work"])
        XCTAssertEqual(paths["https://d.example/"], ["Bookmarks Menu"])
        XCTAssertEqual(paths["https://e.example/"], ["Reading List"])
        XCTAssertEqual(reread.items().filter { $0.url == "https://github.com/" }.count, 1)
        XCTAssertEqual(reread.items().first { $0.url == "https://c.example/" }?.title, "https://c.example/")
    }

    func testReusesFoldersAndKeepsUnknownKeys() throws {
        var document = try SafariBookmarksDocument(data: Fixture.data())
        document.add([RemoteBookmark(url: "https://a.example/", title: "A", folderPath: ["Favorites", "Tech"])], now: Date())
        let root = Fixture.plist(try document.data())

        XCTAssertEqual(root["WebBookmarkUUID"] as? String, "ROOT-UUID")
        XCTAssertEqual(root["WebBookmarkFileVersion"] as? Int, 1)
        XCTAssertEqual((root["Sync"] as? [String: Any])?["ServerData"] as? Data, Data([1, 2, 3]))

        let children = root["Children"] as! [[String: Any]]
        XCTAssertEqual(children.count, 4, "no new top-level folder")
        let bar = children[1]["Children"] as! [[String: Any]]
        XCTAssertEqual(bar.filter { ($0["Title"] as? String)?.contains("Tech") == true }.count, 1, "' Tech ' is reused, not duplicated")
        XCTAssertEqual(bar[0]["WebBookmarkUUID"] as? String, "GITHUB-UUID")
        let readingList = children[3]
        XCTAssertEqual(readingList["ShouldOmitFromUI"] as? Bool, true)
    }

    func testNewNodesLookLikeSafariNodes() throws {
        var document = try SafariBookmarksDocument(data: Fixture.data())
        let now = Date(timeIntervalSince1970: 1_000)
        document.add([
            RemoteBookmark(url: "https://n.example/", title: "N", folderPath: ["Favorites", "Fresh"]),
            RemoteBookmark(url: "https://r.example/", title: "R", folderPath: ["Reading List"]),
        ], now: now)
        let root = Fixture.plist(try document.data())
        let children = root["Children"] as! [[String: Any]]
        let fresh = (children[1]["Children"] as! [[String: Any]]).first { $0["Title"] as? String == "Fresh" }!
        XCTAssertEqual(fresh["WebBookmarkType"] as? String, "WebBookmarkTypeList")
        XCTAssertNotNil(UUID(uuidString: fresh["WebBookmarkUUID"] as! String))
        let leaf = (fresh["Children"] as! [[String: Any]])[0]
        XCTAssertEqual(leaf["URLString"] as? String, "https://n.example/")
        XCTAssertEqual((leaf["URIDictionary"] as? [String: Any])?["title"] as? String, "N")
        XCTAssertNotNil(UUID(uuidString: leaf["WebBookmarkUUID"] as! String))
        let reading = (children[3]["Children"] as! [[String: Any]]).last!
        XCTAssertEqual((reading["ReadingList"] as? [String: Any])?["DateAdded"] as? Date, now)
    }

    func testKeepsTheFileFormat() throws {
        let binary = try SafariBookmarksDocument(data: Fixture.data(format: .binary)).data()
        XCTAssertTrue(binary.starts(with: Data("bplist".utf8)))
        let xml = try SafariBookmarksDocument(data: Fixture.data(format: .xml)).data()
        XCTAssertTrue(String(decoding: xml.prefix(5), as: UTF8.self) == "<?xml")
    }

    func testRejectsFilesThatAreNotSafariBookmarks() {
        XCTAssertThrowsError(try SafariBookmarksDocument(data: Data("hello".utf8)))
        XCTAssertThrowsError(try SafariBookmarksDocument(data: Fixture.data(["Title": "no children"])))
    }
}
