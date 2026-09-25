import XCTest
@testable import BookmarksSyncCore

final class FakeFile: BookmarksFileStore, @unchecked Sendable {
    var data: Data
    var modified = Date(timeIntervalSince1970: 1_000)
    var writes: [Data] = []
    var backups: [Data] = []
    var corruptNextWrite = false

    init(_ data: Data) { self.data = data }

    func read() throws -> (data: Data, modified: Date) { (data, modified) }
    func modificationDate() throws -> Date { modified }

    func write(_ data: Data) throws -> Date {
        writes.append(data)
        self.data = corruptNextWrite ? Data("garbage".utf8) : data
        corruptNextWrite = false
        modified = modified.addingTimeInterval(10)
        return modified
    }

    func backup(_ data: Data) throws -> URL {
        backups.append(data)
        return URL(fileURLWithPath: "/tmp/backup-\(backups.count).plist")
    }

    /// Simulates Safari rewriting its file.
    func safariRewrites(_ root: [String: Any]) {
        data = Fixture.data(root)
        modified = modified.addingTimeInterval(60)
    }
}

/// A tiny stand-in for the Worker: remembers browser-owned bookmarks and
/// reports the ones Safari does not have as pending imports, and the
/// bookmarks deleted in a browser as pending deletions until Safari lost them.
final class FakeAPI: SafariSyncAPI, @unchecked Sendable {
    var browserRows: [RemoteBookmark] = []
    var pendingDeletions: [String] = []
    var snapshots: [SafariSnapshotRequest] = []
    var pendingCalls = 0
    var needsConfirmation: DeletionConfirmation?
    var canonicalMap: [String: String] = [:]

    private let stats = SnapshotStats(received: 0, accepted: 0, skipped: 0, inserted: 0, updated: 0, restored: 0, unchanged: 0, deleted: 0)

    func safariSnapshot(_ request: SafariSnapshotRequest) async throws -> SafariSnapshotResponse {
        snapshots.append(request)
        let confirmation = request.confirmDeletions ? nil : needsConfirmation
        let inSafari = Set(request.bookmarks.map { canonicalMap[$0.url] ?? $0.url })
        // Confirmed imports become Safari's; unconfirmed ones stay browser-owned.
        let unconfirmed = Set(request.unconfirmedImports)
        if confirmation == nil { browserRows.removeAll { request.deletedImports.contains($0.url) } }
        browserRows.removeAll { inSafari.contains($0.url) && !unconfirmed.contains($0.url) }
        pendingDeletions.removeAll { !inSafari.contains($0) }
        return SafariSnapshotResponse(
            cursor: 1,
            stats: stats,
            canonicalMap: canonicalMap,
            skippedSample: [],
            needsConfirmation: confirmation,
            pendingImports: browserRows.filter { !inSafari.contains($0.url) },
            pendingDeletions: pendingDeletions
        )
    }

    func safariPending() async throws -> PendingResponse {
        pendingCalls += 1
        let lastSeen = Set(snapshots.last?.bookmarks.map(\.url) ?? [])
        return PendingResponse(cursor: 1, pendingImports: browserRows.filter { !lastSeen.contains($0.url) }, pendingDeletions: pendingDeletions)
    }
}

final class FakeSafari: SafariActivity, @unchecked Sendable {
    var isSafariRunning = false
}

final class SyncEngineTests: XCTestCase {
    var file: FakeFile!
    var api: FakeAPI!
    var safari: FakeSafari!
    var store: MemorySyncStateStore!
    var clock = Date(timeIntervalSince1970: 1_000)

    override func setUp() {
        file = FakeFile(Fixture.data())
        api = FakeAPI()
        safari = FakeSafari()
        store = MemorySyncStateStore()
        clock = Date(timeIntervalSince1970: 1_000)
    }

    func makeEngine() -> SyncEngine {
        let clock = self.clock
        return SyncEngine(api: api, file: file, safari: safari, store: store, now: { clock })
    }

    let chromeAddition = RemoteBookmark(url: "https://chrome.example/", title: "From Chrome", folderPath: ["Favorites", "New"])

    func urlsInFile() throws -> [String] {
        try SafariBookmarksDocument(data: file.data).items().map(\.url)
    }

    func testUploadsTheSnapshot() async throws {
        let outcome = try await makeEngine().sync()
        XCTAssertTrue(outcome.uploaded)
        XCTAssertEqual(api.snapshots.count, 1)
        XCTAssertEqual(api.snapshots[0].bookmarks.count, 6)
        XCTAssertEqual(api.snapshots[0].unconfirmedImports, [])
        XCTAssertTrue(file.writes.isEmpty)
    }

