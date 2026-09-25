#if DEBUG
import AppKit

/// `-snapshot-settings` renders the settings window to a PNG in the app's
/// temporary folder, then quits: `-paired` (with `-notices` for the notice
/// rows) or the setup layout, `-dark` for dark mode. Used to check the layout
/// without screen recording permission.
@MainActor
enum DebugSnapshot {
    static func runIfRequested(_ app: AppController) -> Bool {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-snapshot-settings") else { return false }
        if args.contains("-dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
        if args.contains("-paired") { app.debugPreviewPaired() } else { app.debugPreviewUnpaired() }
        app.showSettings()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            guard let view = NSApp.windows.first(where: { $0.title == "Safari Bookmarks Sync" })?.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else { exit(1) }
            // The window background is drawn by the frame, not the content view.
            if let scroll = view as? NSScrollView {
                scroll.drawsBackground = true
                scroll.backgroundColor = .windowBackgroundColor
            }
            view.cacheDisplay(in: view.bounds, to: rep)
            let name = (args.contains("-paired") ? "settings-paired" : "settings") + (args.contains("-dark") ? "-dark" : "") + ".png"
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
            print(url.path)
            exit(0)
        }
        return true
    }
}
#endif
