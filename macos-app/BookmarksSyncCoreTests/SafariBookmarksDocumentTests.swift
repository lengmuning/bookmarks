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

    func testRemovesBookmarksAndKeepsEverythingElse() throws {
        var document = try SafariBookmarksDocument(data: Fixture.data())
        let removed = document.remove(["https://deep.example/", "https://menu.example/", "https://absent.example/"]) { $0 }
        XCTAssertEqual(removed, ["https://deep.example/", "https://menu.example/"])
        let reread = try SafariBookmarksDocument(data: document.data())
        let urls = reread.items().map(\.url)
        XCTAssertFalse(urls.contains("https://deep.example/"))
        XCTAssertFalse(urls.contains("https://menu.example/"))
        XCTAssertTrue(urls.contains("https://news.example/"))
        let root = Fixture.plist(try document.data())
        XCTAssertEqual(root["WebBookmarkUUID"] as? String, "ROOT-UUID")
        XCTAssertNotNil(root["Sync"])
        let bar = (root["Children"] as? [[String: Any]])?.first { $0["Title"] as? String == "BookmarksBar" }
        let tech = (bar?["Children"] as? [[String: Any]])?.first { ($0["Title"] as? String)?.contains("Tech") == true }
        let deep = (tech?["Children"] as? [[String: Any]])?.first { $0["Title"] as? String == "Deep" }
        XCTAssertNotNil(deep, "the emptied folder stays")
    }

    // MARK: iCloud change entries

    func testRecordsNoChangesWithoutICloud() throws {
        var document = try SafariBookmarksDocument(data: Fixture.data())
        XCTAssertFalse(document.usesICloud)
        document.add([RemoteBookmark(url: "https://a.example/", title: "A", folderPath: ["Favorites", "New"])], now: Date())
        document.remove(["https://menu.example/"]) { $0 }
        XCTAssertEqual(document.registerUnsyncedItems(), 0)
        XCTAssertTrue(Fixture.changes(try document.data()).isEmpty)
    }

    func testAddRecordsFoldersBeforeTheirBookmarks() throws {
        var document = try SafariBookmarksDocument(data: Fixture.data(Fixture.iCloudRoot()))
        XCTAssertTrue(document.usesICloud)
        document.add([
            RemoteBookmark(url: "https://a.example/", title: "A", folderPath: ["Favorites", "New", "Sub"]),
            RemoteBookmark(url: "https://b.example/", title: "B", folderPath: ["Favorites", "Tech"]),
            RemoteBookmark(url: "https://github.com/", title: "dup", folderPath: ["Favorites"]),
        ], now: Date())
        let data = try document.data()
        let changes = Fixture.changes(data)
        XCTAssertEqual(changes.map { $0["Type"] as? String }, ["Add", "Add", "Add", "Add"])
        XCTAssertEqual(changes.map { $0["BookmarkType"] as? String }, ["Folder", "Folder", "Leaf", "Leaf"])
        XCTAssertEqual(Set(changes.compactMap { $0["Token"] as? String }).count, 4, "each change has its own token")
        XCTAssertTrue(changes.allSatisfy { $0["BookmarkServerID"] == nil })

        // Every change names a node of the tree; new nodes carry no Sync dict.
        var nodes: [String: [String: Any]] = [:]
        func collect(_ node: [String: Any]) {
            for child in node["Children"] as? [[String: Any]] ?? [] {
                nodes[child["WebBookmarkUUID"] as! String] = child
                collect(child)
            }
        }
        collect(Fixture.plist(data))
        let named = changes.map { nodes[$0["BookmarkUUID"] as! String] }
        XCTAssertEqual(named.map { ($0?["Title"] as? String) ?? ($0?["URLString"] as? String) }, ["New", "Sub", "https://a.example/", "https://b.example/"])
        XCTAssertTrue(named.allSatisfy { $0?["Sync"] == nil })
        XCTAssertEqual(document.pendingChangeCount, 4)
    }

    func testRemoveRecordsDeletesForICloudItemsOnly() throws {
        var root = Fixture.iCloudRoot()
        var menu = (root["Children"] as! [[String: Any]])[2]
        menu["Children"] = (menu["Children"] as! [[String: Any]]) + [Fixture.leaf("Local", "https://local.example/", uuid: "LOCAL-UUID")]
        var children = root["Children"] as! [[String: Any]]
        children[2] = menu
        root["Children"] = children
        var sync = root["Sync"] as! [String: Any]
        sync["Changes"] = [["Token": "T", "Type": "Add", "BookmarkType": "Leaf", "BookmarkUUID": "LOCAL-UUID"]]
        root["Sync"] = sync

        var document = try SafariBookmarksDocument(data: Fixture.data(root))
        let removed = document.remove(["https://github.com/", "https://local.example/"]) { $0 }
        XCTAssertEqual(removed, ["https://github.com/", "https://local.example/"])
        let changes = Fixture.changes(try document.data())
        XCTAssertEqual(changes.count, 1, "the unsynced bookmark only loses its pending Add")
        XCTAssertEqual(changes[0]["Type"] as? String, "Delete")
        XCTAssertEqual(changes[0]["BookmarkType"] as? String, "Leaf")
        XCTAssertEqual(changes[0]["BookmarkUUID"] as? String, "GITHUB-UUID")
        XCTAssertEqual(changes[0]["BookmarkServerID"] as? String, "SERVER-GITHUB-UUID")
        XCTAssertEqual(changes[0]["DeletedBookmarkSyncData"] as? Data, Data([9, 9]))
    }

    func testRegistersItemsThatNeverReachedICloud() throws {
        var root = Fixture.iCloudRoot()
        var children = root["Children"] as! [[String: Any]]
        var menu = children[2]
        menu["Children"] = (menu["Children"] as! [[String: Any]]) + [
            Fixture.folder("Old import", [Fixture.leaf("Inside", "https://inside.example/", uuid: "INSIDE-UUID")]),
            Fixture.leaf("Pending", "https://pending.example/", uuid: "PENDING-UUID"),
        ]
        children[2] = menu
        root["Children"] = children
        var sync = root["Sync"] as! [String: Any]
        sync["Changes"] = [["Token": "T", "Type": "Add", "BookmarkType": "Leaf", "BookmarkUUID": "PENDING-UUID"]]
        root["Sync"] = sync

        var document = try SafariBookmarksDocument(data: Fixture.data(root))
        XCTAssertEqual(document.registerUnsyncedItems(), 2)
        let changes = Fixture.changes(try document.data())
        XCTAssertEqual(changes.count, 3)
        XCTAssertEqual(changes[1]["BookmarkType"] as? String, "Folder", "the folder comes before what it holds")
        XCTAssertEqual(changes[2]["BookmarkUUID"] as? String, "INSIDE-UUID")
        XCTAssertEqual(document.registerUnsyncedItems(), 0, "registered items are not registered again")
    }
}