    func testImportsBrowserAdditionsWhileSafariIsClosed() async throws {
        api.browserRows = [chromeAddition]
        let outcome = try await makeEngine().sync()
        XCTAssertEqual(outcome.imported, 1)
        XCTAssertEqual(file.backups.count, 1, "backup before writing")
        XCTAssertEqual(file.writes.count, 1)
        XCTAssertTrue(try urlsInFile().contains("https://chrome.example/"))
        XCTAssertEqual(api.snapshots.count, 2, "the server learns that Safari has it")
        XCTAssertEqual(api.snapshots[1].unconfirmedImports, ["https://chrome.example/"])
        XCTAssertEqual(store.load().pendingImports.map(\.url), ["https://chrome.example/"])
    }

    func testWaitsForSafariToQuitBeforeWriting() async throws {
        api.browserRows = [chromeAddition]
        safari.isSafariRunning = true
        let engine = makeEngine()
        let outcome = try await engine.sync()
        XCTAssertEqual(outcome.waitingForSafariToQuit, 1)
        XCTAssertTrue(file.writes.isEmpty)

        safari.isSafariRunning = false
        let later = try await engine.sync()
        XCTAssertEqual(later.imported, 1)
        XCTAssertEqual(store.load().waitingForSafariToQuit, 0)
    }

    func testDoesNotReuploadAnUnchangedFile() async throws {
        let engine = makeEngine()
        _ = try await engine.sync()
        let second = try await engine.sync()
        XCTAssertFalse(second.uploaded)
        XCTAssertEqual(api.snapshots.count, 1)
        XCTAssertEqual(api.pendingCalls, 1)
    }

    func testConfirmsAnImportOnceSafariRewroteTheFileAndKeptIt() async throws {
        api.browserRows = [chromeAddition]
        let engine = makeEngine()
        _ = try await engine.sync()

        // Safari opens the file and saves it again with the import in it.
        file.safariRewrites(Fixture.plist(file.data))
        _ = try await engine.sync()
        XCTAssertEqual(api.snapshots.last?.unconfirmedImports, [])
        XCTAssertTrue(store.load().pendingImports.isEmpty)
        XCTAssertTrue(api.browserRows.isEmpty, "now owned by Safari")
    }

    func testDeletesEverywhereAnImportTheUserDeletedInSafari() async throws {
        api.browserRows = [chromeAddition]
        let engine = makeEngine()
        _ = try await engine.sync()
        XCTAssertEqual(file.writes.count, 1)

        // Safari saved its file without the import: deleted in Safari.
        file.safariRewrites(Fixture.root())
        let outcome = try await engine.sync()
        XCTAssertEqual(outcome.deletedInSafari, 1)
        XCTAssertEqual(api.snapshots.last?.deletedImports, ["https://chrome.example/"])
        XCTAssertTrue(api.browserRows.isEmpty, "deleted in the browsers")
        XCTAssertEqual(file.writes.count, 1, "not written into Safari again")
        XCTAssertTrue(store.load().deletedImports.isEmpty, "the server applied it")
        XCTAssertTrue(store.load().pendingImports.isEmpty)
    }

    func testKeepsDeletedImportsUntilAHeldDeleteIsConfirmed() async throws {
        api.browserRows = [chromeAddition]
        let engine = makeEngine()
        _ = try await engine.sync()
        file.safariRewrites(Fixture.root())
        api.needsConfirmation = DeletionConfirmation(count: 30, sample: ["https://chrome.example/"])

        let held = try await engine.sync()
        XCTAssertEqual(held.needsConfirmation?.count, 30)
        XCTAssertEqual(store.load().deletedImports, ["https://chrome.example/"])
        XCTAssertEqual(file.writes.count, 1, "held deletes are not imported back")

        _ = try await engine.sync(confirmDeletions: true)
        XCTAssertTrue(store.load().deletedImports.isEmpty)
        XCTAssertTrue(api.browserRows.isEmpty)
    }

    func testRemovesFromSafariWhatABrowserDeleted() async throws {
        api.pendingDeletions = ["https://news.example/", "https://read.example/"]
        let outcome = try await makeEngine().sync()
        XCTAssertEqual(outcome.removedFromSafari, 2)
        XCTAssertEqual(file.backups.count, 1, "backup before writing")
        let urls = try urlsInFile()
        XCTAssertFalse(urls.contains("https://news.example/"))
        XCTAssertFalse(urls.contains("https://read.example/"), "reading list items too")
        XCTAssertTrue(urls.contains("https://github.com/"))
        XCTAssertEqual(api.pendingDeletions, [], "the next snapshot completes the deletes")
        let root = Fixture.plist(file.data)
        XCTAssertNotNil(root["Sync"], "iCloud metadata is kept")
    }

