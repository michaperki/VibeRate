import SwiftUI

@main
struct VibeRateApp: App {
    // Receive the push callbacks SwiftUI doesn't expose (device token, taps) and forward
    // them to PushManager.shared.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var auth = AuthModel()
    // Owns the signed-in nav stack's path, so a push tap can deep-link into a conversation.
    @State private var router = NavRouter()

    init() {
        // Theme the nav bar + title type before any view paints (2026-06-26 "fun" pass).
        configureGlobalAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootContainer()
                .environment(auth)
                .environment(router)
                // The app's identity is the dark, characterful dev-tool look — lock it so the
                // hued palette reads the same regardless of the phone's light/dark setting.
                .preferredColorScheme(.dark)
                .task { await auth.bootstrap() }
        }
    }
}

/// Wraps the root so a tapped "your agent needs you" notification can present the
/// selector as a sheet over whatever's on screen — independent of the navigation stack,
/// so it works from a cold launch or while buried deep in a conversation.
private struct RootContainer: View {
    @State private var push = PushManager.shared

    var body: some View {
        @Bindable var push = push
        RootView()
            .sheet(item: $push.pendingAsk) { ask in
                AskSheet(ask: ask) { push.pendingAsk = nil }
            }
    }
}
