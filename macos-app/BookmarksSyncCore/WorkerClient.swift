import Foundation

public enum SyncError: LocalizedError, Equatable, Sendable {
    case server(status: Int, code: String)
    /// Another Mac is the group's Safari device; `name` is what it reported.
    case safariDeviceExists(name: String?)
    case transport(String)
    case invalidResponse
    case invalidWorkerURL
    case notPaired
    case bookmarksAccess(String)
    case bookmarksFormat(String)
    case bookmarksWrite(String)

    public var errorDescription: String? {
        switch self {
        case let .server(status, code):
            switch code {
            case "access_key_required": return "Enter the access key for this Worker."
            case "invalid_access_key": return "The access key is not valid or was revoked."
            case "access_key_not_configured":
                return "The Worker has no access key configured. Set ACCESS_KEY or ADMIN_KEY with `wrangler secret put`."
            case "rate_limited": return "Too many attempts from this network. Try again in an hour."
            case "group_disabled": return "The Worker's administrator disabled this sync group."
            case "unauthorized": return "This Mac is no longer part of the sync group. Set it up again."
            case "invalid_or_expired_code": return "The pairing code is wrong, already used or expired."
            default: return "The Worker returned an error (\(status) \(code))."
            }
        case let .safariDeviceExists(name):
            return "Your sync group already has another Mac with Safari (\(name ?? "unnamed"))."
        case let .transport(message): return "Could not reach the Worker: \(message)"
        case .invalidResponse: return "The Worker sent a response this app does not understand."
        case .invalidWorkerURL: return "Enter the Worker URL, for example https://bookmarks.example.workers.dev."
        case .notPaired: return "This Mac is not in a sync group yet."
        case let .bookmarksAccess(message), let .bookmarksFormat(message), let .bookmarksWrite(message): return message
        }
    }

    /// Errors that retrying will not fix until the user acts.
    public var needsUserAction: Bool {
        guard case let .server(_, code) = self else { return false }
        return ["unauthorized", "group_disabled", "invalid_access_key", "access_key_required", "access_key_not_configured"].contains(code)
    }
}

public protocol SafariSyncAPI: Sendable {
    func safariSnapshot(_ request: SafariSnapshotRequest) async throws -> SafariSnapshotResponse
    func safariPending() async throws -> PendingResponse
}

public func normalizedWorkerURL(_ raw: String) -> URL? {
    var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while value.hasSuffix("/") { value.removeLast() }
    guard let url = URL(string: value),
          let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
          url.host?.isEmpty == false
    else { return nil }
    return url
}

public final class WorkerClient: SafariSyncAPI, @unchecked Sendable {
    public let baseURL: URL
    private let token: String?
    private let session: URLSession

    public init(baseURL: URL, token: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public convenience init(credentials: Credentials, session: URLSession = .shared) {
        self.init(baseURL: credentials.workerURL, token: credentials.token, session: session)
    }

    // MARK: Connecting (no device token yet)

    private struct ConnectRequest: Encodable {
        let platform = "safari"
        let name: String
        let accessKey: String
        let replaceSafari: Bool

        enum CodingKeys: String, CodingKey {
            case platform, name
            case accessKey = "access_key"
            case replaceSafari = "replace_safari"
        }
    }

    /// Creates the access key's sync group, or joins it if it exists.
    public func connect(accessKey: String, deviceName: String, replaceSafari: Bool) async throws -> ConnectResponse {
        try await send("POST", "/v2/connect", body: ConnectRequest(name: deviceName, accessKey: accessKey, replaceSafari: replaceSafari))
    }

    // MARK: Device calls

    public func newPairingCode() async throws -> PairingCode {
        try await send("POST", "/v2/pair-code", body: [String: String]())
    }

    public func devices() async throws -> [Device] {
        let response: DevicesResponse = try await send("GET", "/v2/devices")
        return response.devices
    }

    public func revokeDevice(_ id: String) async throws {
        let _: EmptyResponse = try await send("DELETE", "/v2/devices/\(id)")
    }

    public func safariSnapshot(_ request: SafariSnapshotRequest) async throws -> SafariSnapshotResponse {
        try await send("POST", "/v2/safari/snapshot", body: request)
    }

    public func safariPending() async throws -> PendingResponse {
        try await send("GET", "/v2/safari/pending")
    }

    public func webSocketTicket() async throws -> WebSocketTicket {
        try await send("POST", "/v2/ws-ticket", body: [String: String]())
    }

    public func webSocketURL(for ticket: WebSocketTicket) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        guard let root = components.url else { return nil }
        return URL(string: root.absoluteString + ticket.path)
    }

    // MARK: Transport

    private struct EmptyResponse: Decodable {}
    private struct ErrorBody: Decodable {
        struct DeviceInfo: Decodable { let name: String? }
        let error: String?
        let device: DeviceInfo?
    }

    private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        try await perform(method, path, body: nil)
    }

    private func send<Body: Encodable, Response: Decodable>(_ method: String, _ path: String, body: Body) async throws -> Response {
        let data: Data
        do {
            data = try JSONEncoder().encode(body)
        } catch {
            throw SyncError.invalidResponse
        }
        return try await perform(method, path, body: data)
    }

    private func perform<Response: Decodable>(_ method: String, _ path: String, body: Data?) async throws -> Response {
        guard let url = URL(string: baseURL.absoluteString + path) else { throw SyncError.invalidWorkerURL }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw SyncError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw SyncError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
            let code = body?.error ?? "http_\(http.statusCode)"
            if code == "safari_device_exists" { throw SyncError.safariDeviceExists(name: body?.device?.name) }
            throw SyncError.server(status: http.statusCode, code: code)
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw SyncError.invalidResponse
        }
    }
}
