//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Aurora on 2026/5/12.
//

import SafariServices
import os.log

private let sharedAppGroupIdentifier = "group.com.yourCompany.Safari-Bookmarks-Sync"
private let sharedSyncConfigKey = "sync_config"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        let response = NSExtensionItem()
        let responsePayload = handleMessage(message)
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: responsePayload ]
        } else {
            response.userInfo = [ "message": responsePayload ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    private func handleMessage(_ message: Any?) -> [String: Any] {
        guard let body = message as? [String: Any],
              let action = body["action"] as? String else {
            return ["ok": false, "error": "Invalid native message."]
        }

        switch action {
        case "getConfig":
            guard let defaults = UserDefaults(suiteName: sharedAppGroupIdentifier) else {
                return ["ok": false, "error": "Shared app group is unavailable."]
            }
            return [
                "ok": true,
                "config": defaults.dictionary(forKey: sharedSyncConfigKey) ?? [:]
            ]
        default:
            return ["ok": false, "error": "Unknown native action: \(action)"]
        }
    }

}
