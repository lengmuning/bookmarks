import AppKit
import BookmarksSyncCore

@MainActor
final class SettingsWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let app: AppController

    // Sync group, not connected
    private let workerField = NSTextField()
    private let accessKeyField = NSSecureTextField()
    private lazy var connectButton = button("Connect", #selector(connect))
    private let unpairedView = NSStackView()

    // Sync group, paired
    private let workerLabel = NSTextField(labelWithString: "")
    private let groupLabel = NSTextField(labelWithString: "")
    private let pairingCodeLabel = NSTextField(labelWithString: "")
    private let pairingHintLabel = NSTextField(wrappingLabelWithString: "")
    private lazy var newCodeButton = button("New Pairing Code", #selector(newPairingCode))
    private let devicesTable = NSTableView()
    private lazy var removeDeviceButton = button("Remove Selected", #selector(removeDevice))
    private lazy var leaveButton = button("Leave Sync Group…", #selector(leaveGroup))
    private let pairedView = NSStackView()

    // Safari
    private let accessLabel = NSTextField(wrappingLabelWithString: "")

    // Options
    private lazy var autoSyncBox = NSButton(checkboxWithTitle: "Sync automatically", target: self, action: #selector(toggleAutoSync))
    private lazy var loginBox = NSButton(checkboxWithTitle: "Open at login", target: self, action: #selector(toggleLogin))

    // Status
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private lazy var syncButton = button("Sync Now", #selector(syncNow))

    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    init(app: AppController) {
        self.app = app
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Safari Bookmarks Sync"
        window.minSize = NSSize(width: 520, height: 480)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        buildContent()
        window.setFrameAutosaveName("SettingsWindow")
        if !window.setFrameUsingName("SettingsWindow") { window.center() }
        app.observe { [weak self] in self?.refresh() }
        refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func present() {
        refresh()
        showWindow(nil)
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
        if app.isPaired { Task { await app.refreshDevices() } }
    }

    // MARK: Layout

    private func buildContent() {
        workerField.placeholderString = "https://bookmarks.example.workers.dev"
        accessKeyField.placeholderString = "Your access key"
        for field in [workerField, accessKeyField] {
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(greaterThanOrEqualToConstant: 280).isActive = true
        }
        connectButton.keyEquivalent = "\r"

        unpairedView.orientation = .vertical
        unpairedView.alignment = .leading
        unpairedView.spacing = 10
        unpairedView.addArrangedSubviews([
            grid([("Worker URL", workerField), ("Access key", accessKeyField)]),
            hint("Your access key stands for you: one key, one sync group. The first Mac creates the group; connecting again later (a new or reinstalled Mac) returns to the same group. Chrome and Firefox join with a pairing code from this app."),
            connectButton,
        ])

        pairingCodeLabel.font = .monospacedSystemFont(ofSize: 22, weight: .semibold)
        pairingCodeLabel.isSelectable = true
        pairingHintLabel.textColor = .secondaryLabelColor
        pairingHintLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        workerLabel.isSelectable = true
        groupLabel.isSelectable = true

        pairedView.orientation = .vertical
        pairedView.alignment = .leading
        pairedView.spacing = 10
        pairedView.addArrangedSubviews([
            grid([("Worker", workerLabel), ("Group", groupLabel)]),
            row([newCodeButton, pairingCodeLabel]),
            pairingHintLabel,
            label("Devices in this group", bold: true),
            devicesScroll(),
            row([removeDeviceButton, leaveButton]),
        ])

        let chooseButton = button("Choose Safari Folder…", #selector(chooseSafariFolder))
        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 22
        content.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 24, right: 24)
        content.addArrangedSubviews([
            section("Sync group", [unpairedView, pairedView]),
            section("Safari", [
                accessLabel,
                chooseButton,
                hint("macOS does not let any app read Safari's bookmarks on its own, so this permission is granted once: the panel opens in the Safari folder and you click Allow Access. Choosing Bookmarks.plist itself also works, but then the file is rewritten in place instead of replaced atomically."),
            ]),
            section("Options", [autoSyncBox, loginBox, hint("Bookmarks added in other browsers are written into Safari only while Safari is not running. With automatic sync on, that happens as soon as you quit Safari.")]),
            section("Status", [statusLabel, errorLabel, syncButton]),
        ])
        errorLabel.textColor = .systemRed

        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(content)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = document
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: document.topAnchor),
            content.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        window?.contentView = scroll
    }

    private func devicesScroll() -> NSScrollView {
        for (id, title, width) in [("name", "Name", 200.0), ("platform", "Browser", 90.0), ("seen", "Last seen", 160.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            column.title = title
            column.width = width
            devicesTable.addTableColumn(column)
        }
        devicesTable.dataSource = self
        devicesTable.delegate = self
        devicesTable.usesAlternatingRowBackgroundColors = true
        devicesTable.allowsEmptySelection = true
        let scroll = NSScrollView()
        scroll.documentView = devicesTable
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        scroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 460).isActive = true
        return scroll
    }

    private func section(_ title: String, _ views: [NSView]) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.addArrangedSubviews([label(title, bold: true, size: 15)] + views)
        return stack
    }

    private func grid(_ rows: [(String, NSView)]) -> NSGridView {
        let grid = NSGridView(views: rows.map { [label($0.0), $0.1] })
        grid.rowSpacing = 8
        grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline
        return grid
    }

    private func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.spacing = 12
        stack.alignment = .firstBaseline
        return stack
    }

    private func label(_ text: String, bold: Bool = false, size: CGFloat = NSFont.systemFontSize) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        return field
    }

    private func hint(_ text: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.textColor = .secondaryLabelColor
        field.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        field.preferredMaxLayoutWidth = 520
        return field
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }

    // MARK: State

    private func refresh() {
        let paired = app.isPaired
        unpairedView.isHidden = paired
        pairedView.isHidden = !paired
        if !paired, workerField.stringValue.isEmpty { workerField.stringValue = app.workerURLText }

        if let credentials = app.credentials {
            workerLabel.stringValue = credentials.workerURL.absoluteString
            groupLabel.stringValue = String(credentials.pairId.prefix(8)) + "…"
        }
        if let code = app.pairingCode, code.expiresAt > Date() {
            pairingCodeLabel.stringValue = code.code
            pairingHintLabel.stringValue = "Enter this code in the Chrome or Firefox extension. It works once and expires at \(dateFormatter.string(from: code.expiresAt))."
        } else {
            pairingCodeLabel.stringValue = ""
            pairingHintLabel.stringValue = "To add Chrome or Firefox, create a pairing code and enter it in the extension."
        }
        devicesTable.reloadData()
        removeDeviceButton.isEnabled = selectedDevice.map { !$0.isSelf } ?? false

        if app.hasSafariAccess, let path = app.file.grantedPath() {
            accessLabel.stringValue = "Access granted to \(path)" + (app.file.grantIsFolder() ? "" : " (file only)")
            accessLabel.textColor = .labelColor
        } else {
            accessLabel.stringValue = "The app cannot read Safari's bookmarks yet."
            accessLabel.textColor = .systemOrange
        }

        autoSyncBox.state = app.autoSync ? .on : .off
        loginBox.state = app.launchAtLogin ? .on : .off

        statusLabel.stringValue = statusText()
        errorLabel.stringValue = app.state.lastError ?? ""
        errorLabel.isHidden = app.state.lastError == nil
        syncButton.isEnabled = app.isReady && !app.isSyncing
    }

    private func statusText() -> String {
        let state = app.state
        var lines: [String] = []
        if app.isSyncing {
            lines.append("Syncing…")
        } else if let last = state.lastSyncAt {
            lines.append("Last sync: \(dateFormatter.string(from: last))")
        } else {
            lines.append("Not synced yet.")
        }
        if let stats = state.lastStats {
            lines.append("Safari has \(stats.accepted) bookmarks. Last upload: \(stats.inserted + stats.restored) new, \(stats.updated) changed, \(stats.deleted) deleted.")
        }
        if state.waitingForSafariToQuit > 0 {
            lines.append("\(state.waitingForSafariToQuit) bookmark(s) from other browsers will be added when you quit Safari.")
        }
        if !state.pendingImports.isEmpty {
            lines.append("\(state.pendingImports.count) added bookmark(s) are waiting for Safari to keep them.")
        }
        if !state.parkedImports.isEmpty {
            lines.append("\(state.parkedImports.count) added bookmark(s) were dropped by Safari; use the menu to add them again.")
        }
        if let confirmation = state.deletionConfirmation {
            lines.append("\(confirmation.count) bookmarks are missing from Safari and wait for your confirmation in the menu before they are deleted elsewhere.")
        }
        return lines.joined(separator: "\n")
    }

    private var selectedDevice: Device? {
        let row = devicesTable.selectedRow
        return app.devices.indices.contains(row) ? app.devices[row] : nil
    }

    // MARK: Actions

    private func perform(_ sender: NSButton, _ work: @escaping @MainActor () async throws -> Void) {
        sender.isEnabled = false
        Task {
            do {
                try await work()
            } catch {
                showError(error)
            }
            sender.isEnabled = true
            refresh()
        }
    }

    private func showError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Something went wrong"
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    @objc private func connect(_ sender: NSButton) {
        let url = workerField.stringValue
        let key = accessKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            showError(SyncError.server(status: 401, code: "access_key_required"))
            return
        }
        perform(sender) { [weak self, app] in
            do {
                try await app.connect(workerURL: url, accessKey: key)
            } catch let SyncError.safariDeviceExists(name) {
                guard self?.confirmTakeover(from: name) == true else { return }
                try await app.connect(workerURL: url, accessKey: key, replaceSafari: true)
            }
            self?.accessKeyField.stringValue = ""
            await app.refreshDevices()
            // Reading Safari's bookmarks needs a one-time permission.
            if !app.hasSafariAccess { self?.askForSafariAccess() }
        }
    }

    private func confirmTakeover(from name: String?) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Use this Mac for Safari instead of “\(name ?? "the other Mac")”?"
        alert.informativeText = "Your sync group already has a Mac with Safari, and a group has only one. If you continue, the other Mac stops syncing; its bookmarks stay as they are."
        alert.addButton(withTitle: "Use This Mac")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func newPairingCode(_ sender: NSButton) {
        perform(sender) { [app] in try await app.newPairingCode() }
    }

    @objc private func removeDevice(_ sender: NSButton) {
        guard let device = selectedDevice, !device.isSelf else { return }
        let alert = NSAlert()
        alert.messageText = "Remove \(device.name ?? device.platform) from the group?"
        alert.informativeText = "It stops syncing immediately. Its bookmarks stay where they are."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform(sender) { [app] in try await app.removeDevice(device.id) }
    }

    @objc private func leaveGroup(_ sender: NSButton) {
        let alert = NSAlert()
        alert.messageText = "Remove this Mac from the sync group?"
        alert.informativeText = "Safari's bookmarks stay as they are. The other browsers keep syncing with each other until you set this Mac up again."
        alert.addButton(withTitle: "Leave")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform(sender) { [app] in await app.leaveGroup() }
    }

    @objc private func chooseSafariFolder(_ sender: NSButton) {
        askForSafariAccess()
    }

    /// macOS lets no app read ~/Library/Safari on its own; the user grants it
    /// once here. The panel opens in the Safari folder, so "Allow Access" is
    /// the only click needed.
    private func askForSafariAccess() {
        let panel = NSOpenPanel()
        panel.message = "macOS protects Safari's bookmarks. Click Allow Access to let this app read and update them (this is the Safari folder in your Library)."
        panel.prompt = "Allow Access"
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = SecurityScopedBookmarksFile.safariFolder
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try app.grantSafariAccess(url)
        } catch {
            showError(error)
        }
    }

    @objc private func toggleAutoSync(_ sender: NSButton) {
        app.autoSync = sender.state == .on
    }

    @objc private func toggleLogin(_ sender: NSButton) {
        do {
            try app.setLaunchAtLogin(sender.state == .on)
        } catch {
            showError(error)
        }
        refresh()
    }

    @objc private func syncNow(_ sender: NSButton) {
        Task { await app.syncNow() }
    }

    // MARK: Devices table

    func numberOfRows(in tableView: NSTableView) -> Int {
        app.devices.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let device = app.devices[row]
        let text: String
        switch tableColumn?.identifier.rawValue {
        case "name": text = (device.name ?? "Unnamed") + (device.isSelf ? " (this Mac)" : "")
        case "platform": text = device.platform.capitalized
        default:
            text = device.lastSeenAt.map { dateFormatter.string(from: Date(timeIntervalSince1970: $0 / 1000)) } ?? "—"
        }
        let cell = NSTextField(labelWithString: text)
        cell.lineBreakMode = .byTruncatingTail
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        removeDeviceButton.isEnabled = selectedDevice.map { !$0.isSelf } ?? false
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private extension NSStackView {
    func addArrangedSubviews(_ views: [NSView]) {
        views.forEach(addArrangedSubview)
    }
}