    func testWaitsForSafariToQuitBeforeRemoving() async throws {
        api.pendingDeletions = ["https://news.example/"]
        safari.isSafariRunning = true
        let engine = makeEngine()
        let outcome = try await engine.sync()
        XCTAssertEqual(outcome.waitingForSafariToQuit, 1)
        XCTAssertTrue(file.writes.isEmpty)

        safari.isSafariRunning = false
        let later = try await engine.sync()
        XCTAssertEqual(later.removedFromSafari, 1)
        XCTAssertFalse(try urlsInFile().contains("https://news.example/"))
    }

    func testRemovesBookmarksStoredUnderANonCanonicalURL() async throws {
        file = FakeFile(Fixture.data(Fixture.root(favorites: [
            Fixture.leaf("Mixed case", "HTTPS://Example.COM"),
            Fixture.folder("Tech", [Fixture.leaf("Copy", "https://example.com/")]),
            Fixture.leaf("Keep", "https://keep.example/"),
        ])))
        api.canonicalMap = ["HTTPS://Example.COM": "https://example.com/"]
        api.pendingDeletions = ["https://example.com/"]
        let outcome = try await makeEngine().sync()
        XCTAssertEqual(outcome.removedFromSafari, 1)
        XCTAssertEqual(try urlsInFile().filter { $0.lowercased().contains("example.com") }, [])
        XCTAssertTrue(try urlsInFile().contains("https://keep.example/"))
    }

    func testReadsStateFilesOfOlderVersions() throws {
        let json = #"{"pendingImports":[{"url":"https://a.example/","importedAt":10}],"parkedImports":["https://gone.example/"],"safariLaunchedSinceImport":true,"waitingForSafariToQuit":0}"#
        let state = try JSONDecoder().decode(SyncState.self, from: Data(json.utf8))
        XCTAssertEqual(state.pendingImports.map(\.url), ["https://a.example/"])
        XCTAssertEqual(state.deletedImports, ["https://gone.example/"], "dropped imports count as deleted in Safari")
        XCTAssertTrue(state.safariLaunchedSinceImport)
        XCTAssertEqual(state.canonicalMap, [:])
        let again = try JSONDecoder().decode(SyncState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(again, state)
    }

    func testAsksBeforeAMassDeleteAndSendsTheConfirmation() async throws {
        api.needsConfirmation = DeletionConfirmation(count: 40, sample: ["https://gone.example/"])
        let engine = makeEngine()
        let first = try await engine.sync()
        XCTAssertEqual(first.needsConfirmation?.count, 40)
        XCTAssertEqual(store.load().deletionConfirmation?.count, 40)

        _ = try await engine.sync()
        XCTAssertEqual(api.snapshots.count, 2, "a held-back snapshot is sent again")

        _ = try await engine.sync(confirmDeletions: true)
        XCTAssertEqual(api.snapshots.last?.confirmDeletions, true)
        XCTAssertNil(store.load().deletionConfirmation)
    }

    func testRestoresTheFileWhenTheWriteDoesNotReadBack() async throws {
        api.browserRows = [chromeAddition]
        file.corruptNextWrite = true
        let original = file.data
        do {
            _ = try await makeEngine().sync()
            XCTFail("expected an error")
        } catch let error as SyncError {
            guard case .bookmarksWrite = error else { return XCTFail("unexpected \(error)") }
        }
        XCTAssertEqual(file.data, original)
        XCTAssertTrue(store.load().pendingImports.isEmpty)
        XCTAssertNotNil(store.load().lastError)
    }

    func testUsesTheServersCanonicalFormToAvoidDuplicates() async throws {
        file = FakeFile(Fixture.data(Fixture.root(favorites: [Fixture.leaf("Mixed case", "HTTPS://Example.COM")])))
        api.canonicalMap = ["HTTPS://Example.COM": "https://example.com/"]
        api.browserRows = [RemoteBookmark(url: "https://example.com/", title: "same", folderPath: ["Favorites"])]
        let outcome = try await makeEngine().sync()
        XCTAssertEqual(outcome.imported, 0)
        XCTAssertTrue(file.writes.isEmpty)
    }
}
