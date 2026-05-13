//
//  ViewController.swift
//  Shared (App)
//
//  Created by Aurora on 2026/5/12.
//

import CryptoKit
import Foundation
import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import Darwin
import SafariServices
import UniformTypeIdentifiers
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.yourCompany.Safari-Bookmarks-Sync.Extension"

struct PairResponse: Decodable {
    let code: String
    let pair_id: String
    let device_id: String
    let device_token: String
}

struct NativeBookmark: Encodable {
    let id: String
    let title: String
    let url: String
    let parentId: String
    let folderPath: [String]
    let index: Int
}

struct RemoteBookmarksResponse: Decodable {
    let bookmarks: [RemoteBookmark]
}

struct RemoteBookmark: Decodable {
    let bookmarkId: String?
    let title: String?
    let url: String?
    let folderPath: [String]?

    enum CodingKeys: String, CodingKey {
        case bookmarkId = "bookmark_id"
        case title
        case url
        case folderPath
    }
}

struct SyncRequest: Encodable {
    let pair_id: String
    let device_id: String
    let device_token: String
    let action: String
    let bookmark: NativeBookmark
}

struct BookmarkLocationKey: Hashable {
    let url: String
    let folderPath: [String]
}

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    private let defaults = UserDefaults.standard
    private let encoder = JSONEncoder()
    private var autoCheckTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")
        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
        configureAutoCheckTimer()
    }

    deinit {
        autoCheckTimer?.invalidate()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(macOS)
        refreshExtensionState()
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            sendError(action: "unknown", message: "Invalid app command.")
            return
        }

#if os(macOS)
        switch action {
        case "getState":
            refreshExtensionState()
        case "saveUrl":
            saveUrl(body["api_url"] as? String)
            sendResult(action: "saveUrl", payload: statePayload())
        case "generatePair":
            saveUrl(body["api_url"] as? String)
            Task { await generatePair() }
        case "chooseBookmarksFile":
            chooseBookmarksFile()
        case "syncNow":
            saveUrl(body["api_url"] as? String)
            Task { await syncNow() }
        case "pullRemoteChanges":
            saveUrl(body["api_url"] as? String)
            Task { await pullRemoteChanges() }
        case "checkRemoteChanges":
            saveUrl(body["api_url"] as? String)
            Task { await checkRemoteChanges(triggeredByTimer: false) }
        case "setAutoCheck":
            saveUrl(body["api_url"] as? String)
            setAutoCheck(body["enabled"] as? Bool ?? false)
        case "open-preferences":
            openSafariExtensionPreferences()
        default:
            sendError(action: action, message: "Unknown app command: \(action)")
        }
#else
        sendError(action: action, message: "Safari bookmark sync is only implemented on macOS.")
#endif
    }

