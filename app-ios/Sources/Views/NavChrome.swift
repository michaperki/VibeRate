import SwiftUI
import UIKit

/// App-wide navigation chrome. iOS 26's default toolbar buttons are heavy glass circles
/// that dominate a content-first screen (the back chevron especially reads larger than the
/// title). We opt out of that treatment with a *custom* back button — a plain, lightly
/// tinted chevron with no filled-circle background — while keeping the full 44pt tap target
/// and, crucially, the interactive swipe-to-go-back gesture (which `navigationBarBackButtonHidden`
/// would otherwise kill). One reusable modifier so every pushed screen reads the same.
extension View {
    /// Replace the system back button with a quiet custom chevron. `action` pops the stack
    /// (pass `dismiss()`); `label` is the VoiceOver name for the control.
    func appBackButton(_ label: String = "Back", action: @escaping () -> Void) -> some View {
        self
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: action) {
                        // ~20pt glyph in a 44pt tappable frame: visible, not oversized,
                        // and no circular fill. `.plain` keeps iOS 26 from re-wrapping it
                        // in a glass capsule; the accent tint keeps the affordance.
                        Image(systemName: "chevron.backward")
                            .font(.system(size: 19, weight: .semibold))
                            .frame(width: 44, height: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel(label)
                }
            }
            .background(SwipeBackEnabler())
    }
}

/// A zero-size UIKit shim that re-enables the interactive pop (edge-swipe back) gesture after
/// we've hidden the system back button. Hiding that button detaches the navigation
/// controller's gesture delegate, so without this the swipe stops working. We reinstate a
/// delegate that only begins the swipe when there's actually something to pop — matching the
/// system's own behavior, so the root screen never freezes on a stray edge-swipe.
private struct SwipeBackEnabler: UIViewControllerRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIViewController {
        let vc = UIViewController()
        vc.view.backgroundColor = .clear
        context.coordinator.attach(from: vc)
        return vc
    }

    func updateUIViewController(_ vc: UIViewController, context: Context) {
        context.coordinator.attach(from: vc)
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private weak var nav: UINavigationController?

        func attach(from vc: UIViewController) {
            DispatchQueue.main.async { [weak self] in
                guard let self, let nav = vc.navigationController else { return }
                self.nav = nav
                nav.interactivePopGestureRecognizer?.delegate = self
                nav.interactivePopGestureRecognizer?.isEnabled = true
            }
        }

        // Only let the edge-swipe begin when there's a screen to go back to.
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            (nav?.viewControllers.count ?? 0) > 1
        }
    }
}
