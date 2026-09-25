import AppKit
import BookmarksSyncCore

/// Settings in the style of System Settings: a status header, notices only
/// when something needs the user, then grouped rows. Rebuilt from the app
/// state whenever it changes.
@MainActor
final class SettingsWindowController: NSWindowController {
    private static let width: CGFloat = 540
    private static let textWidth: CGFloat = 300

    private let app: AppController
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    // Kept across rebuilds so what the user typed stays.
    private let workerField = NSTextField()
    private let accessKeyField = NSSecureTextField()
    private var clock: Timer?

    private let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter
    }()

    private let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    init(app: AppController) {
        self.app = app
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Safari Bookmarks Sync"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        super.init(window: window)
        buildFrame()
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
        // Keeps "2 minutes ago" current.
        if clock == nil {
            clock = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.window?.isVisible == true, self.app.isPaired else { return }
                    self.refresh()
                }
            }
        }
    }

    // MARK: Frame

    private func buildFrame() {
        stack.orientation = .vertical
        stack.alignment = .width
        stack.spacing = 0
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 24, bottom: 22, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.documentView = document
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: document.topAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        window?.contentView = scroll

        workerField.placeholderString = "https://bookmarks.example.workers.dev"
        accessKeyField.placeholderString = "sbk_…"
        for field in [workerField, accessKeyField] {
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(equalToConstant: 250).isActive = true
            field.lineBreakMode = .byTruncatingTail
        }
    }

    private func refresh() {
        let editing = [workerField, accessKeyField].first { field in
            field.currentEditor() != nil
        }
        if editing != nil { window?.endEditing(for: nil) }
        if !app.isPaired, workerField.stringValue.isEmpty { workerField.stringValue = app.workerURLText }

        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        let insets = stack.edgeInsets.left + stack.edgeInsets.right
        for (view, spacing) in sections() {
            stack.addArrangedSubview(view)
            stack.setCustomSpacing(spacing, after: view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -insets).isActive = true
        }
        if let editing { window?.makeFirstResponder(editing) }
        fit()
    }

    /// Fits the window to its content, keeping the top edge in place.
    private func fit() {
        guard let window else { return }
        stack.layoutSubtreeIfNeeded()
        let titlebar = window.frame.height - window.contentLayoutRect.height
        let available = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
        let height = min(stack.fittingSize.height + titlebar, available - 40)
        var frame = window.frame
        frame.origin.y += frame.height - height
        frame.size = NSSize(width: Self.width, height: height)
        window.setFrame(frame, display: true)
    }

    // MARK: Sections

    private func sections() -> [(NSView, CGFloat)] {
        var out: [(NSView, CGFloat)] = [(header(), 20)]
        for notice in notices() { out.append((notice, 8)) }
        if out.count > 1 { out[out.count - 1].1 = 20 }

        if app.isPaired {
            out += titled("Sync Group", [workerRow(), groupRow(), pairingRow()])
            out += titled("Devices", deviceRows())
        } else {
            out += titled("Connect", [fieldRow("Worker URL", workerField), fieldRow("Access Key", accessKeyField)], spacingAfter: 10)
            out.append((connectFooter(), 22))
        }
        out += titled("Safari", [safariRow()])
        out += titled("General", [
            switchRow("Sync automatically", isOn: app.autoSync, action: #selector(toggleAutoSync)),
            switchRow("Open at login", isOn: app.launchAtLogin, action: #selector(toggleLogin)),
        ])
        out.append((footer(), 0))
        return out
    }

    private func titled(_ title: String, _ rows: [NSView], spacingAfter: CGFloat = 22) -> [(NSView, CGFloat)] {
        let heading = label(title, size: 13, weight: .semibold)
        let wrapper = NSView()
        heading.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(heading)
        NSLayoutConstraint.activate([
            heading.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 4),
            heading.topAnchor.constraint(equalTo: wrapper.topAnchor),
            heading.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
        ])
        return [(wrapper, 7), (group(rows), spacingAfter)]
    }

    private func header() -> NSView {
        // From the bundle's asset catalog: NSApp.applicationIconImage can be a
        // cached icon of an older install.
        let icon = NSImageView(image: NSImage(named: "AppIcon") ?? NSApp.applicationIconImage)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 58), icon.heightAnchor.constraint(equalToConstant: 58)])

        let (text, tint) = status()
        let indicator: NSView
        if app.isSyncing {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.startAnimation(nil)
            indicator = spinner
        } else {
            let dot = NSImageView(image: symbol("circle.fill", size: 7))
            dot.contentTintColor = tint
            indicator = dot
        }
        let statusLine = NSStackView(views: [indicator, label(text, size: 12, color: .secondaryLabelColor)])
        statusLine.spacing = 6
        statusLine.alignment = .centerY

        let titles = NSStackView(views: [label("Safari Bookmarks Sync", size: 18, weight: .semibold), statusLine])
        titles.orientation = .vertical
        titles.alignment = .leading
        titles.spacing = 3

        let row = NSStackView()
        row.alignment = .centerY
        row.spacing = 14
        row.setViews([icon, titles], in: .leading)
        if app.isPaired {
            let sync = button("Sync Now", #selector(syncNow))
            sync.isEnabled = app.isReady && !app.isSyncing
            row.setViews([sync], in: .trailing)
        }
        return row
    }

    private func status() -> (String, NSColor) {
        let state = app.state
        if !app.isPaired { return ("Not connected", .systemGray) }
        if !app.hasSafariAccess { return ("Needs access to Safari's bookmarks", .systemOrange) }
        if app.isSyncing { return ("Syncing…", .systemBlue) }
        if state.lastError != nil { return ("Sync failed", .systemRed) }
        guard let last = state.lastSyncAt else { return ("Not synced yet", .systemGray) }
        var text = "Synced \(relative.localizedString(for: last, relativeTo: Date()))"
        if let stats = state.lastStats { text += " · \(stats.accepted.formatted()) bookmarks" }
        return (text, state.deletionConfirmation == nil ? .systemGreen : .systemOrange)
    }

    private func notices() -> [NSView] {
        let state = app.state
        var out: [NSView] = []
        if let error = state.lastError {
            out.append(notice(error, symbol: "exclamationmark.triangle.fill", tint: .systemRed))
        }
        if let confirmation = state.deletionConfirmation {
            out.append(notice(
                "\(confirmation.count) bookmarks are gone from Safari. They are deleted elsewhere only after you confirm.",
                symbol: "trash.fill",
                tint: .systemOrange,
                action: button("Review…", #selector(reviewDeletions))
            ))
        }
        if state.waitingForSafariToQuit > 0 {
            let count = state.waitingForSafariToQuit
            out.append(notice(
                "\(count) \(count == 1 ? "change" : "changes") from other browsers will be applied when you quit Safari.",
                symbol: "clock.fill",
                tint: .secondaryLabelColor
            ))
        }
        return out
    }

    // MARK: Rows

    private func workerRow() -> NSView {
        let url = app.credentials?.workerURL
        return row("Worker", trailing: [value(url?.host ?? url?.absoluteString ?? "—")])
    }

    private func groupRow() -> NSView {
        row("Group ID", trailing: [value(String(app.credentials?.pairId.prefix(8) ?? "—"), mono: true)])
    }

    private func pairingRow() -> NSView {
        guard let code = app.pairingCode, code.expiresAt > Date() else {
            return row("Pairing Code", subtitle: "Adds Chrome or Firefox to this group.", trailing: [button("Create Code", #selector(newPairingCode))])
        }
        let codeLabel = label(code.code, size: 15, weight: .semibold, mono: true)
        codeLabel.isSelectable = true
        let copy = iconButton("doc.on.doc", tooltip: "Copy Code", #selector(copyCode))
        return row(
            "Pairing Code",
            subtitle: "Enter it in the Chrome or Firefox extension. Works once, until \(timeFormatter.string(from: code.expiresAt)).",
            trailing: [codeLabel, copy, button("New Code", #selector(newPairingCode))],
            textWidth: 230
        )
    }

    private func deviceRows() -> [NSView] {
        let devices = app.devices.sorted { a, b in
            if a.isSelf != b.isSelf { return a.isSelf }
            return (a.lastSeenAt ?? 0) > (b.lastSeenAt ?? 0)
        }
        guard !devices.isEmpty else { return [row("Loading devices…", titleColor: .secondaryLabelColor)] }
        return devices.map { device in
            let kind = device.platform == "safari" ? "Safari" : device.platform.capitalized
            let subtitle: String
            if device.isSelf {
                subtitle = "This Mac · \(kind)"
            } else if let seen = device.lastSeenAt {
                subtitle = "\(kind) · active \(relative.localizedString(for: Date(timeIntervalSince1970: seen / 1000), relativeTo: Date()))"
            } else {
                subtitle = kind
            }
            var trailing: [NSView] = []
            if !device.isSelf {
                let remove = button("Remove", #selector(removeDevice))
                remove.controlSize = .small
                remove.identifier = NSUserInterfaceItemIdentifier(device.id)
                trailing.append(remove)
            }
            return row(
                device.name ?? kind,
                subtitle: subtitle,
                icon: symbol(device.platform == "safari" ? "desktopcomputer" : "globe", size: 17),
                trailing: trailing
            )
        }
    }

    private func safariRow() -> NSView {
        guard app.hasSafariAccess else {
            let allow = button("Allow Access…", #selector(chooseSafariFolder))
            allow.bezelColor = .controlAccentColor
            return row("Bookmarks Access", subtitle: "macOS asks once before the app can read Safari's bookmarks.", trailing: [allow])
        }
        if app.file.grantIsFolder() {
            return row("Bookmarks Access", subtitle: "Allowed for the Safari folder.", trailing: [button("Change…", #selector(chooseSafariFolder))])
        }
        return row(
            "Bookmarks Access",
            subtitle: "Allowed for Bookmarks.plist only. Choose the Safari folder so changes can be saved safely.",
            trailing: [button("Choose Folder…", #selector(chooseSafariFolder))]
        )
    }

    private func connectFooter() -> NSView {
        let connect = button("Connect", #selector(connect))
        connect.keyEquivalent = "\r"
        let hint = label("Your access key comes from the Worker's admin page.", size: 11, color: .secondaryLabelColor)
        let row = NSStackView()
        row.alignment = .centerY
        row.edgeInsets = NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 0)
        row.setViews([hint], in: .leading)
        row.setViews([connect], in: .trailing)
        return row
    }

    private func footer() -> NSView {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let row = NSStackView()
        row.alignment = .centerY
        if app.isPaired { row.setViews([button("Leave Sync Group…", #selector(leaveGroup))], in: .leading) }
        row.setViews([label("Version \(version)", size: 11, color: .tertiaryLabelColor)], in: .trailing)
        return row
    }

    // MARK: Building blocks

    private func group(_ rows: [NSView]) -> NSView {
        let inner = NSStackView()
        inner.orientation = .vertical
        inner.alignment = .width
        inner.spacing = 0
        for (index, row) in rows.enumerated() {
            if index > 0 {
                let line = separator(inset: (row as? RowView)?.hasIcon == true ? 50 : 14)
                inner.addArrangedSubview(line)
                line.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true
            }
            inner.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true
        }
        return GroupView(content: inner)
    }

    private func row(
        _ title: String,
        subtitle: String? = nil,
        icon: NSImage? = nil,
        trailing: [NSView] = [],
        titleColor: NSColor = .labelColor,
        textWidth: CGFloat = SettingsWindowController.textWidth
    ) -> NSView {
        let titleLabel = label(title, size: 13, color: titleColor)
        var texts: [NSView] = [titleLabel]
        if let subtitle { texts.append(wrapping(subtitle, size: 11, color: .secondaryLabelColor, width: textWidth)) }
        let textStack = NSStackView(views: texts)
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 2

        var leading: [NSView] = []
        if let icon {
            let image = NSImageView(image: icon)
            image.contentTintColor = .secondaryLabelColor
            image.translatesAutoresizingMaskIntoConstraints = false
            image.widthAnchor.constraint(equalToConstant: 26).isActive = true
            leading.append(image)
        }
        leading.append(textStack)

        let row = RowView()
        row.hasIcon = icon != nil
        row.alignment = .centerY
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14)
        row.setViews(leading, in: .leading)
        row.setViews(trailing, in: .trailing)
        // The row grows with a wrapped description instead of clipping it.
        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 42),
            textStack.topAnchor.constraint(greaterThanOrEqualTo: row.topAnchor, constant: 9),
            row.bottomAnchor.constraint(greaterThanOrEqualTo: textStack.bottomAnchor, constant: 9),
        ])
        return row
    }

    private func fieldRow(_ title: String, _ field: NSTextField) -> NSView {
        row(title, trailing: [field])
    }

    private func switchRow(_ title: String, isOn: Bool, action: Selector) -> NSView {
        let toggle = NSSwitch()
        toggle.controlSize = .small
        toggle.state = isOn ? .on : .off
        toggle.target = self
        toggle.action = action
        return row(title, trailing: [toggle])
    }

    private func notice(_ text: String, symbol name: String, tint: NSColor, action: NSButton? = nil) -> NSView {
        let icon = NSImageView(image: symbol(name, size: 14))
        icon.contentTintColor = tint
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 20).isActive = true
        let message = wrapping(text, size: 12, color: .labelColor, width: action == nil ? 420 : 320)
        let row = NSStackView()
        row.alignment = .centerY
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        row.setViews([icon, message], in: .leading)
        if let action { row.setViews([action], in: .trailing) }
        NSLayoutConstraint.activate([
            message.topAnchor.constraint(greaterThanOrEqualTo: row.topAnchor, constant: 10),
            row.bottomAnchor.constraint(greaterThanOrEqualTo: message.bottomAnchor, constant: 10),
        ])
        return GroupView(content: row)
    }

    private func separator(inset: CGFloat) -> NSView {
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        let wrapper = NSView()
        wrapper.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: inset),
            line.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor),
            line.centerYAnchor.constraint(equalTo: wrapper.centerYAnchor),
            wrapper.heightAnchor.constraint(equalToConstant: 1),
        ])
        return wrapper
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor, mono: Bool = false) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = mono ? .monospacedSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        return field
    }

    private func wrapping(_ text: String, size: CGFloat, color: NSColor, width: CGFloat = SettingsWindowController.textWidth) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size)
        field.textColor = color
        field.preferredMaxLayoutWidth = width
        field.isSelectable = false
        return field
    }

    private func value(_ text: String, mono: Bool = false) -> NSTextField {
        let field = label(text, size: 13, color: .secondaryLabelColor, mono: mono)
        field.isSelectable = true
        return field
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }

    private func iconButton(_ name: String, tooltip: String, _ action: Selector) -> NSButton {
        let button = NSButton(image: symbol(name, size: 13), target: self, action: action)
        button.isBordered = false
        button.toolTip = tooltip
        button.contentTintColor = .secondaryLabelColor
        return button
    }

    private func symbol(_ name: String, size: CGFloat) -> NSImage {
        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) ?? NSImage()
        return image.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: .regular)) ?? image
    }

    // MARK: Actions

    private func perform(_ sender: NSControl, _ work: @escaping @MainActor () async throws -> Void) {
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
        alert.informativeText = "A sync group has one Mac for Safari. The other Mac stops syncing; its bookmarks stay as they are."
        alert.addButton(withTitle: "Use This Mac")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func syncNow(_ sender: NSButton) {
        Task { await app.syncNow() }
    }

    @objc private func reviewDeletions(_ sender: NSButton) {
        app.confirmPendingDeletions()
    }

    @objc private func newPairingCode(_ sender: NSButton) {
        perform(sender) { [app] in try await app.newPairingCode() }
    }

    @objc private func copyCode(_ sender: NSButton) {
        guard let code = app.pairingCode?.code else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        sender.image = symbol("checkmark", size: 13)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self, weak sender] in
            guard let self else { return }
            sender?.image = self.symbol("doc.on.doc", size: 13)
        }
    }

    @objc private func removeDevice(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let device = app.devices.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        alert.messageText = "Remove \(device.name ?? device.platform.capitalized) from the group?"
        alert.informativeText = "It stops syncing right away. Its bookmarks stay where they are."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform(sender) { [app] in try await app.removeDevice(id) }
    }

    @objc private func leaveGroup(_ sender: NSButton) {
        let alert = NSAlert()
        alert.messageText = "Remove this Mac from the sync group?"
        alert.informativeText = "Safari's bookmarks stay as they are. Chrome and Firefox keep syncing with each other until you connect this Mac again."
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
        panel.message = "Click Allow Access to let Safari Bookmarks Sync read and update Safari's bookmarks."
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

    @objc private func toggleAutoSync(_ sender: NSSwitch) {
        app.autoSync = sender.state == .on
    }

    @objc private func toggleLogin(_ sender: NSSwitch) {
        do {
            try app.setLaunchAtLogin(sender.state == .on)
        } catch {
            showError(error)
        }
        refresh()
    }
}

/// A row; remembers whether it starts with an icon so separators line up
/// with the text.
private final class RowView: NSStackView {
    var hasIcon = false
}

/// The rounded, slightly lighter box around a group of rows.
private final class GroupView: NSView {
    init(content: NSView) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        layer?.backgroundColor = (dark ? NSColor(white: 1, alpha: 0.05) : NSColor(white: 1, alpha: 0.72)).cgColor
        layer?.borderColor = (dark ? NSColor(white: 1, alpha: 0.09) : NSColor(white: 0, alpha: 0.07)).cgColor
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
