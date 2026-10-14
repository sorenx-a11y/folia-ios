import UIKit
import Capacitor

// FoliaContainerViewController：把 Capacitor 的 WKWebView 桥接控制器作为子控制器嵌入，
// 并将 WebView 约束到 safeAreaLayoutGuide。Web 层零改动即可：
// - 内容不被 iPad 状态栏 / 主指示条遮挡；
// - 全屏、Split View 分屏、Slide Over 侧拉、Stage Manager 台前调度窗口尺寸变化、
//   设备旋转时，WebView 自动跟随安全区重新布局，页面通过 window resize 得到真实可用窗口。
class FoliaContainerViewController: UIViewController {
    private let bridgeViewController = CAPBridgeViewController()

    override func viewDidLoad() {
        super.viewDidLoad()
        // 与 Web 页首屏背景色 #09090b 保持一致，安全区之外的条带不会出现亮边。
        view.backgroundColor = UIColor(red: 9.0 / 255.0, green: 9.0 / 255.0, blue: 11.0 / 255.0, alpha: 1.0)

        addChild(bridgeViewController)
        let bridgeView = bridgeViewController.view!
        bridgeView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bridgeView)
        NSLayoutConstraint.activate([
            bridgeView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bridgeView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            bridgeView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            bridgeView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        bridgeViewController.didMove(toParent: self)
    }

    // 状态栏样式/可见性与 Home 指示条全部交给 Capacitor 桥接控制器决定
    // （样式由 Info.plist 的 UIStatusBarStyle=LightContent 提供，深色安全区条带上为浅色字；
    // iPhone 刘海/灵动岛机型同样适用）。后续接入 StatusBar 插件也能直接生效。
    override var childForStatusBarStyle: UIViewController? { bridgeViewController }
    override var childForStatusBarHidden: UIViewController? { bridgeViewController }
    override var childForHomeIndicatorAutoHidden: UIViewController? { bridgeViewController }

    // 方向：Capacitor 仅依据 Info.plist 的 iPhone 键构建掩码（竖屏 + 左右横屏），
    // iPad 直接转发会丢掉 Info.plist iPad 键里的倒置竖屏，故按设备分别返回。
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        if UIDevice.current.userInterfaceIdiom == .pad {
            return [.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight]
        }
        return bridgeViewController.supportedInterfaceOrientations
    }
    override var shouldAutorotate: Bool { bridgeViewController.shouldAutorotate }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = FoliaContainerViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