#if os(macOS)
    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { [weak self] state, _ in
            DispatchQueue.main.async {
                var payload = self?.statePayload() ?? [:]
                payload["extension_enabled"] = state?.isEnabled ?? false
                self?.sendResult(action: "state", payload: payload)
            }
        }
    }

    private func openSafariExtensionPreferences() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { [weak self] error in
            if let error {
                DispatchQueue.main.async {
                    self?.sendError(action: "open-preferences", message: error.localizedDescription)
                }
            }
        }
    }

    private func chooseBookmarksFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose Safari Bookmarks.plist"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.propertyList]
        panel.directoryURL = realUserHomeURL()
            .appendingPathComponent("Library")
            .appendingPathComponent("Safari")

        guard panel.runModal() == .OK, let url = panel.url else {
            sendResult(action: "chooseBookmarksFile", payload: statePayload())
            return
        }

        do {
            let data = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            defaults.set(data, forKey: "bookmarks_file_bookmark")
            defaults.set(url.path, forKey: "bookmarks_file_path")
            sendResult(action: "chooseBookmarksFile", payload: statePayload())
        } catch {
            sendError(
                action: "chooseBookmarksFile",
                message: "Could not save bookmarks file access. Select /Users/\(NSUserName())/Library/Safari/Bookmarks.plist. If macOS still blocks it, add this app to System Settings > Privacy & Security > Full Disk Access, or copy Bookmarks.plist to Desktop and choose that copy."
            )
        }
    }

    private func generatePair() async {
        do {
            let apiUrl = try normalizedApiUrl()
            var request = URLRequest(url: try endpoint("/api/pair/generate", base: apiUrl))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "browser": "safari",
                "device_name": Host.current().localizedName ?? "Safari macOS"
            ])

            let (data, response) = try await URLSession.shared.data(for: request)
            try validateHttp(response: response, data: data)
            let pair = try JSONDecoder().decode(PairResponse.self, from: data)

            defaults.set(pair.code, forKey: "code")
            defaults.set(pair.pair_id, forKey: "pair_id")
            defaults.set(pair.device_id, forKey: "device_id")
            defaults.set(pair.device_token, forKey: "device_token")

            await MainActor.run {
                sendResult(action: "generatePair", payload: statePayload())
            }
        } catch {
            await MainActor.run {
                sendError(action: "generatePair", message: "Pairing failed: \(error.localizedDescription)")
            }
        }
    }

    private func syncNow() async {
        do {
            let apiUrl = try normalizedApiUrl()
            let pairId = try requiredDefault("pair_id", label: "Pair ID")
            let deviceId = try requiredDefault("device_id", label: "Device ID")
            let deviceToken = try requiredDefault("device_token", label: "Device token")
            let bookmarks = try loadSafariBookmarks()

            for bookmark in bookmarks {
                let body = SyncRequest(
                    pair_id: pairId,
                    device_id: deviceId,
                    device_token: deviceToken,
                    action: "create",
                    bookmark: bookmark
                )
                var request = URLRequest(url: try endpoint("/api/sync", base: apiUrl))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try encoder.encode(body)

                let (data, response) = try await URLSession.shared.data(for: request)
                try validateHttp(response: response, data: data)
            }

            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "last_sync")

            await MainActor.run {
                sendResult(action: "syncNow", payload: [
                    "synced": bookmarks.count,
                    "state": statePayload()
                ])
            }
        } catch {
            await MainActor.run {
                sendError(action: "syncNow", message: "Sync failed: \(error.localizedDescription)")
            }
        }
    }

    private func pullRemoteChanges() async {
        do {
            let remote = try await fetchRemoteBookmarks()
            let added = try mergeRemoteBookmarksIntoSafari(remote.bookmarks)

            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "last_sync")

            await MainActor.run {
                sendResult(action: "pullRemoteChanges", payload: [
                    "added": added,
                    "remote": remote.bookmarks.count,
                    "state": statePayload()
                ])
            }
        } catch {
            await MainActor.run {
                sendError(action: "pullRemoteChanges", message: "Pull failed: \(error.localizedDescription)")
            }
        }
    }

    private func checkRemoteChanges(triggeredByTimer: Bool) async {
        do {
            let remote = try await fetchRemoteBookmarks()
            let missing = try missingRemoteBookmarks(remote.bookmarks)

            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "last_remote_check")
            defaults.set(missing.count, forKey: "pending_remote_count")

            await MainActor.run {
                sendResult(action: triggeredByTimer ? "autoCheckRemoteChanges" : "checkRemoteChanges", payload: [
                    "pending": missing.count,
                    "remote": remote.bookmarks.count,
                    "state": statePayload()
                ])
            }
        } catch {
            await MainActor.run {
                if triggeredByTimer {
                    sendResult(action: "autoCheckRemoteChanges", payload: [
                        "error": "Auto check failed: \(error.localizedDescription)",
                        "state": statePayload()
                    ])
                } else {
                    sendError(action: "checkRemoteChanges", message: "Check failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func setAutoCheck(_ enabled: Bool) {
        defaults.set(enabled, forKey: "auto_check_enabled")
        configureAutoCheckTimer()
        sendResult(action: "setAutoCheck", payload: statePayload())
    }

    private func configureAutoCheckTimer() {
        autoCheckTimer?.invalidate()
        autoCheckTimer = nil

#if os(macOS)
        guard defaults.bool(forKey: "auto_check_enabled") else {
            return
        }

        autoCheckTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { await self.checkRemoteChanges(triggeredByTimer: true) }
        }
        autoCheckTimer?.tolerance = 30
#endif
    }

    private func fetchRemoteBookmarks() async throws -> RemoteBookmarksResponse {
        let apiUrl = try normalizedApiUrl()
        let pairId = try requiredDefault("pair_id", label: "Pair ID")
        let deviceId = try requiredDefault("device_id", label: "Device ID")
        let deviceToken = try requiredDefault("device_token", label: "Device token")
        let query = URLQueryItem.queryString([
            "pair_id": pairId,
            "device_id": deviceId,
            "device_token": deviceToken
        ])
        var request = URLRequest(url: try endpoint("/api/bookmarks?\(query)", base: apiUrl))
        request.httpMethod = "GET"

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateHttp(response: response, data: data)
        return try JSONDecoder().decode(RemoteBookmarksResponse.self, from: data)
    }

    private func loadSafariBookmarks() throws -> [NativeBookmark] {
        let access = try bookmarksFileAccess()
        let shouldStopAccessing = access.securityScoped && access.url.startAccessingSecurityScopedResource()
        defer {
            if shouldStopAccessing {
                access.url.stopAccessingSecurityScopedResource()
            }
        }

        let data = try Data(contentsOf: access.url)
        let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        guard let root = plist as? [String: Any] else {
            throw AppError("Safari bookmarks file has an unexpected format.")
        }

        var bookmarks: [NativeBookmark] = []
        collectBookmarks(from: root, folderPath: [], parentId: "safari-root", indexInParent: 0, into: &bookmarks)
        return bookmarks
    }

    private func collectBookmarks(from node: [String: Any], folderPath: [String], parentId: String, indexInParent: Int, into bookmarks: inout [NativeBookmark]) {
        let type = node["WebBookmarkType"] as? String

        if type == "WebBookmarkTypeLeaf", let url = node["URLString"] as? String, !url.isEmpty {
            let title = ((node["URIDictionary"] as? [String: Any])?["title"] as? String)
                ?? (node["Title"] as? String)
                ?? url
            let id = (node["WebBookmarkUUID"] as? String).map { "safari-\($0)" }
                ?? stableId(parts: folderPath + [title, url])
            bookmarks.append(NativeBookmark(
                id: id,
                title: title,
                url: url,
                parentId: parentId,
                folderPath: folderPath,
                index: indexInParent
            ))
            return
        }

        guard let children = node["Children"] as? [[String: Any]] else {
            return
        }

        let title = normalizedSafariFolderTitle(node["Title"] as? String)
        let nextPath = appendFolderTitle(title, to: folderPath)
        let nextParentId = stableId(parts: nextPath)
        for (index, child) in children.enumerated() {
            collectBookmarks(from: child, folderPath: nextPath, parentId: nextParentId, indexInParent: index, into: &bookmarks)
        }
    }

    private func normalizedSafariFolderTitle(_ title: String?) -> String? {
        guard let raw = title?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }

        switch raw {
        case "BookmarksBar":
            return "Favorites"
        case "BookmarksMenu":
            return "Bookmarks Menu"
        case "com.apple.ReadingList":
            return "Reading List"
        default:
            return raw
        }
    }

    private func appendFolderTitle(_ title: String?, to folderPath: [String]) -> [String] {
        guard let title else {
            return folderPath
        }
        if folderPath.last == title {
            return folderPath
        }
        return folderPath + [title]
    }

    private func mergeRemoteBookmarksIntoSafari(_ remoteBookmarks: [RemoteBookmark]) throws -> Int {
        let access = try bookmarksFileAccess()
        let shouldStopAccessing = access.securityScoped && access.url.startAccessingSecurityScopedResource()
        defer {
            if shouldStopAccessing {
                access.url.stopAccessingSecurityScopedResource()
            }
        }

        let data = try Data(contentsOf: access.url)
        let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        guard var root = plist as? [String: Any] else {
            throw AppError("Safari bookmarks file has an unexpected format.")
        }

        var existingKeys = Set<BookmarkLocationKey>()
        collectBookmarkLocationKeys(from: root, folderPath: [], into: &existingKeys)
        let missing = missingRemoteBookmarks(remoteBookmarks, existingKeys: existingKeys)
        var added = 0
        for bookmark in missing {
            guard let rawUrl = bookmark.url?.trimmingCharacters(in: .whitespacesAndNewlines), !rawUrl.isEmpty else {
                continue
            }

            let title = bookmark.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let folderPath = sanitizedRemoteFolderPath(bookmark.folderPath)
            root = addRemoteBookmark(
                title: title?.isEmpty == false ? title! : rawUrl,
                url: rawUrl,
                folderPath: folderPath,
                to: root,
                isRoot: true
            )
            existingKeys.insert(BookmarkLocationKey(url: rawUrl, folderPath: folderPath))
            added += 1
        }

        guard added > 0 else {
            return 0
        }

        let backupURL = try backupBookmarksFile(access.url)
        let output = try PropertyListSerialization.data(fromPropertyList: root, format: .xml, options: 0)
        do {
            try output.write(to: access.url, options: [.atomic])
        } catch {
            throw AppError("Could not write Safari bookmarks. A backup was saved to \(backupURL.path). Grant Full Disk Access or choose a writable copy of Bookmarks.plist, then retry. \(error.localizedDescription)")
        }
        return added
    }

    private func missingRemoteBookmarks(_ remoteBookmarks: [RemoteBookmark]) throws -> [RemoteBookmark] {
        let access = try bookmarksFileAccess()
        let shouldStopAccessing = access.securityScoped && access.url.startAccessingSecurityScopedResource()
        defer {
            if shouldStopAccessing {
                access.url.stopAccessingSecurityScopedResource()
            }
        }

        let data = try Data(contentsOf: access.url)
        let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        guard let root = plist as? [String: Any] else {
            throw AppError("Safari bookmarks file has an unexpected format.")
        }

        var existingKeys = Set<BookmarkLocationKey>()
        collectBookmarkLocationKeys(from: root, folderPath: [], into: &existingKeys)
        return missingRemoteBookmarks(remoteBookmarks, existingKeys: existingKeys)
    }

    private func missingRemoteBookmarks(_ remoteBookmarks: [RemoteBookmark], existingKeys: Set<BookmarkLocationKey>) -> [RemoteBookmark] {
        remoteBookmarks.filter { bookmark in
            guard let rawUrl = bookmark.url?.trimmingCharacters(in: .whitespacesAndNewlines), !rawUrl.isEmpty else {
                return false
            }
            let key = BookmarkLocationKey(url: rawUrl, folderPath: sanitizedRemoteFolderPath(bookmark.folderPath))
            return !existingKeys.contains(key)
        }
    }

    private func collectBookmarkLocationKeys(from node: [String: Any], folderPath: [String], into keys: inout Set<BookmarkLocationKey>) {
        if let url = node["URLString"] as? String, !url.isEmpty {
            keys.insert(BookmarkLocationKey(url: url, folderPath: folderPath))
        }

        guard let children = node["Children"] as? [[String: Any]] else {
            return
        }
        let title = normalizedSafariFolderTitle(node["Title"] as? String)
        let nextPath = appendFolderTitle(title, to: folderPath)
        for child in children {
            collectBookmarkLocationKeys(from: child, folderPath: nextPath, into: &keys)
        }
    }

    private func sanitizedRemoteFolderPath(_ folderPath: [String]?) -> [String] {
        (folderPath ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != "Safari Bookmarks" }
            .reduce(into: [String]()) { result, part in
                if result.last != part {
                    result.append(part)
                }
            }
    }

    private func addRemoteBookmark(title: String, url: String, folderPath: [String], to node: [String: Any], isRoot: Bool) -> [String: Any] {
        var updated = node
        var children = (updated["Children"] as? [[String: Any]]) ?? []

        guard let nextFolder = folderPath.first else {
            children.append(makeSafariBookmark(title: title, url: url))
            updated["Children"] = children
            return updated
        }

        let remainingPath = Array(folderPath.dropFirst())
        if let index = children.firstIndex(where: { child in
            guard (child["WebBookmarkType"] as? String) == "WebBookmarkTypeList" else {
                return false
            }
            return normalizedSafariFolderTitle(child["Title"] as? String) == nextFolder
        }) {
            children[index] = addRemoteBookmark(title: title, url: url, folderPath: remainingPath, to: children[index], isRoot: false)
        } else {
            var folder = makeSafariFolder(title: safariFolderTitle(for: nextFolder, isTopLevel: isRoot))
            folder = addRemoteBookmark(title: title, url: url, folderPath: remainingPath, to: folder, isRoot: false)
            children.append(folder)
        }

        updated["Children"] = children
        return updated
    }

    private func makeSafariFolder(title: String) -> [String: Any] {
        [
            "Title": title,
            "WebBookmarkType": "WebBookmarkTypeList",
            "Children": [[String: Any]]()
        ]
    }

    private func makeSafariBookmark(title: String, url: String) -> [String: Any] {
        [
            "URIDictionary": ["title": title],
            "URLString": url,
            "WebBookmarkType": "WebBookmarkTypeLeaf",
            "WebBookmarkUUID": UUID().uuidString
        ]
    }

    private func safariFolderTitle(for normalizedTitle: String, isTopLevel: Bool) -> String {
        guard isTopLevel else {
            return normalizedTitle
        }
        switch normalizedTitle {
        case "Favorites":
            return "BookmarksBar"
        case "Bookmarks Menu":
            return "BookmarksMenu"
        case "Reading List":
            return "com.apple.ReadingList"
        default:
            return normalizedTitle
        }
    }

    private func backupBookmarksFile(_ url: URL) throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let backupName = "Bookmarks.codex-sync-\(formatter.string(from: Date())).plist"
        let backupURL = url.deletingLastPathComponent().appendingPathComponent(backupName)
        do {
            try FileManager.default.copyItem(at: url, to: backupURL)
            return backupURL
        } catch {
            let fallbackDirectory = try FileManager.default.url(
                for: .documentDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let fallbackURL = fallbackDirectory.appendingPathComponent(backupName)
            try FileManager.default.copyItem(at: url, to: fallbackURL)
            return fallbackURL
        }
    }

    private func bookmarksFileAccess() throws -> (url: URL, securityScoped: Bool) {
        if let data = defaults.data(forKey: "bookmarks_file_bookmark") {
            var stale = false
            let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
            defaults.set(url.path, forKey: "bookmarks_file_path")
            return (url, true)
        }

        let defaultUrl = realUserHomeURL()
            .appendingPathComponent("Library")
            .appendingPathComponent("Safari")
            .appendingPathComponent("Bookmarks.plist")
        return (defaultUrl, false)
    }

    private func realUserHomeURL() -> URL {
        if let passwd = getpwuid(getuid()), let home = passwd.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: home))
        }
        return URL(fileURLWithPath: "/Users").appendingPathComponent(NSUserName())
    }

    private func saveUrl(_ value: String?) {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            defaults.set(trimmed, forKey: "api_url")
        }
    }

    private func normalizedApiUrl() throws -> URL {
        let value = try requiredDefault("api_url", label: "Worker URL")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: value), url.scheme == "http" || url.scheme == "https" else {
            throw AppError("Enter a valid Worker URL.")
        }
        return url
    }

    private func endpoint(_ path: String, base: URL) throws -> URL {
        let baseValue = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: baseValue + path) else {
            throw AppError("Could not build Worker API URL.")
        }
        return url
    }

    private func requiredDefault(_ key: String, label: String) throws -> String {
        guard let value = defaults.string(forKey: key), !value.isEmpty else {
            throw AppError("\(label) is missing.")
        }
        return value
    }

    private func validateHttp(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw AppError("Invalid server response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "No response body"
            throw AppError("Server returned \(http.statusCode): \(body)")
        }
    }

    private func stableId(parts: [String]) -> String {
        let input = parts.joined(separator: "\u{1f}")
        let digest = SHA256.hash(data: Data(input.utf8))
        return "safari-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
#endif

    private func statePayload() -> [String: Any] {
        var payload: [String: Any] = [
            "api_url": defaults.string(forKey: "api_url") ?? "",
            "pair_id": defaults.string(forKey: "pair_id") ?? "",
            "device_id": defaults.string(forKey: "device_id") ?? "",
            "code": defaults.string(forKey: "code") ?? "",
            "last_sync": defaults.object(forKey: "last_sync") as? Double ?? 0,
            "last_remote_check": defaults.object(forKey: "last_remote_check") as? Double ?? 0,
            "pending_remote_count": defaults.object(forKey: "pending_remote_count") as? Int ?? 0,
            "auto_check_enabled": defaults.bool(forKey: "auto_check_enabled")
        ]

#if os(macOS)
        payload["bookmarks_file"] = defaults.string(forKey: "bookmarks_file_path")
            ?? realUserHomeURL()
                .appendingPathComponent("Library")
                .appendingPathComponent("Safari")
                .appendingPathComponent("Bookmarks.plist")
                .path
#endif
        return payload
    }

    private func sendResult(action: String, payload: Any) {
        evaluateCallback(action: action, payload: payload)
    }

    private func sendError(action: String, message: String) {
        evaluateCallback(action: action, payload: ["error": message])
    }

    private func evaluateCallback(action: String, payload: Any) {
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            let json = String(data: data, encoding: .utf8) ?? "{}"
            let escapedAction = action.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            webView.evaluateJavaScript("window.nativeResult('\(escapedAction)', \(json))")
        } catch {
            webView.evaluateJavaScript("window.nativeResult('\(action)', {\"error\":\"Could not encode app response.\"})")
        }
    }
}

struct AppError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? {
        message
    }
}

extension URLQueryItem {
    static func queryString(_ values: [String: String]) -> String {
        var components = URLComponents()
        components.queryItems = values.map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.percentEncodedQuery ?? ""
    }
}
