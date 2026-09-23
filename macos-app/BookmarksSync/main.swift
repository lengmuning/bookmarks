import AppKit

// No storyboard: create the delegate explicitly. run() never returns, so the
// delegate stays alive.
MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
}
