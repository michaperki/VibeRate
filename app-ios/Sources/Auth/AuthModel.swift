import Foundation
import Observation
import AuthenticationServices
import UIKit

/// Drives sign-in and holds the session. OAuth runs in an `ASWebAuthenticationSession`
/// (a real system browser, so Google doesn't block it the way it blocks embedded
/// webviews), and returns to the app via the `viberate://auth?code=…` deep link. We
/// exchange that one-time code for a bearer token and keep it in the Keychain.
@MainActor
@Observable
final class AuthModel: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum State {
        case loading
        case signedOut
        case signedIn(Me)
    }

    var state: State = .loading
    var errorMessage: String?

    private var webAuthSession: ASWebAuthenticationSession?

    /// On launch: if we have a token, validate it; otherwise show sign-in.
    func bootstrap() async {
        guard let token = TokenStore.load() else { state = .signedOut; return }
        do {
            state = .signedIn(try await APIClient(token: token).me())
        } catch {
            state = .signedOut
        }
    }

    func signIn(provider: String) {
        errorMessage = nil
        var comps = URLComponents(url: APIConfig.url("/auth/native/\(provider)/start"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "cb", value: APIConfig.callbackURL)]
        guard let startURL = comps.url else { return }

        let session = ASWebAuthenticationSession(url: startURL, callbackURLScheme: APIConfig.callbackScheme) { [weak self] callbackURL, error in
            guard let self else { return }
            if let error {
                if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                    self.errorMessage = error.localizedDescription
                }
                return
            }
            guard let callbackURL,
                  let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems else { return }
            if let serverError = items.first(where: { $0.name == "error" })?.value {
                self.errorMessage = serverError
                return
            }
            guard let code = items.first(where: { $0.name == "code" })?.value else { return }
            Task { await self.completeSignIn(code: code) }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webAuthSession = session
        session.start()
    }

    private func completeSignIn(code: String) async {
        do {
            let token = try await APIClient(token: nil).exchange(code: code)
            TokenStore.save(token)
            state = .signedIn(try await APIClient(token: token).me())
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Fallback sign-in: paste an account-linked access token (minted in the web app).
    /// Bypasses OAuth entirely — the same supported path the web/PWA build offers, and
    /// the guaranteed way in if the social buttons misbehave on a given device.
    func signInWithToken(_ raw: String) async {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        errorMessage = nil
        do {
            let me = try await APIClient(token: token).me()
            TokenStore.save(token)
            state = .signedIn(me)
        } catch {
            errorMessage = "That token didn't work: \(error.localizedDescription)"
        }
    }

    func signOut() {
        TokenStore.clear()
        state = .signedOut
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .first { $0.activationState == .foregroundActive } as? UIWindowScene
            return scene?.keyWindow ?? ASPresentationAnchor()
        }
    }
}
