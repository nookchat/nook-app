import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// The time iOS gives to finish work after the app is put away, or none.
    private var finishing: UIBackgroundTaskIdentifier = .invalid

    /// A video still being made smaller, or a file going up, keeps going for the time iOS gives,
    /// not stopped the moment the app is put away.
    func sceneDidEnterBackground(_ scene: UIScene) {
        guard finishing == .invalid else { return }
        finishing = UIApplication.shared.beginBackgroundTask(withName: "Finish sending") { [weak self] in
            self?.stopFinishing()
        }
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        stopFinishing()
    }

    private func stopFinishing() {
        guard finishing != .invalid else { return }
        UIApplication.shared.endBackgroundTask(finishing)
        finishing = .invalid
    }
}
