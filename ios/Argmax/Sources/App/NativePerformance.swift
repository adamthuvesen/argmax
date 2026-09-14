import Foundation
import OSLog

/// Intervals visible in Instruments in both Debug and Release builds.
enum NativePerformance {
    private static let log = OSLog(subsystem: "com.argmax.remote", category: .pointsOfInterest)

    static func measure<T>(_ name: StaticString, _ work: () throws -> T) rethrows -> T {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: name, signpostID: id)
        defer { os_signpost(.end, log: log, name: name, signpostID: id) }
        return try work()
    }
}
