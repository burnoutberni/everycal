// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "EveryCalMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "EveryCalMac", targets: ["EveryCalMac"])
    ],
    targets: [
        .executableTarget(
            name: "EveryCalMac",
            path: "Sources/EveryCalMac"
        )
    ]
)
