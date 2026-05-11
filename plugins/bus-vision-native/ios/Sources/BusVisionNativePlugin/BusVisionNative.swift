import Foundation

@objc public class BusVisionNative: NSObject {
    @objc public func echo(_ value: String) -> String {
        print(value)
        return value
    }
}
