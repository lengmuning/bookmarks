#if DEBUG
import AppKit

/// `-snapshot-settings` renders each settings pane, toolbar included, to a PNG
/// in the app's temporary folder, then quits: `-paired` (with `-notices` for
/// the notice rows) or the setup layout, `-dark` for dark mode. Used to check
/// the layout without screen recording permission.
@MainActor
enum DebugSnapshot {
    static func runIfRequested(_ app: AppController) -> Bool {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-snapshot-settings") else { return false }
        if args.contains("-dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
        if args.contains("-paired") { app.debugPreviewPaired() } else { app.debugPreviewUnpaired() }
        app.showSettings()
        guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue == "settings" }),
              let controller = window.windowController as? SettingsWindowController
        else { exit(1) }
        let suffix = (args.contains("-paired") ? "-paired" : "") + (args.contains("-dark") ? "-dark" : "")
        render(SettingsWindowController.Pane.allCases, in: window, controller: controller, suffix: suffix)
        return true
    }

    private static func render(_ panes: [SettingsWindowController.Pane], in window: NSWindow, controller: SettingsWindowController, suffix: String) {
        guard let pane = panes.first else { exit(0) }
        controller.select(pane, animate: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            // The frame view draws the title bar and toolbar too.
            guard let view = window.contentView?.superview ?? window.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else { exit(1) }
            view.cacheDisplay(in: view.bounds, to: rep)
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("settings-\(pane.rawValue)\(suffix).png")
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
            print(url.path, Int(window.frame.height))
            render(Array(panes.dropFirst()), in: window, controller: controller, suffix: suffix)
        }
    }
}
#endif
