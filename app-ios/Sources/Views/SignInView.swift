import SwiftUI

struct SignInView: View {
    @Environment(AuthModel.self) private var auth
    @State private var showToken = false
    @State private var tokenText = ""

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            VStack(spacing: 8) {
                Text("VibeRate")
                    .font(.system(size: 46, weight: .heavy))
                    .tracking(-1)
                    .foregroundStyle(Theme.brandGradient)
                Text("Drive your coding agents from your phone.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button { auth.signIn(provider: "github") } label: {
                    Label("Continue with GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                        .frame(maxWidth: .infinity)
                }
                Button { auth.signIn(provider: "google") } label: {
                    Label("Continue with Google", systemImage: "g.circle")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 32)

            if let err = auth.errorMessage {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            // Fallback path: paste an access token from the web app. Always works,
            // even if the social buttons misbehave on a device.
            VStack(spacing: 12) {
                if showToken {
                    SecureField("Paste your access token", text: $tokenText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    Button("Sign in with token") {
                        Task { await auth.signInWithToken(tokenText) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(tokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("Create one in the web app, then paste it here.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Button("Use an access token instead") { showToken = true }
                        .font(.footnote)
                }
            }
            .padding(.horizontal, 32)
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { Theme.ambient.ignoresSafeArea() }
    }
}
