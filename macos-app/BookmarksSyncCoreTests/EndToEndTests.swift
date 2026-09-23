import XCTest
@testable import BookmarksSyncCore

/// Runs the real WorkerClient and SyncEngine against a Worker started by
/// scripts/e2e.sh (wrangler dev, local only). Skipped unless SYNC_E2E_URL and
/// SYNC_E2E_ADMIN_KEY are set (pass them to xcodebuild as TEST_RUNNER_…).
final class EndToEndTests: XCTestCase {
    private var baseURL: URL!
    private var adminKey: String!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["SYNC_E2E_URL"].flatMap(URL.init(string:)), let admin = env["SYNC_E2E_ADMIN_KEY"] else {
            throw XCTSkip("SYNC_E2E_URL and SYNC_E2E_ADMIN_KEY are not set")
        }
        baseURL = url
        adminKey = admin
    }

    private func request(_ method: String, _ path: String, token: String? = nil, body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        var request = URLRequest(url: URL(string: baseURL.absoluteString + path)!)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return ((response as! HTTPURLResponse).statusCode, json)
    }

    func testSafariSyncAgainstARealWorker() async throws {
        let (_, issued) = try await request("POST", "/v2/admin/keys", token: adminKey, body: ["label": "swift e2e"])
        let accessKey = try XCTUnwrap(issued["key"] as? String)

        // Connect: creates the group.
        let client = WorkerClient(baseURL: baseURL, token: nil)
        let connected = try await client.connect(accessKey: accessKey, deviceName: "Swift e2e Mac", replaceSafari: false)
        XCTAssertTrue(connected.created)
        let credentials = Credentials(workerURL: baseURL, pairId: connected.pairId, deviceId: connected.deviceId, token: connected.token)
        let api = WorkerClient(credentials: credentials)

        // Upload Safari's bookmarks.
        let file = FakeFile(Fixture.data())
        let store = MemorySyncStateStore()
        let engine = SyncEngine(api: api, file: file, safari: FakeSafari(), store: store)
        let first = try await engine.sync()
        XCTAssertTrue(first.uploaded)
        XCTAssertEqual(first.stats?.accepted, 5, "the bookmarklet is skipped by the server")

        // Chrome joins with a pairing code and adds a bookmark.
        let code = try await api.newPairingCode()
        let (joinStatus, chrome) = try await request("POST", "/v2/join", body: ["code": code.code, "platform": "chrome", "name": "e2e Chrome"])
        XCTAssertEqual(joinStatus, 200)
        let chromeToken = try XCTUnwrap(chrome["token"] as? String)
        let (_, changes) = try await request("POST", "/v2/changes", token: chromeToken, body: [
            "base_cursor": 0,
            "ops": [["op": "create", "url": "https://chrome.example/", "title": "From Chrome", "folderPath": ["Favorites", "New"]]],
        ])
        XCTAssertEqual(((changes["results"] as? [[String: Any]])?.first?["status"]) as? String, "applied")

        // The next Safari sync writes it into the plist, unconfirmed.
        let second = try await engine.sync()
        XCTAssertEqual(second.imported, 1)
        let items = try SafariBookmarksDocument(data: file.data).items()
        XCTAssertEqual(items.first { $0.url == "https://chrome.example/" }?.folderPath, ["Favorites", "New"])
        let pending = try await api.safariPending()
        XCTAssertTrue(pending.pendingImports.isEmpty, "the server knows Safari has it")

        // Safari rewrites the file and keeps it: ownership moves to Safari.
        file.safariRewrites(Fixture.plist(file.data))
        _ = try await engine.sync()
        let (_, snapshot) = try await request("GET", "/v2/snapshot", token: chromeToken)
        let row = (snapshot["bookmarks"] as? [[String: Any]])?.first { $0["url"] as? String == "https://chrome.example/" }
        XCTAssertEqual(row?["owner"] as? String, "safari")

        // A second Mac with the same key must confirm before taking over.
        do {
            _ = try await client.connect(accessKey: accessKey, deviceName: "Second Mac", replaceSafari: false)
            XCTFail("expected safariDeviceExists")
        } catch let SyncError.safariDeviceExists(name) {
            XCTAssertEqual(name, "Swift e2e Mac")
        }
        let takeover = try await client.connect(accessKey: accessKey, deviceName: "Second Mac", replaceSafari: true)
        XCTAssertEqual(takeover.pairId, connected.pairId)
        do {
            _ = try await api.safariPending()
            XCTFail("the replaced Mac must be locked out")
        } catch let SyncError.server(status, _) {
            XCTAssertEqual(status, 401)
        }
    }
}