final class SafariBookmarksLockTests: XCTestCase {
    var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    var lockFolder: URL { folder.appendingPathComponent("lock") }

    func details() throws -> [String: Any] {
        let data = try Data(contentsOf: lockFolder.appendingPathComponent("details.plist"))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func writeDetails(pid: Int, host: String?) throws {
        try FileManager.default.createDirectory(at: lockFolder, withIntermediateDirectories: false)
        let details: [String: Any] = ["LockFileProcessID": pid, "LockFileHostname": host ?? "OTHER-MAC", "LockFileDate": Date()]
        try PropertyListSerialization.data(fromPropertyList: details, format: .xml, options: 0)
            .write(to: lockFolder.appendingPathComponent("details.plist"))
    }

    func testTakesTheLockTheWaySafariDoes() throws {
        let lock = try XCTUnwrap(SafariBookmarksLock.acquire(in: folder))
        let taken = try details()
        XCTAssertEqual(taken["LockFileProcessID"] as? Int, Int(getpid()))
        XCTAssertEqual(taken["LockFileHostname"] as? String, SafariBookmarksLock.platformUUID)
        XCTAssertNotNil(taken["LockFileDate"] as? Date)
        XCTAssertNil(SafariBookmarksLock.acquire(in: folder), "a held lock is not taken twice")
        lock.release()
        XCTAssertFalse(FileManager.default.fileExists(atPath: lockFolder.path))
    }

    func testWaitsForALiveHolder() throws {
        try writeDetails(pid: Int(getppid()), host: SafariBookmarksLock.platformUUID)
        XCTAssertNil(SafariBookmarksLock.acquire(in: folder))
    }

    func testTakesOverALockWhoseProcessIsGone() throws {
        try writeDetails(pid: 999_999, host: SafariBookmarksLock.platformUUID)
        let lock = try XCTUnwrap(SafariBookmarksLock.acquire(in: folder))
        XCTAssertEqual(try details()["LockFileProcessID"] as? Int, Int(getpid()))
        lock.release()
    }

    func testLeavesAnotherMacsLockAlone() throws {
        try writeDetails(pid: 999_999, host: nil)
        XCTAssertNil(SafariBookmarksLock.acquire(in: folder))
    }
}
