import AppKit
import BookmarksSyncCore

@MainActor
final class StatusMenuController: NSObject, NSMenuDelegate {
    private let app: AppController
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    init(app: AppController) {
        self.app = app
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        item.button?.toolTip = "Safari Bookmarks Sync"
        app.observe { [weak self] in self?.updateButton() }
        updateButton()
    }

    private var needsAttention: Bool {
        let state = app.state
        return !app.isReady || state.lastError != nil || state.deletionConfirmation != nil || !state.parkedImports.isEmpty
    }

    private func updateButton() {
        let symbol = app.isSyncing ? "arrow.triangle.2.circlepath" : needsAttention ? "exclamationmark.triangle" : "bookmark"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Safari Bookmarks Sync")
        image?.isTemplate = true
        item.button?.image = image
        let waiting = app.state.waitingForSafariToQuit
        item.button?.title = waiting > 0 ? " \(waiting)" : ""
        item.button?.imagePosition = .imageLeading
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = app.state

        menu.addItem(info(statusLine()))
        if let error = state.lastError {
            menu.addItem(info(error, color: .systemRed))
        }
        if state.waitingForSafariToQuit > 0 {
            menu.addItem(info("\(state.waitingForSafariToQuit) bookmark(s) will be added to Safari when you quit Safari"))
        }
        if let confirmation = state.deletionConfirmation {
            menu.addItem(action("Confirm Deleting \(confirmation.count) Bookmarks…", #selector(confirmDeletions)))
        }
        if !state.parkedImports.isEmpty {
            menu.addItem(info("\(state.parkedImports.count) added bookmark(s) were dropped by Safari"))
            menu.addItem(action("Add Them to Safari Again", #selector(retryParked)))
        }

        menu.addItem(.separator())
        let sync = action("Sync Now", #selector(syncNow), key: "s")
        sync.isEnabled = app.isReady && !app.isSyncing
        menu.addItem(sync)
        menu.addItem(action(app.isReady ? "Settings…" : "Set Up…", #selector(openSettings), key: ","))
        menu.addItem(.separator())
        menu.addItem(action("Quit Safari Bookmarks Sync", #selector(quit), key: "q"))
    }

    private func statusLine() -> String {
        if !app.isPaired { return "Not set up" }
        if !app.hasSafariAccess { return "Needs access to Safari's bookmarks" }
        if app.isSyncing { return "Syncing…" }
        guard let last = app.state.lastSyncAt else { return "Not synced yet" }
        return "Synced \(relative.localizedString(for: last, relativeTo: Date()))"
    }

    private func info(_ text: String, color: NSColor = .secondaryLabelColor) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.attributedTitle = NSAttributedString(string: text, attributes: [.foregroundColor: color, .font: NSFont.menuFont(ofSize: 0)])
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func syncNow() {
        Task { await app.syncNow() }
    }

    @objc private func openSettings() {
        app.showSettings()
    }

    @objc private func retryParked() {
        app.retryParkedImports()
    }

    @objc private func confirmDeletions() {
        guard let confirmation = app.state.deletionConfirmation else { return }
        NSApp.activate()
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Delete \(confirmation.count) bookmarks in your other browsers?"
        let examples = confirmation.sample.prefix(10).map { "• \($0)" }.joined(separator: "\n")
        alert.informativeText = """
            These bookmarks are no longer in Safari's bookmarks file. If you deleted them in Safari, \
            delete them everywhere. If Safari's bookmarks look wrong (for example after an iCloud problem), \
            cancel and check Safari first; nothing is deleted until you confirm.

            \(examples)
            """
        alert.addButton(withTitle: "Delete Everywhere")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await app.syncNow(confirmDeletions: true) }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
