#if DEBUG
import AppKit

/// `-snapshot-settings` renders the settings window to settings.png (and, with
/// `-paired`, the paired layout) in the app's temporary folder, then quits.
/// Used to check the layout without screen recording permission.
@MainActor
enum DebugSnapshot {
    static func runIfRequested(_ app: AppController) -> Bool {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-snapshot-settings") else { return false }
        if args.contains("-paired") { app.debugPreviewPaired() }
        app.showSettings()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            guard let view = NSApp.windows.first(where: { $0.title == "Safari Bookmarks Sync" })?.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else { exit(1) }
            view.cacheDisplay(in: view.bounds, to: rep)
            let name = args.contains("-paired") ? "settings-paired.png" : "settings.png"
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
            print(url.path)
            exit(0)
        }
        return true
    }
}
#endif
